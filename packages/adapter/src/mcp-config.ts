import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paaHome } from "./credentials.ts";
import {
  run,
  type AdapterContext,
  type DetectResult,
  type ExtensionApplyAction,
  type ExtensionListing,
  type Finding,
  type RegisterInput,
  type RuntimeAdapter,
} from "./contract.ts";
import { STAGE0_CAPABILITIES } from "./contract.ts";

// generic MCP-config adapter(PBI-0060 / W9b)。
//
// MCP 対応 CLI の adapter は、外から見ると 5 op(register / unregister / doctor /
// listExtensions / applyExtension)の**構造が完全に同じ**で、違うのは
//   ① その CLI の config をどこからどう読むか(path / 形式 / server 一覧の key)
//   ② add / remove の argv をどう組むか
// の 2 点だけ —— claude と codex は実際にほぼ同じ 120 行を各々持っていた。3 つ目(Gemini CLI)を
// 足す前にここへ集約する(既存 2 つを載せ替えて既存 test が全部通ることが、機構が既存実装を
// 包含している証明。第 1 実例を待たずに機構を検証できる)。
//
// **argv を宣言でなく関数で受ける**のは意図的: `-s user` の要否・`-e` と `--env` の違い・
// name と command の順序・`--` の有無は CLI ごとにばらばらで、宣言でカバーしようとすると
// 設定項目の量産になる。config の読み方だけを宣言にし、argv は 3〜10 行の関数にするのが最小。

/** MCP server をどう起動するか。binary が在れば `{command: binary, args: []}`、無ければ `bun <entry>` */
export interface McpServerCommand {
  command: string;
  args: string[];
}

/** 実行可能な **file** か。dir は X_OK が立つので除く(`~/.paa/bin/paa-mcp` が dir でも exec できない) */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * MCP server の起動 command を解決する(PBI-0132)。
 * `PAA_MCP_BINARY` → `<PAA_HOME>/bin/paa-mcp` → `bun <entry>` の順で、**実際に実行できる物だけ**を
 * 採る —— 指定された path が無い / 実行権が無い時に黙って次へ落ちるのは、存在しない command を
 * runtime の config に書き込むと「登録は成功したのに起動だけ静かに失敗する」形になるため。
 *
 * bun は最後の fallback = 「開発者が使う道具」に降りる。binary が置かれている環境では bun を呼ばない。
 * plugin 側の同じ順序は `packages/mcp/paa-mcp`(sh launcher)が持つ —— 静的 JSON は分岐できないので、
 * **判定は 2 箇所にあるが順序は 1 つ**(検査で両方を固定する)。
 */
export function resolveMcpServerCommand(
  serverEntry: string,
  env: Record<string, string | undefined> = process.env,
): McpServerCommand {
  for (const candidate of [env.PAA_MCP_BINARY, join(paaHome(env), "bin", "paa-mcp")]) {
    if (candidate && isExecutableFile(candidate)) return { command: candidate, args: [] };
  }
  return { command: "bun", args: [serverEntry] };
}

/** `addArgs` に渡す材料。env は `[key, value]` の並び(CLI ごとに `-e K=V` / `--env K=V` に組む) */
export interface McpAddInput {
  name: string;
  env: [string, string][];
  command: string;
  args: string[];
}

export interface McpConfigSpec {
  id: string;
  displayName: string;
  /** CLI の実行ファイル名(bare で渡す。PATH 解決と補強は run() が行う — PBI-0050) */
  bin: string;
  /** detect が失敗した時に人へ出す 1 行(install 方法) */
  installHint: string;
  /** 既定 ["--version"] */
  versionArgs?: string[];
  /** config file の場所。env(CLAUDE_CONFIG_DIR / CODEX_HOME 等)を見て決める */
  configPath: (ctx: AdapterContext) => string;
  format: "json" | "toml";
  /** config 内で MCP server 一覧が入っている key("mcpServers" / "mcp_servers") */
  serversKey: string;
  addArgs: (input: McpAddInput) => string[];
  removeArgs: (name: string) => string[];
}

