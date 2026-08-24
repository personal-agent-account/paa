import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  run,
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type DetectResult,
  type ExtensionApplyAction,
  type ExtensionListing,
  type Finding,
  type RegisterInput,
  type RuntimeAdapter,
} from "@paa/adapter";

// Codex 用 official adapter。登録先は $CODEX_HOME/config.toml の [mcp_servers.<name>]。
// 書式は codex CLI に任せる。

const configPath = (ctx: AdapterContext): string =>
  join(ctx.env.CODEX_HOME ?? join(ctx.env.HOME ?? homedir(), ".codex"), "config.toml");

export const codexAdapter: RuntimeAdapter = {
  id: "codex",
  displayName: "Codex",
  capabilities: STAGE0_CAPABILITIES,

  async detect(ctx): Promise<DetectResult> {
    const version = await run(ctx, ["codex", "--version"]).catch(() => null);
    if (!version?.ok) {
      return {
        installed: false,
        detail: "codex CLI が見つかりません (npm i -g @openai/codex)",
      };
    }
    return { installed: true, detail: version.stdout.trim(), configPath: configPath(ctx) };
  },

  async register(ctx, input: RegisterInput): Promise<void> {
    await run(ctx, ["codex", "mcp", "remove", input.serverName]).catch(() => null);
    const result = await run(ctx, [
      "codex",
      "mcp",
      "add",
      input.serverName,
      "--env",
      `PAA_RUNTIME_KIND=${input.runtimeKind}`,
      "--env",
      `PAA_URL=${input.baseUrl}`,
      "--",
      "bun",
      input.serverEntry,
    ]);
    if (!result.ok) {
      throw new Error(`codex mcp add failed: ${result.stderr || result.stdout}`);
    }
  },

  async unregister(ctx, serverName): Promise<void> {
    const result = await run(ctx, ["codex", "mcp", "remove", serverName]);
    if (!result.ok) {
      throw new Error(`codex mcp remove failed: ${result.stderr || result.stdout}`);
    }
  },

  async doctor(ctx, serverName): Promise<Finding[]> {
    const path = configPath(ctx);
    const registered = (await readMcpServerNames(path)).includes(serverName);
    return [
      {
        ok: registered,
        label: "Codex の MCP 登録",
        detail: registered
          ? `${path} に [mcp_servers.${serverName}]`
          : `${path} に [mcp_servers.${serverName}] がありません。'bun run paa install codex' を実行してください`,
      },
    ];
  },

  extensionKinds: ["mcp"],

  async listExtensions(ctx): Promise<ExtensionListing[]> {
    return (await readMcpServerNames(configPath(ctx))).map((name) => ({ name }));
  },

  async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
    if (action.action === "disable" || action.action === "uninstall") {
      // 既に無い場合だけ成功扱い(冪等) — 再 disable/uninstall で不要な失敗を出さない。
      // 結果を見ずに握り潰すと config ロック等の real failure まで成功扱いになるので、
      // 先に native を読んで有無を見てから判定する(claude adapter と同じ手)
      const names = await readMcpServerNames(configPath(ctx));
      if (!names.includes(action.name)) return;
      const result = await run(ctx, ["codex", "mcp", "remove", action.name]);
      if (!result.ok) {
        throw new Error(`codex mcp remove failed: ${result.stderr || result.stdout}`);
      }
      return;
    }
    // install / update: 再登録でも重複しないよう、消してから足す(register() と同じ手)
    await run(ctx, ["codex", "mcp", "remove", action.name]).catch(() => null);
    const envArgs = Object.entries(action.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const spec = action.spec as { command?: unknown; args?: unknown };
    if (typeof spec.command !== "string") {
      throw new Error(`extension "${action.name}" の spec.command が文字列ではありません`);
    }
    const specArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const result = await run(ctx, [
      "codex",
      "mcp",
      "add",
      action.name,
      ...envArgs,
      "--",
      spec.command,
      ...specArgs,
    ]);
    if (!result.ok) {
      throw new Error(`codex mcp add failed: ${result.stderr || result.stdout}`);
    }
  },
};

/** TOML 全体を parse して mcp_servers テーブルの key を返す(sub-table の入れ子に regex より頑丈) */
async function readMcpServerNames(path: string): Promise<string[]> {
  try {
    const toml = Bun.TOML.parse(await readFile(path, "utf8")) as {
      mcp_servers?: Record<string, unknown>;
    };
    return Object.keys(toml.mcp_servers ?? {});
  } catch {
    return [];
  }
}
