import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_ENTRY, run, type AdapterContext, type RuntimeAdapter } from "@paa/adapter";
import { claudeAdapter } from "@paa/adapter-claude";
import { codexAdapter } from "@paa/adapter-codex";

// AC-8 / AC-9: install / uninstall が runtime 側の設定を実際に書き換えること。
// 検査は必ず隔離環境(temp HOME / CODEX_HOME)で行う —— ユーザーの実 runtime 設定を
// test が書き換えてはいけない。実 CLI が無い環境では skip する。

async function cliExists(cmd: string): Promise<boolean> {
  const ctx: AdapterContext = { env: process.env };
  return (await run(ctx, [cmd, "--version"]).catch(() => null))?.ok === true;
}

async function isolated(extra: Record<string, string> = {}): Promise<AdapterContext> {
  const home = await mkdtemp(join(tmpdir(), "paa-home-"));
  // PAA_HOME も隔離する: binary が在れば register はそれを使う(PBI-0132)ので、
  // dev 機の ~/.paa/bin/paa-mcp の有無で結果が変わらないようにする
  return { env: { ...process.env, HOME: home, PAA_HOME: join(home, ".paa"), ...extra } };
}

/** ユーザー本物の設定が触られていないことを確かめる */
async function untouched(path: string, fn: () => Promise<void>): Promise<void> {
  const before = await stat(path).catch(() => null);
  await fn();
  const after = await stat(path).catch(() => null);
  expect(after?.mtimeMs).toBe(before?.mtimeMs);
}

const registerInput = (adapter: RuntimeAdapter) => ({
  serverEntry: MCP_SERVER_ENTRY,
  runtimeKind: adapter.id,
  baseUrl: "http://localhost:8787",
  serverName: "paa",
});

describe.skipIf(!(await cliExists("claude")))("claude adapter", () => {
  test("install で MCP server を登録し、uninstall で消す(実 config は触らない)", async () => {
    const ctx = await isolated();
    const configPath = join(ctx.env.HOME!, ".claude.json");
    const readServers = async () =>
      JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")).mcpServers ?? {};

    await untouched(join(homedir(), ".claude.json"), async () => {
      expect((await claudeAdapter.detect(ctx)).installed).toBe(true);

      await claudeAdapter.register(ctx, registerInput(claudeAdapter));
      const server = (await readServers()).paa;
      expect(server.command).toBe("bun"); // binary の無い環境では従来経路(PBI-0132 AC-3)
      expect(server.args).toEqual([MCP_SERVER_ENTRY]);
      expect(server.env.PAA_RUNTIME_KIND).toBe("claude");
      expect((await claudeAdapter.doctor(ctx, "paa"))[0]?.ok).toBe(true);

      // 再 install(upgrade)でも重複しない
      await claudeAdapter.register(ctx, registerInput(claudeAdapter));
      expect(Object.keys(await readServers())).toEqual(["paa"]);

      await claudeAdapter.unregister(ctx, "paa");
      expect((await readServers()).paa).toBeUndefined();
      expect((await claudeAdapter.doctor(ctx, "paa"))[0]?.ok).toBe(false);
    });
  }, 60_000);
});

describe.skipIf(!(await cliExists("codex")))("codex adapter", () => {
  test("install で [mcp_servers.paa] を書き、uninstall で消す(実 config は触らない)", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paa-codex-"));
    await writeFile(join(codexHome, "config.toml"), "");
    const ctx = await isolated({ CODEX_HOME: codexHome });
    const configPath = join(codexHome, "config.toml");

    await untouched(join(homedir(), ".codex", "config.toml"), async () => {
      expect((await codexAdapter.detect(ctx)).installed).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      const toml = await readFile(configPath, "utf8");
      expect(toml).toContain("[mcp_servers.paa]");
      expect(toml).toContain(MCP_SERVER_ENTRY);
      expect(toml).toContain('PAA_RUNTIME_KIND = "codex"');
      expect((await codexAdapter.doctor(ctx, "paa"))[0]?.ok).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      expect((await readFile(configPath, "utf8")).match(/\[mcp_servers\.paa\]/g)?.length).toBe(1);

      await codexAdapter.unregister(ctx, "paa");
      expect(await readFile(configPath, "utf8")).not.toContain("[mcp_servers.paa]");
      expect((await codexAdapter.doctor(ctx, "paa"))[0]?.ok).toBe(false);
    });
  }, 60_000);
});
