// MCP tool 出力の secret masking(EP-0013 W3 / PBI-0117・REQ-69)。
// triage session が通知本文を読むと、その中に credential が混ざることがある(転送ミス・
// リセットメール・webhook payload)。runtime の context に載った secret は session log にも
// 残るので、**MCP server が tool 応答を agent に見せる前に mask し**、send / reply で
// 外へ出す時にだけ復元する(placeholder のまま送ってもらう為)。
//
// 秘密の置き場所は `~/.paa/secrets.json`(mode 0600)。MCP server は起動時に 1 回だけ読み、
// 値を process env にも log にも出さない。**0600 以外の file は起動を拒否する**(fail-closed —
// 読める場所に平文を置く運用を黙って許すと mask の意味が無い)。
//
// format: どちらでも受ける(運用で迷いにくい方を許す)
//   { "SECRETS": ["sk-...", "ghp_..."] }        — 配列
//   { "SECRETS": { "OPENAI": "sk-...", ... } }  — object(値だけを採用する。key は mask しない)

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const secretsPath = (): string =>
  process.env.PAA_SECRETS_PATH ?? join(homedir(), ".paa", "secrets.json");

/** secrets.json を読む。無ければ空(mask 対象なし = 挙動は従来どおり)。壊れた JSON も空にせず
 * 投げる — 「半分だけ mask」より「mask 無しで起動させるか、直させてから起動」が安全側 */
export function loadSecrets(path: string = secretsPath()): string[] {
  if (!existsSync(path)) return [];
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${path} の permission が ${mode.toString(8)} です。secret を平文で置く file は所有者のみ読める 0600 である必要があります (chmod 600 ${path})`,
    );
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const values: string[] = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
    : raw !== null && typeof raw === "object"
      ? Object.values(raw).filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  // mask の割当(n)を file の書き順ではなく「長い順」に固定する。長い secret を先に置換しないと
  // 短い共通部分だけが置換されて残り(例: ghp_… の ghp)、値の prefix が漏れる
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** `⟨s:n⟩`。n は loadSecrets の返した並び(長い順)での index。restoreText と対で使う */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  secrets.forEach((secret, n) => {
    out = out.split(secret).join(`⟨s:${n}⟩`);
  });
  return out;
}

/** mask の逆変換。send / reply の text だけに適用する(応答面で復元すると mask が無意味になる) */
export function restoreText(text: string, secrets: string[]): string {
  return text.replace(/⟨s:(\d+)⟩/g, (whole, n: string) => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 0 && i < secrets.length ? secrets[i]! : whole;
  });
}

/** tool 応答全体を deep walk して **文字列の「値」だけ**を mask する(object の key は変えない —
 * key を変えると応答の shape が壊れて agent が parse できなくなる)。循環参照は JSON 応答に
 * なり得ない(API 応答 = JSON.parse 済み)ので考慮しない */
export function maskValue(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return maskText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskValue(v, secrets);
    return out;
  }
  return value;
}
