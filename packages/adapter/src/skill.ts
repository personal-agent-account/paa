import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  AdapterError,
  type AdapterContext,
  type ExtensionApplyAction,
  type RuntimeAdapter,
} from "./contract.ts";

// kind = "skill" の materialize(W20 / PBI-0091 に claude から共通化。図 14 の正本はここ)。
// Agent Skills 仕様(Claude / Codex CLI 共通)の skill は「SKILL.md(frontmatter 必須)を含む
// directory」を skills/ の直下に置くだけで良いため、claude と codex の差は
// skillsDir(ctx) の決め方だけ(CLAUDE_CONFIG_DIR / CODEX_HOME)。
//   - claude: $CLAUDE_CONFIG_DIR/skills 〜 ~/.claude/skills
//   - codex : $CODEX_HOME/skills 〜 ~/.codex/skills
// (出典: https://community.openai.com/t/skills-for-codex-experimental-support-starting-today/1369367
//   https://learn.chatgpt.com/docs/build-skills)

/** base の真の子孙でない resolved は全て拒否する — resolved === base を許すと rel="."/""/"./"/
 * "foo/.." のいずれでも通ってしまい(path.resolve の標準挙動)、name 側の呼び出しでは
 * skillsDir 自体が「消してから作り直す」対象になって他の全 skill が消える
 * (PBI-0008 実装前レビューで発見。図 14)。 */
function safeJoin(base: string, rel: string): string {
  const resolved = resolve(base, rel);
  if (!resolved.startsWith(base + sep)) {
    throw new AdapterError(`skill 拡張の不正なパス: "${rel}"`, "skill ディレクトリの外を指しています");
  }
  return resolved;
}

/** PAA が作った skill ディレクトリだけに立つ sentinel。実測(2026-08-25, 実 claude CLI 2.1.243):
 * `~/.claude/skills/` には SKILL.md だけの人間の私物 skill が(このマシンで 48 件)実在し、
 * 名前は完全に自由(予約無し)。marker が無ければ「PAA が作ったのではない」と確実に判定できる
 * ので、install の上書きと disable/uninstall の削除の両方をこれで gate する
 * (図8 7段目「未管理を絶対に触らない」を skill kind でも守るための追加防御)。 */
const PAA_MANAGED_MARKER = ".paa-managed";

/** SKILL.md と marker は adapter が組み立てる物なので、spec.files から上書きさせない(PBI-0036)。
 * 判定は safeJoin 後の resolved path で行う — 生キーの文字列比較だと "./SKILL.md" や
 * "references/../SKILL.md" が素通りし、frontmatter を失った SKILL.md(= CLI に認識されない)を
 * 成功扱いで書いてしまう(AC-13 が description で守った不変条件の files 経路での抜け穴) */
const RESERVED_SKILL_FILES = ["SKILL.md", PAA_MANAGED_MARKER];

export type SkillsDirFn = (ctx: AdapterContext) => string;

