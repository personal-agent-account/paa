import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@paa/adapter";

// PBI-0002 AC-13/14 + PBI-0007 AC-1〜7: marketplace install(= node_modules を持たない clone)から
// plugin launcher を起動し、runtime と同じ stdio transport で MCP を往復する。
//
// 「plugin details に MCP servers (1) と出る」は .mcp.json が parse できた証拠、
// 「本体の起動処理まで到達した」は import が解決できた証拠でしかない。runtime が実際に
// tool を呼べるかは別問題なので、依存 bootstrap → re-exec を通った実 process に対して
// initialize / tools/list / tools/call を投げて確かめる。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const LAUNCHER = "adapters/official/claude/mcp-server.ts";

/** 要件 §16 Runtime Access Contract の 8 tools(これ以外を生やさない。PBI-0031 で approval_get 追加) */
const CONTRACT_TOOLS = [
  "approval_get",
  "contacts_get",
  "contacts_list",
  "inbox_list",
  "inbox_read",
  "mark_read",
  "send",
  "whoami",
];

// stub Account。credential の token を検証する —— 固定値を返すだけだと
// 「子 process が credential を解決して Account まで到達した」証拠にならない
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (req.headers.get("authorization") !== "Bearer par_plugin") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (new URL(req.url).pathname === "/v1/whoami") {
      return Response.json({ agent_id: "agt_plugin", handle: "aya", unread: 3 });
    }
    return new Response("not found", { status: 404 });
  },
});

let clone = "";
let paaHome = "";

beforeAll(async () => {
  clone = await mkdtemp(join(tmpdir(), "paa-plugin-"));
  const rsync = Bun.spawn(
    ["rsync", "-a", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".gstack",
     "--exclude", "target", repoRoot, `${clone}/`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await rsync.exited).toBe(0);

  paaHome = await mkdtemp(join(tmpdir(), "paa-plugin-home-"));
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_plugin",
      token: "par_plugin",
      base_url: `http://localhost:${stub.port}`,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    { PAA_HOME: paaHome },
  );
}, 120_000);

afterAll(async () => {
  stub.stop(true);
  // node_modules ごと消すので既定の 5s では足りない
  await Promise.all([clone, paaHome].filter(Boolean).map((d) => rm(d, { recursive: true, force: true })));
}, 120_000);

/** runtime と同じ形(stdio 越しの MCP client)で launcher を起動する */
async function connect(env: Record<string, string>) {
  const chunks: string[] = [];
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(clone, LAUNCHER)],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  // stderr は start() 前から購読できる(bootstrap の出力を取り逃さない)
  transport.stderr?.on("data", (c: Buffer | string) => chunks.push(String(c)));
  const client = new Client({ name: "paa-launcher-test", version: "0.0.0" });
  // 依存 bootstrap(bun install)を挟むので既定の 60s では足りないことがある
  await client.connect(transport, { timeout: 300_000 });
  return { client, transport, stderr: () => chunks.join("") };
}

/** clone を指す process が残っていないこと(親が re-exec した子の取り残しを検出する) */
async function processesOnClone(): Promise<number> {
  const pgrep = Bun.spawn(["pgrep", "-f", clone], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(pgrep.stdout).text();
  await pgrep.exited;
  return out.split("\n").filter((l) => l.trim() !== "").length;
}

describe("plugin launcher の MCP 往復", () => {
  test("AC-1〜4,6: 依存 bootstrap と re-exec を通った実 process と往復できる", async () => {
    const session = await connect({ PAA_RUNTIME_KIND: "claude", PAA_HOME: paaHome });

    // AC-4: この起動が cold 経路(依存を自分で取りに行き、新 process で本体を起動した)であること。
    // これが無いと「warm 経路でしか往復できない」実装でも下の検査が通ってしまう
    expect(session.stderr()).toContain("bun install");
    expect(session.stderr()).not.toContain("Cannot find module");

    // AC-1: handshake が成立する(stdout に JSON-RPC 以外が混ざっていたらここで落ちる)
    expect(session.client.getServerVersion()?.name).toBe("paa-account");

    // AC-2: 要件 §16 の 8 tools が過不足なく並ぶ(memory.* / task.* 等を生やさない)
    const tools = (await session.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(CONTRACT_TOOLS);

    // AC-3: 子 process が credential を解決し Account API まで到達している
    const result = (await session.client.callTool({ name: "whoami", arguments: {} })) as any;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ handle: "aya", unread: 3 });

    // AC-6: client が閉じれば親も re-exec した子も残らない。
    // 生きている間に 1 件以上居ることを先に確かめる(0 件検査が空振りするのを防ぐ)
    expect(await processesOnClone()).toBeGreaterThan(0);
    await session.client.close();
    for (let i = 0; i < 50 && (await processesOnClone()) > 0; i++) {
      await Bun.sleep(100);
    }
    expect(await processesOnClone()).toBe(0);
  }, 300_000);

  test("AC-5: 2 回目は bootstrap 無しで同じ往復ができる", async () => {
    const session = await connect({ PAA_RUNTIME_KIND: "claude", PAA_HOME: paaHome });

    expect(session.stderr()).not.toContain("bun install");
    const result = (await session.client.callTool({ name: "whoami", arguments: {} })) as any;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ handle: "aya", unread: 3 });
    await session.client.close();
  }, 120_000);

  test("AC-7: credential が無ければ exit 1 で、stdout を汚さず対処を出す", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "paa-plugin-empty-"));
    const proc = Bun.spawn(["bun", join(clone, LAUNCHER)], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PAA_RUNTIME_KIND: "claude",
        PAA_HOME: emptyHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("PAA credential が見つかりません");
    expect(stderr).toContain("bun run paa install claude");
    // stdout は MCP の stdio transport 用。1 byte でも混ぜたら JSON-RPC が壊れる
    expect(stdout).toBe("");
    await rm(emptyHome, { recursive: true, force: true });
  }, 120_000);
});
