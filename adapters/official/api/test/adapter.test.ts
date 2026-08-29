import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiAdapters, apiProviderAdapter } from "../src/index.ts";

// PBI-0070 / EP-0009 C: API provider の adapter は **native の設定を 1 つも書かない**。
// register/unregister が何かを書き始めたら、この runtime の設計(実体は paa agent)が壊れている。

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).length;
}

describe("API provider adapter (PBI-0070 AC-5)", () => {
  test("3 provider が factory 1 つから作られ、id は <provider>-api", () => {
    expect(apiAdapters.map((a) => a.id)).toEqual(["openai-api", "gemini-api", "anthropic-api"]);
    expect(apiAdapters.map((a) => a.displayName)).toEqual([
      "OpenAI (API)",
      "Gemini (API)",
      "Anthropic (API)",
    ]);
  });

  test("detect は常に installed(端末に binary を持たない)", async () => {
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const result = await adapter.detect({ env: { HOME: "/nonexistent" } });
    expect(result.installed).toBe(true);
  });

  test("register / unregister はファイルを 1 つも書かない", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-api-adapter-"));
    const ctx = { env: { HOME: home } };
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const before = await countFiles(home);
    await adapter.register(ctx, {
      serverEntry: "/x/mcp-server.ts",
      runtimeKind: "openai-api",
      baseUrl: "http://localhost:8787",
      serverName: "paa",
    });
    await adapter.unregister(ctx, "paa");
    expect(await countFiles(home)).toBe(before);
    expect(await adapter.listExtensions(ctx)).toEqual([]);
    expect(adapter.extensionKinds).toEqual([]);
  });

  test("doctor は credential の有無を返す(未接続 → ok:false)", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-api-doctor-"));
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const missing = await adapter.doctor({ env: { HOME: home, PAA_HOME: join(home, ".paa") } }, "paa");
    expect(missing[0]!.ok).toBe(false);

    await mkdir(join(home, ".paa"), { recursive: true });
    await writeFile(
      join(home, ".paa", "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          "openai-api": { runtime_id: "rt_1", token: "par_x", base_url: "http://localhost:8787", name: "OpenAI (API)" },
        },
      }),
    );
    const found = await adapter.doctor({ env: { HOME: home, PAA_HOME: join(home, ".paa") } }, "paa");
    expect(found[0]!.ok).toBe(true);
  });
});
