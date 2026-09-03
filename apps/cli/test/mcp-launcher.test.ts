import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@paa/adapter";

// PBI-0132 AC-6〜9 / X1 / X2: plugin が起動する launcher(`adapters/official/*/atn-mcp`)の分岐。
//
// 静的な `.mcp.json` は「binary が在れば binary、無ければ bun」を分岐できないので sh を 1 枚挟む。
// ここで見るのは **実際に起動して何が exec されたか** —— 「binary を優先する」を文字列 grep で
// 確かめても、bun が呼ばれ続ける実装は緑のまま通ってしまう。
// 観測は fake の binary / bun が marker file に自分の argv と env を書く形(adopt.test.ts と同じ手)。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const LAUNCHER = join(repoRoot, "adapters/official/claude/atn-mcp");
const BUNDLE = join(repoRoot, "adapters/official/claude/mcp-server.bundle.js");
const BUILD = join(repoRoot, "scripts/build-binaries.sh");

let sandbox = "";
/** PATH の先頭に置く dir。ここに fake `bun` を置くかどうかで「bun が在る / 無い」を作る */
let fakeBin = "";
let marker = "";

/** 呼ばれたら `<label> <argv>` と env の一部を marker に足す偽 command */
async function putFake(path: string, label: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await writeFile(
    path,
    `#!/bin/sh\necho "${label} $*" >> ${marker}\necho "${label}.env PAA_RUNTIME_TOKEN=\${PAA_RUNTIME_TOKEN:-} PAA_RUNTIME_KIND=\${PAA_RUNTIME_KIND:-}" >> ${marker}\nexit 0\n`,
  );
  await chmod(path, 0o755);
}

async function runLauncher(
  env: Record<string, string>,
  { withBun = true, args = [BUNDLE] }: { withBun?: boolean; args?: string[] } = {},
) {
  await writeFile(marker, "");
  const proc = Bun.spawn([LAUNCHER, ...args], {
    // PATH は「fake だけ + 実 /usr/bin:/bin」。実 bun は ~/.bun/bin なので入らない
    env: {
      PATH: `${withBun ? fakeBin : join(sandbox, "empty")}:/usr/bin:/bin`,
      HOME: join(sandbox, "home"),
      // launcher の最後の枝は公開 Release から binary を取りに行く(PBI-0137)。
      // 誰も listen していない port に向けて **network に出さない** —— 向けないと
      // test が実物の 66MB を落として実 binary を exec してしまい、検査対象が変わる
      PAA_BINARY_BASE_URL: "http://127.0.0.1:1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, log: await readFile(marker, "utf8") };
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "paa-launcher-"));
  fakeBin = join(sandbox, "bin");
  marker = join(sandbox, "exec.log");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(sandbox, "empty"), { recursive: true });
  await mkdir(join(sandbox, "home"), { recursive: true });
  await putFake(join(fakeBin, "bun"), "bun");
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("plugin launcher の分岐 (PBI-0132)", () => {
  test("AC-6: binary が在れば binary を exec する(bun を呼ばない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    await putFake(join(home, "bin", "atn-mcp"), "binary");

    const res = await runLauncher({ PAA_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.log).toContain("binary ");
    expect(res.log).not.toContain("bun ");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-6: PAA_MCP_BINARY が PAA_HOME/bin より優先される", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    await putFake(join(home, "bin", "atn-mcp"), "binary");
    const explicit = join(sandbox, "explicit-mcp");
    await putFake(explicit, "explicit");

    const res = await runLauncher({ PAA_HOME: home, PAA_MCP_BINARY: explicit });
    expect(res.log).toContain("explicit ");
    expect(res.log).not.toContain("binary ");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-7: binary が無ければ bun <bundle> を exec する", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    const res = await runLauncher({ PAA_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.log).toContain(`bun ${BUNDLE}`);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-7 攻撃: 実行権の無い binary は「在る」と数えず bun に落ちる", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "atn-mcp"), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, "bin", "atn-mcp"), 0o644);

    const res = await runLauncher({ PAA_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.log).toContain(`bun ${BUNDLE}`);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-8: binary も bun も無ければ exit 1・stdout は汚さず stderr に対処を出す", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    const res = await runLauncher({ PAA_HOME: home }, { withBun: false });
    expect(res.exitCode).toBe(1);
    // MCP は stdio で JSON-RPC を流す面。1 byte でも混ぜたら handshake が壊れる
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("~/.atn/bin/atn-mcp");
    expect(res.stderr).toContain("bun.sh/install");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X1: env はそのまま透過し、launcher 自身は何も log しない", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    await putFake(join(home, "bin", "atn-mcp"), "binary");

    const res = await runLauncher({
      PAA_HOME: home,
      PAA_RUNTIME_KIND: "claude",
      PAA_RUNTIME_TOKEN: "par_secret_should_not_leak",
    });
    // 子 process には届く(exec なので env は継承される)
    expect(res.log).toContain("PAA_RUNTIME_TOKEN=par_secret_should_not_leak");
    expect(res.log).toContain("PAA_RUNTIME_KIND=claude");
    // launcher 自身は stdout / stderr に 1 byte も出さない(token を含む env を echo しない)
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X1: 起動できない時の案内にも env の値を混ぜない", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    const res = await runLauncher(
      { PAA_HOME: home, PAA_RUNTIME_TOKEN: "par_secret_should_not_leak" },
      { withBun: false },
    );
    expect(res.stderr).not.toContain("par_secret");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: binary が壊れていれば exec の失敗をそのまま伝える(bun に落ちない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    // 実行権はあるが exec できない(interpreter が無い)= download が壊れた時の形
    await writeFile(join(home, "bin", "atn-mcp"), "#!/nonexistent/interpreter\n");
    await chmod(join(home, "bin", "atn-mcp"), 0o755);

    const res = await runLauncher({ PAA_HOME: home });
    expect(res.exitCode).not.toBe(0);
    // 握り潰して bun に落ちると「壊れた binary を使い続けているのに動いて見える」
    expect(res.log).not.toContain("bun ");
    await rm(home, { recursive: true, force: true });
  }, 30_000);
});

