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

// Claude Code 用 official adapter。runtime 固有なのは「MCP server をどう登録するか」だけ。
// 登録は claude CLI に任せる(設定 file の書式は CLI 側の都合で変わるため直接書かない)。

// CLAUDE_CONFIG_DIR を設定すると claude CLI は .claude.json をその配下に読み書きする
// (実測確認済み — 未対応だと native state の listExtensions/doctor が嘘をつく)
const userConfigPath = (ctx: AdapterContext): string =>
  join(ctx.env.CLAUDE_CONFIG_DIR ?? ctx.env.HOME ?? homedir(), ".claude.json");

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

async function readMcpServers(path: string): Promise<Record<string, McpServerEntry>> {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    return config?.mcpServers ?? {};
  } catch {
    return {};
  }
}

export const claudeAdapter: RuntimeAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: STAGE0_CAPABILITIES,

  async detect(ctx): Promise<DetectResult> {
    const version = await run(ctx, ["claude", "--version"]).catch(() => null);
    if (!version?.ok) {
      return {
        installed: false,
        detail: "claude CLI が見つかりません (https://claude.com/claude-code)",
      };
    }
    return {
      installed: true,
      detail: version.stdout.trim(),
      configPath: userConfigPath(ctx),
    };
  },

  async register(ctx, input: RegisterInput): Promise<void> {
    // 再 install(upgrade)でも重複しないよう、消してから足す
    await run(ctx, ["claude", "mcp", "remove", "-s", "user", input.serverName]).catch(() => null);
    const result = await run(ctx, [
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      input.serverName,
      "-e",
      `PAA_RUNTIME_KIND=${input.runtimeKind}`,
      "-e",
      `PAA_URL=${input.baseUrl}`,
      "--",
      "bun",
      input.serverEntry,
    ]);
    if (!result.ok) {
      throw new Error(`claude mcp add failed: ${result.stderr || result.stdout}`);
    }
  },

  async unregister(ctx, serverName): Promise<void> {
    const result = await run(ctx, ["claude", "mcp", "remove", "-s", "user", serverName]);
    if (!result.ok) {
      throw new Error(`claude mcp remove failed: ${result.stderr || result.stdout}`);
    }
  },

  async doctor(ctx, serverName): Promise<Finding[]> {
    const path = userConfigPath(ctx);
    const server = (await readMcpServers(path))[serverName];
    return [
      server
        ? {
            ok: true,
            label: "Claude Code の MCP 登録",
            detail: `${path} に "${serverName}" (${server.command} ${(server.args ?? []).join(" ")})`,
          }
        : {
            ok: false,
            label: "Claude Code の MCP 登録",
            detail: `${path} に "${serverName}" がありません。'bun run paa install claude' を実行してください`,
          },
    ];
  },

  extensionKinds: ["mcp"],

  async listExtensions(ctx): Promise<ExtensionListing[]> {
    const servers = await readMcpServers(userConfigPath(ctx));
    return Object.keys(servers).map((name) => ({ name }));
  },

  async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
    if (action.action === "disable" || action.action === "uninstall") {
      // 既に無い場合だけ成功扱い(冪等) — 再 disable/uninstall で不要な失敗を出さない。
      // `claude mcp remove` は「対象が無い」場合も本当の失敗も同じ非ゼロ終了を返す
      // (実測確認済み)ので、先に native を読んで有無を見てから判定する。結果を見ずに
      // 握り潰すと、config ロック等の real failure まで成功扱いになってしまう
      const servers = await readMcpServers(userConfigPath(ctx));
      if (!(action.name in servers)) return;
      const result = await run(ctx, ["claude", "mcp", "remove", "-s", "user", action.name]);
      if (!result.ok) {
        throw new Error(`claude mcp remove failed: ${result.stderr || result.stdout}`);
      }
      return;
    }
    // install / update: 再登録でも重複しないよう、消してから足す(register() と同じ手)
    await run(ctx, ["claude", "mcp", "remove", "-s", "user", action.name]).catch(() => null);
    const envArgs = Object.entries(action.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const spec = action.spec as { command?: unknown; args?: unknown };
    if (typeof spec.command !== "string") {
      throw new Error(`extension "${action.name}" の spec.command が文字列ではありません`);
    }
    const specArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const result = await run(ctx, [
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      action.name,
      ...envArgs,
      "--",
      spec.command,
      ...specArgs,
    ]);
    if (!result.ok) {
      throw new Error(`claude mcp add failed: ${result.stderr || result.stdout}`);
    }
  },
};