async function applySkillExtension(
  ctx: AdapterContext,
  skillsDir: SkillsDirFn,
  name: string,
  spec: Record<string, unknown>,
): Promise<void> {
  // 1. 全パス(name 由来の skillDir 自体・files の全キー)を検証してから書き込みを始める
  //    (1 つでも不正なら 1 byte も書かない)
  // skill は skills/ の直下 1 階層にしか作らない(PBI-0036)。"foo/bar" は safeJoin を通って
  // しまうが、listExtensions は readdir の直下しか見ないので native listing と永久に
  // 噛み合わず(毎 sync で install が再実行される)、さらに marker を持たない中間ディレクトリ
  // skills/foo が残ることで、後から正当な skill "foo" を install する経路を AC-15 の
  // 衝突判定が永久に塞ぐ(API からの復旧手段が無い自傷ロックアウト)。
  // mcp の name は path join を経ないため、この制限は skill kind の中だけに閉じる
  const skillDir = safeJoin(skillsDir(ctx), name);
  if (/[/\\]/.test(name)) {
    throw new AdapterError(
      `skill 拡張 "${name}" の name にパス区切りは使えません`,
      "skill は skills/ の直下 1 階層にのみ作成します",
    );
  }
  const reservedPaths = new Set(RESERVED_SKILL_FILES.map((f) => join(skillDir, f)));
  const rawFiles = spec.files;
  if (rawFiles != null && (typeof rawFiles !== "object" || Array.isArray(rawFiles))) {
    throw new AdapterError(`skill 拡張 "${name}" の spec.files がオブジェクトではありません`);
  }
  const resolvedFiles: [string, string][] = [];
  for (const [rel, content] of Object.entries((rawFiles ?? {}) as Record<string, unknown>)) {
    const path = safeJoin(skillDir, rel);
    if (reservedPaths.has(path)) {
      throw new AdapterError(
        `skill 拡張 "${name}" の spec.files が予約ファイル "${rel}" を上書きしようとしています`,
        "SKILL.md は description/instructions から組み立て、.paa-managed は PAA が管理します",
      );
    }
    if (typeof content !== "string") {
      throw new AdapterError(`skill 拡張 "${name}" の spec.files["${rel}"] が文字列ではありません`);
    }
    resolvedFiles.push([path, content]);
  }
  // 2. spec.description / spec.instructions が string でなければ throw(何も書かない)
  if (typeof spec.description !== "string") {
    throw new AdapterError(`skill 拡張 "${name}" の spec.description が文字列ではありません`);
  }
  if (typeof spec.instructions !== "string") {
    throw new AdapterError(`skill 拡張 "${name}" の spec.instructions が文字列ではありません`);
  }
  // 既存の skillDir が有るのに PAA marker が無ければ、人間が別途作った private skill(名前が
  // たまたま衝突しただけ)である可能性が高い — 絶対に上書きしない(何も書かない)
  const existingMarker = await stat(join(skillDir, PAA_MANAGED_MARKER)).then(
    () => true,
    () => false,
  );
  const dirExists = await stat(skillDir).then(
    () => true,
    () => false,
  );
  if (dirExists && !existingMarker) {
    throw new AdapterError(
      `skill 拡張 "${name}" は PAA が作成していない既存ディレクトリと衝突しています`,
      `${skillDir} は PAA marker (${PAA_MANAGED_MARKER}) を持たないため上書きしません`,
    );
  }

  // 3. 既存の skillDir が有れば丸ごと削除してから再作成する(mcp の「消してから足す」冪等
  //    パターンと同じ理由 — 前 revision の files に有って今の revision に無いファイルの残留防止)
  await rm(skillDir, { recursive: true, force: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, PAA_MANAGED_MARKER), "");
  // 4. frontmatter は JSON.stringify で二重引用符 scalar 化する(YAML 1.2 は JSON 文字列を
  //    正当な flow scalar として受理するため、コロン・引用符・改行を含む値でも壊れない)
  const frontmatter = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(spec.description)}\n---\n`;
  await writeFile(join(skillDir, "SKILL.md"), frontmatter + spec.instructions);
  // 5. spec.files の各エントリを(親ディレクトリを mkdir -p して)書く
  for (const [path, content] of resolvedFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** skillDir が有り、かつ PAA marker を持つ時だけ削除(無ければ何もしない = 冪等)。marker が
 * 無いディレクトリは人間の私物 skill の可能性が高いので絶対に触らない(図8 7段目と同じ不変条件)。
 * 不正な name は skill として存在し得ない(install 時に同じ safeJoin で必ず弾かれているため、
 * ここでは黙って「無い」扱いにする)。 */
async function removeSkillIfPresent(ctx: AdapterContext, skillsDir: SkillsDirFn, name: string): Promise<void> {
  let skillDir: string;
  try {
    skillDir = safeJoin(skillsDir(ctx), name);
  } catch {
    return;
  }
  const isManaged = await stat(join(skillDir, PAA_MANAGED_MARKER)).then(
    () => true,
    () => false,
  );
  if (!isManaged) return;
  await rm(skillDir, { recursive: true, force: true });
}

/** MCP-config adapter(PBI-0060)の上に skill kind を足す。claude(PBI-0008 では直書き)と
 * codex(W20)の差は skillsDir だけ — この関数が図 14 の skill 分岐の実体。
 * extensionKinds は base に "skill" を追記し、listExtensions は mcp server 名に
 * skills/ 直下 directory を合算、applyExtension は skill を分岐して disable/uninstall は
 * 両経路(skill → mcp)を見る(kind を持たない action の既存規約)。 */
export function withSkills(base: RuntimeAdapter, skillsDir: SkillsDirFn): RuntimeAdapter {
  return {
    ...base,
    extensionKinds: [...base.extensionKinds.filter((k) => k !== "skill"), "skill"],
    async listExtensions(ctx) {
      // mcp server 名に加えて skills/ の直下ディレクトリも native の実在として数える
      const names = new Set((await base.listExtensions(ctx)).map((e) => e.name));
      try {
        for (const entry of await readdir(skillsDir(ctx), { withFileTypes: true })) {
          if (entry.isDirectory()) names.add(entry.name);
        }
      } catch {
        // skills/ が無ければ skill は 0 件(mcp のみ返す)
      }
      return [...names].map((name) => ({ name }));
    },
    async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
      if (action.action === "disable" || action.action === "uninstall") {
        // skill/mcp どちらか一方にしか存在し得ない(name は account 内で kind をまたいで一意)が、
        // disable/uninstall action は kind を持たないため両方を見て、有る方だけ消す
        await removeSkillIfPresent(ctx, skillsDir, action.name);
        return base.applyExtension(ctx, action);
      }
      if (action.kind === "skill") {
        await applySkillExtension(ctx, skillsDir, action.name, action.spec);
        return;
      }
      return base.applyExtension(ctx, action);
    },
  };
}
