import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { apiCall } from "./api.ts";
import {
  getCredential,
  removeCredential,
  type RuntimeCredential,
} from "./credentials.ts";
import { pairRuntime, type PairPrompt } from "./pairing.ts";
import type { AdapterContext, Finding, RuntimeAdapter } from "./contract.ts";

// Common Installation Engine(配布戦略 §7.2)。
// UX は plugin-first でも、pairing / config detection / credential registration /
// upgrade / uninstall / diagnostics はここ 1 箇所に集約する。

/** runtime へ登録する MCP server の entry。repo checkout を bun で起動する */
export const MCP_SERVER_ENTRY = fileURLToPath(
  new URL("../../mcp/src/server.ts", import.meta.url),
);

/** runtime 側の設定に載る MCP server 名 */
export const MCP_SERVER_NAME = "paa";

export const DEFAULT_BASE_URL = "http://localhost:8787";

type Env = Record<string, string | undefined>;

export interface EngineOptions {
  adapter: RuntimeAdapter;
  ctx: AdapterContext;
  baseUrl?: string;
  /** credential store 用の環境(PAA_HOME)。既定は process.env */
  env?: Env;
  serverEntry?: string;
  serverName?: string;
}

export interface InstallOptions extends EngineOptions {
  onPrompt: (prompt: PairPrompt) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 既存 credential が有効でも pair し直す */
  repair?: boolean;
  hostLabel?: string;
}

export type InstallOutcome =
  | { status: "installed"; credential: RuntimeCredential; paired: boolean; findings: Finding[] }
  | { status: "runtime_not_found"; detail: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "failed"; detail: string };

export async function installRuntime(options: InstallOptions): Promise<InstallOutcome> {
  const { adapter, ctx } = options;
  const env = options.env ?? process.env;
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  // 「明示的に指定された URL」だけを再 pair の根拠にする。既定値との比較で判断すると、
  // リモートに pair 済みの人が引数無しで install した時に localhost へ張り替えてしまう
  const requestedUrl = options.baseUrl?.replace(/\/$/, "");

  const detected = await adapter.detect(ctx);
  if (!detected.installed) return { status: "runtime_not_found", detail: detected.detail };

  // upgrade 経路: 既に有効な credential があれば pair し直さない(§7.2 upgrade)。
  // ただし --url / PAA_URL で別 server を指した場合は再利用できない —— そのまま進むと
  // 旧 server の token と URL が runtime に登録され、「接続しました」の表示だけが嘘になる
  let credential = await getCredential(adapter.id, env);
  let paired = false;
  const urlChanged =
    credential != null && requestedUrl != null && credential.base_url !== requestedUrl;
  // URL 未指定なら既存 credential の server を引き継ぐ
  const baseUrl = requestedUrl ?? credential?.base_url ?? DEFAULT_BASE_URL;
  if (options.repair || !credential || urlChanged || !(await isCredentialValid(credential))) {
    const outcome = await pairRuntime({
      baseUrl,
      kind: adapter.id,
      name: `${options.hostLabel ?? hostname()} / ${adapter.displayName}`,
      onPrompt: options.onPrompt,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.now ? { now: options.now } : {}),
      env,
    });
    if (outcome.status !== "paired") return outcome;
    credential = outcome.credential;
    paired = true;
  }

  await adapter.register(ctx, {
    serverEntry: options.serverEntry ?? MCP_SERVER_ENTRY,
    runtimeKind: adapter.id,
    baseUrl: credential.base_url,
    serverName,
  });

  return {
    status: "installed",
    credential,
    paired,
    findings: await doctorRuntime({ ...options, serverName }),
  };
}

export interface UninstallOutcome {
  unregistered: boolean;
  credentialRemoved: boolean;
  /** unregister が失敗した理由。CLI はこれを出す(握り潰すと「未登録」と区別が付かない) */
  detail?: string;
}

