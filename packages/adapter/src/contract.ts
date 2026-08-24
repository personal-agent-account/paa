import type { ExtensionKind } from "@paa/core";

// Runtime Adapter Contract(配布戦略 §8)。
// 「Runtime ごとに Account pairing logic を再発明しない」(§7.2 Invariant)ため、
// runtime 固有なのは "その runtime へ MCP server をどう登録するか" だけに絞る。
// pairing / credential / 診断の本体は packages/adapter の engine 側にある。

/** 図 7 の adapter-contract ブロックと一致させる(diagrams-check.sh が検査) */
export const ADAPTER_OPS = [
  "id",
  "displayName",
  "capabilities",
  "detect",
  "register",
  "unregister",
  "doctor",
  "extensionKinds",
  "listExtensions",
  "applyExtension",
] as const;

export type AdapterOp = (typeof ADAPTER_OPS)[number];

/** 配布戦略 §8 の想定 contract に対する対応可否の宣言 */
export interface AdapterCapabilities {
  pair: boolean;
  status: boolean;
  notify: boolean;
  /** runtime への push(notify)と wake 系は Device Broker(要件 §21)が要る。Stage 0 は false */
  wake: boolean;
  createSession: boolean;
  sendInstruction: boolean;
}

export const STAGE0_CAPABILITIES: AdapterCapabilities = {
  pair: true,
  status: true,
  notify: false,
  wake: false,
  createSession: false,
  sendInstruction: false,
};

/** 子プロセス(runtime CLI)へ渡す環境。test は temp HOME / CODEX_HOME を注入する */
export interface AdapterContext {
  env: Record<string, string | undefined>;
}

export interface RegisterInput {
  /** MCP server の entry file(bun で起動する) */
  serverEntry: string;
  /** credential store 内の key。MCP server は PAA_RUNTIME_KIND でこれを選ぶ */
  runtimeKind: string;
  baseUrl: string;
  /** runtime 側に登録する MCP server 名 */
  serverName: string;
}

export interface DetectResult {
  /** runtime の CLI / 設定が見つかったか */
  installed: boolean;
  /** 見つからない時に人へ出す説明 */
  detail: string;
  /** 設定 file の場所(見つかった時) */
  configPath?: string;
}

export interface Finding {
  ok: boolean;
  label: string;
  detail: string;
}

/** listExtensions の結果。今のところ mcp のみなので kind は持たない(採用したら足す) */
export interface ExtensionListing {
  name: string;
}

export type ExtensionApplyAction =
  | {
      action: "install";
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      /** credential_ref をローカル解決した結果を含む、native へそのまま渡す env */
      env: Record<string, string>;
    }
  | {
      action: "update";
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      env: Record<string, string>;
    }
  | { action: "disable"; name: string }
  | { action: "uninstall"; name: string };

export interface RuntimeAdapter {
  /** credential store の key 兼 CLI 引数(例: "claude") */
  id: string;
  /** §32.4 Connected runtimes の表示名(例: "Claude Code") */
  displayName: string;
  capabilities: AdapterCapabilities;
  detect(ctx: AdapterContext): Promise<DetectResult>;
  register(ctx: AdapterContext, input: RegisterInput): Promise<void>;
  unregister(ctx: AdapterContext, serverName: string): Promise<void>;
  /** runtime 側の登録状態のみ見る。Account 側の診断は engine の doctorRuntime が行う */
  doctor(ctx: AdapterContext, serverName: string): Promise<Finding[]>;
  /** この runtime が materialize できる Extension kind(PBI-0005 では official 2 実装とも ["mcp"]) */
  extensionKinds: ExtensionKind[];
  /** native に実在する extension(今のところ mcp server のみ)の一覧 */
  listExtensions(ctx: AdapterContext): Promise<ExtensionListing[]>;
  /** install/update/disable/uninstall を native へ反映する。書式は runtime CLI に任せる */
  applyExtension(ctx: AdapterContext, action: ExtensionApplyAction): Promise<void>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

/** adapter 実装が runtime CLI を叩くための共通 helper */
export async function run(
  ctx: AdapterContext,
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}
