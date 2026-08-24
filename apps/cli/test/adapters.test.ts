import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ADAPTERS, findAdapter, SUPPORTED_IDS } from "../src/registry.ts";
import { ADAPTER_OPS } from "@paa/adapter";

// AC-14 / AC-15 / AC-16: Runtime Adapter Contract(配布戦略 §8)の conformance。
// community adapter が増えてもこの検査に通ることを条件にする。

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe("runtime adapter contract", () => {
  test("official adapter が contract op を全て備える", () => {
    for (const adapter of ADAPTERS) {
      for (const op of ADAPTER_OPS) {
        expect(adapter[op as keyof typeof adapter]).toBeDefined();
      }
      expect(typeof adapter.id).toBe("string");
      expect(typeof adapter.displayName).toBe("string");
      for (const fn of ["detect", "register", "unregister", "doctor"] as const) {
        expect(typeof adapter[fn]).toBe("function");
      }
    }
  });

  test("Stage 0 では wake 系 capability を宣言しない(Device Broker 不在)", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.capabilities).toMatchObject({
        pair: true,
        status: true,
        notify: false,
        wake: false,
        createSession: false,
        sendInstruction: false,
      });
    }
  });

  test("id は一意で、未対応 runtime は解決できない", () => {
    expect(new Set(SUPPORTED_IDS).size).toBe(SUPPORTED_IDS.length);
    expect(SUPPORTED_IDS).toEqual(["claude", "codex"]);
    expect(findAdapter("CLAUDE")?.id).toBe("claude");
    expect(findAdapter("hermes")).toBeUndefined();
  });
});

describe("plugin 配布物(配布戦略 §7.1 plugin-first)", () => {
  test("plugin manifest と .mcp.json が妥当で、起動 file が実在する", async () => {
    const dir = "adapters/official/claude";
    const plugin = JSON.parse(await readFile(repo(`${dir}/.claude-plugin/plugin.json`), "utf8"));
    expect(plugin.name).toBe("paa");
    expect(typeof plugin.description).toBe("string");

    const mcp = JSON.parse(await readFile(repo(`${dir}/.mcp.json`), "utf8"));
    const server = mcp.mcpServers.paa;
    expect(server.command).toBe("bun");
    expect(server.args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(server.env.PAA_RUNTIME_KIND).toBe("claude");

    const entry = server.args[0].replace("${CLAUDE_PLUGIN_ROOT}", repo(dir));
    expect((await stat(entry)).isFile()).toBe(true);
  });

  test("marketplace が plugin の実在する source を指す", async () => {
    const marketplace = JSON.parse(await readFile(repo(".claude-plugin/marketplace.json"), "utf8"));
    expect(marketplace.name).toBe("paa");
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const entry of marketplace.plugins) {
      const manifest = repo(`${entry.source}/.claude-plugin/plugin.json`.replace("./", ""));
      expect((await stat(manifest)).isFile()).toBe(true);
    }
  });
});