describe("scripts/build-binaries.sh (PBI-0132 AC-9)", () => {
  test("--host-only で dist/atn-mcp と dist/paa ができ、どちらも実行可能", async () => {
    const out = await mkdtemp(join(tmpdir(), "paa-dist-"));
    const proc = Bun.spawn([BUILD, "--host-only", "--out", out], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect({ code: await proc.exited, stderr }).toMatchObject({ code: 0 });

    for (const name of ["atn-mcp", "paa"]) {
      const info = await stat(join(out, name));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o111).toBeGreaterThan(0);
    }
    await rm(out, { recursive: true, force: true });
  }, 180_000);

  test("攻撃: 作った binary が launcher 経由で実際に MCP を往復する(stdio が壊れていない)", async () => {
    // 「binary ができた」だけでは、compile 済み実行ファイルが stdio の JSON-RPC を
    // 壊していないことの証拠にならない —— 壊れていても AC-9 は緑のままになる。
    const out = await mkdtemp(join(tmpdir(), "paa-dist-live-"));
    const build = Bun.spawn([BUILD, "--host-only", "--out", out, "atn-mcp"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await build.exited).toBe(0);

    // 子が到達する stub Account(token を検証する = credential 解決まで通った証拠)
    const stub = Bun.serve({
      port: 0,
      fetch: (req) =>
        req.headers.get("authorization") !== "Bearer par_bin"
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : new URL(req.url).pathname === "/v1/whoami"
            ? Response.json({ agent_id: "agt_bin", handle: "aya", unread: 1 })
            : new Response("not found", { status: 404 }),
    });
    const home = await mkdtemp(join(tmpdir(), "paa-launcher-live-"));
    await saveCredential(
      "claude",
      {
        runtime_id: "rt_bin",
        token: "par_bin",
        base_url: `http://localhost:${stub.port}`,
        name: "MacBook / Claude Code",
        paired_at: new Date().toISOString(),
      },
      { PAA_HOME: home },
    );

    try {
      const proc = Bun.spawn([LAUNCHER, BUNDLE], {
        env: {
          // bun は PATH に置かない = 起きたのは必ず binary の方
          PATH: `${join(sandbox, "empty")}:/usr/bin:/bin`,
          HOME: join(sandbox, "home"),
          PAA_HOME: home,
          PAA_MCP_BINARY: join(out, "atn-mcp"),
          PAA_RUNTIME_KIND: "claude",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "paa-launcher-test", version: "0.0.0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await proc.stdin.end(); // EOF で server は終わる

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const replies = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: any });
      expect({ stderr, replies: replies.length }).toMatchObject({ replies: 2 });
      expect(replies.find((r) => r.id === 1)?.result?.serverInfo?.name).toBe("atn-account");
      expect(replies.find((r) => r.id === 2)?.result?.tools?.map((t: any) => t.name)).toContain(
        "whoami",
      );
    } finally {
      stub.stop(true);
      await rm(home, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