/**
 * config の MCP server 名一覧。**読めない / 壊れている時は空**を返す(= 「登録されていない」)。
 * ここで throw すると `paa doctor` が生の stack trace で落ちる —— doctor は「無い」と言って
 * install の案内に繋ぐのが仕事なので、config が無いことは失敗ではない。
 */
async function readServerNames(spec: McpConfigSpec, ctx: AdapterContext): Promise<string[]> {
  try {
    const text = await readFile(spec.configPath(ctx), "utf8");
    const parsed = (spec.format === "toml" ? Bun.TOML.parse(text) : JSON.parse(text)) as
      | Record<string, unknown>
      | null;
    const servers = parsed?.[spec.serversKey];
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/** MCP 対応 CLI の RuntimeAdapter を spec から生やす。skill 等の runtime 固有 op は呼び出し側で上書きする */
export function createMcpConfigAdapter(spec: McpConfigSpec): RuntimeAdapter {
  const cli = (args: string[]) => [spec.bin, ...args];

  /** 「消してから足す」— 再 install(upgrade)で重複しないための既存の手。remove の失敗は無視する
   * (対象が無いだけの場合と本当の失敗を CLI が同じ非ゼロ終了で返すため。add の成否で判定する) */
  const removeThenAdd = async (ctx: AdapterContext, input: McpAddInput): Promise<void> => {
    await run(ctx, cli(spec.removeArgs(input.name))).catch(() => null);
    const result = await run(ctx, cli(spec.addArgs(input)));
    if (!result.ok) {
      throw new Error(`${spec.bin} mcp add failed: ${result.stderr || result.stdout}`);
    }
  };

  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities: STAGE0_CAPABILITIES,

    async detect(ctx): Promise<DetectResult> {
      const version = await run(ctx, cli(spec.versionArgs ?? ["--version"])).catch(() => null);
      if (!version?.ok) return { installed: false, detail: spec.installHint };
      return { installed: true, detail: version.stdout.trim(), configPath: spec.configPath(ctx) };
    },

    async register(ctx, input: RegisterInput): Promise<void> {
      await removeThenAdd(ctx, {
        name: input.serverName,
        env: [
          ["PAA_RUNTIME_KIND", input.runtimeKind],
          ["PAA_URL", input.baseUrl],
        ],
        ...resolveMcpServerCommand(input.serverEntry, ctx.env),
      });
    },

    async unregister(ctx, serverName): Promise<void> {
      const result = await run(ctx, cli(spec.removeArgs(serverName)));
      if (!result.ok) {
        throw new Error(`${spec.bin} mcp remove failed: ${result.stderr || result.stdout}`);
      }
    },

    async doctor(ctx, serverName): Promise<Finding[]> {
      const path = spec.configPath(ctx);
      const registered = (await readServerNames(spec, ctx)).includes(serverName);
      return [
        {
          ok: registered,
          label: `${spec.displayName} の MCP 登録`,
          detail: registered
            ? `${path} に "${serverName}"`
            : `${path} に "${serverName}" がありません。'bun run paa install ${spec.id}' を実行してください`,
        },
      ];
    },

    extensionKinds: ["mcp"],

    async listExtensions(ctx): Promise<ExtensionListing[]> {
      return (await readServerNames(spec, ctx)).map((name) => ({ name }));
    },

    async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
      if (action.action === "disable" || action.action === "uninstall") {
        // 既に無い場合だけ成功扱い(冪等) —— 結果を見ずに握り潰すと config ロック等の
        // real failure まで成功になるので、先に native を読んで有無を見てから判定する
        if (!(await readServerNames(spec, ctx)).includes(action.name)) return;
        const result = await run(ctx, cli(spec.removeArgs(action.name)));
        if (!result.ok) {
          throw new Error(`${spec.bin} mcp remove failed: ${result.stderr || result.stdout}`);
        }
        return;
      }
      const s = action.spec as { command?: unknown; args?: unknown };
      if (typeof s.command !== "string") {
        throw new Error(`extension "${action.name}" の spec.command が文字列ではありません`);
      }
      await removeThenAdd(ctx, {
        name: action.name,
        env: Object.entries(action.env),
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
      });
    },
  };
}