export async function uninstallRuntime(options: EngineOptions): Promise<UninstallOutcome> {
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  let unregistered = true;
  let detail: string | undefined;
  try {
    await options.adapter.unregister(options.ctx, serverName);
  } catch (e) {
    // runtime CLI が壊れている / PATH に無い場合と「元々未登録」を混ぜない
    unregistered = false;
    detail = (e as Error).message;
  }
  // Cloud 側の credential 失効(revoke)は human session が要るので web/settings 側の操作。
  // ここで消すのはローカル保管分のみ。
  const credentialRemoved = await removeCredential(
    options.adapter.id,
    options.env ?? process.env,
  );
  return detail === undefined
    ? { unregistered, credentialRemoved }
    : { unregistered, credentialRemoved, detail };
}

export async function doctorRuntime(options: EngineOptions): Promise<Finding[]> {
  const { adapter, ctx } = options;
  const env = options.env ?? process.env;
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  const findings: Finding[] = [];

  const detected = await adapter.detect(ctx);
  findings.push({
    ok: detected.installed,
    label: `${adapter.displayName} を検出`,
    detail: detected.detail,
  });

  const credential = await getCredential(adapter.id, env);
  if (!credential) {
    findings.push({
      ok: false,
      label: "credential",
      detail: `未 pair。'bun run paa install ${adapter.id}' を実行してください`,
    });
    return findings;
  }
  findings.push({
    ok: true,
    label: "credential",
    detail: `${credential.name} (${credential.runtime_id}) → ${credential.base_url}`,
  });

  const who = await apiCall(credential.base_url, "/v1/whoami", { token: credential.token });
  findings.push(
    who.status === 200
      ? {
          ok: true,
          label: "Account 接続",
          detail: `@${who.body.handle} として attach 済み (unread ${who.body.unread})`,
        }
      : {
          ok: false,
          label: "Account 接続",
          detail:
            who.status === 401
              ? `credential が失効しています(revoke 済み)。'bun run paa install ${adapter.id}' で再接続してください`
              : `whoami が ${who.status} を返しました`,
        },
  );

  findings.push(...(await adapter.doctor(ctx, serverName)));
  findings.push(await extensionDriftFinding(credential.base_url, credential.token, credential.runtime_id));
  return findings;
}

/**
 * extension sync の drift(failed / revision 未追随)を 1 finding にまとめる。
 * fetch 失敗(旧 server・一時的ネットワーク断)や extension が 0 件の場合は ok:true にする ——
 * ここを false にすると 'paa install' の成否が Extension Sync という無関係な機能に
 * 引きずられて exit code 1 になってしまう
 */
async function extensionDriftFinding(
  baseUrl: string,
  token: string,
  runtimeId: string,
): Promise<Finding> {
  const res = await apiCall(baseUrl, "/v1/extensions", { token }).catch(() => null);
  if (!res || res.status !== 200 || !Array.isArray(res.body)) {
    return { ok: true, label: "Extensions", detail: "確認できませんでした(server 未対応の可能性)" };
  }
  let failed = 0;
  let behind = 0;
  for (const ext of res.body as any[]) {
    const mat = ext.materializations?.find((m: any) => m.runtime_id === runtimeId);
    if (!mat) continue;
    if (mat.status === "failed") failed++;
    else if (
      ext.enabled &&
      ext.deleted_at == null &&
      typeof mat.applied_revision === "number" &&
      mat.applied_revision < ext.revision
    ) {
      behind++;
    }
  }
  return {
    ok: failed === 0 && behind === 0,
    label: "Extensions",
    detail: `failed ${failed} / 未追随 ${behind}`,
  };
}

async function isCredentialValid(credential: RuntimeCredential): Promise<boolean> {
  try {
    const who = await apiCall(credential.base_url, "/v1/whoami", { token: credential.token });
    return who.status === 200;
  } catch {
    return false;
  }
}
