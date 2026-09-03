import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@paa/adapter";

// PBI-0046 AC-1〜5 / X2〜X3: `atn login` / `atn broker`。実 broker binary へは到達させず、
// `PAA_BROKER_BIN` に fake shell script を注入する(apps/cli/test/adopt.test.ts と同じ手法。
// EP-0001 LEARN 13)。自動 open(AC-3)は `process.stdout.isTTY` が pipe 経由の子プロセスでは
// 常に false になり test harness から正の検証ができないため、「非対話実行では発火しない」
// safety の固定に倒す(PBI-0046 の「未決の問い」参照)。
//
// AC-X1(別 actor)は既存契約(/v1/pair/approve の human_only)の再確認であり新規テストは
// 追加しない(PBI-0046 テスト設計に明記)。

const CLI = join(import.meta.dir, "../src/paa.ts");

type ClaimBody = { status: "approved"; token: string; runtime_id: string } | { __http: number };

let pairStartCalls = 0;
let claimMode: "approve" | "transient503" = "approve";
let approveCounter = 0;
const whoamiTokens = new Set<string>();

function claimResponse(): ClaimBody {
  if (claimMode === "transient503") return { __http: 503 };
  approveCounter++;
  const token = `par_login_${approveCounter}`;
  whoamiTokens.add(token);
  return { status: "approved", token, runtime_id: `rt_broker_${approveCounter}` };
}

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/pair/start") {
      pairStartCalls++;
      return Response.json(
        {
          device_code: "pdc_login_test",
          user_code: "LOGN2345",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          // interval:0 で backoff を無効化し、transient 系テストを高速化する
          expires_in: 60,
          interval: 0,
          verification_uri: "http://localhost:5173/",
          verification_uri_complete: "http://localhost:5173/?user_code=LOGN2345",
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/pair/claim") {
      const body = claimResponse();
      if ("__http" in body) return Response.json({ error: "unavailable" }, { status: body.__http });
      return Response.json(body);
    }
    if (url.pathname === "/v1/whoami") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (whoamiTokens.has(token)) {
        return Response.json({
          agent_id: "agt_x",
          handle: "aya",
          display_name: "Aya",
          unread: 0,
          actor: { kind: "runtime", runtime_id: "rt_broker" },
        });
      }
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE_URL = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

beforeEach(() => {
  pairStartCalls = 0;
  claimMode = "approve";
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "paa-login-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** fake broker binary。stdout に受け取った env を 1 行で吐いて即終了 or 常駐する */
function fakeBrokerScript(longLived: boolean): string {
  return `#!/bin/sh\necho "spawn pid=$$ token=$PAA_RUNTIME_TOKEN ws=$PAA_BROKER_WS_URL cli=$PAA_CLI"\n${
    longLived ? "sleep 5\n" : "exit 0\n"
  }`;
}

/**
 * fake launchctl。argv を 1 行ずつ log へ append し、サブコマンドごとに設定した exit code を返す。
 * 既定は全部失敗(list/load/unload = 1) —— PBI-0046 の既存 test(AC-1〜X3)は darwin 実機で走るため、
 * 既定で失敗させることで PBI-0048 の launchd 分岐を経由させず、常に detached fallback を通す
 * (既存 test の意味を変えない)。
 */
function fakeLaunchctlScript(codes: { list: number; load: number; unload: number }, logPath: string): string {
  return `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1" in
  list) exit ${codes.list} ;;
  load) exit ${codes.load} ;;
  unload) exit ${codes.unload} ;;
  *) exit 1 ;;
esac
`;
}

async function freshEnv(
  opts: {
    longLived?: boolean;
    launchctl?: { list: number; load: number; unload: number };
  } = {},
) {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  const brokerHome = join(dir, "broker-home");
  const launchAgentsDir = join(dir, "launch-agents");
  await mkdir(home, { recursive: true });
  await mkdir(brokerHome, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const bin = join(dir, "atn-broker-fake");
  await writeFile(bin, fakeBrokerScript(opts.longLived ?? false));
  await chmod(bin, 0o755);
  const openLog = join(dir, "open.log");
  const fakeOpenDir = join(dir, "fakebin");
  await mkdir(fakeOpenDir, { recursive: true });
  await writeFile(join(fakeOpenDir, "open"), `#!/bin/sh\necho "$@" >> "${openLog}"\n`);
  await chmod(join(fakeOpenDir, "open"), 0o755);
  const launchctlLog = join(dir, "launchctl.log");
  const launchctlBin = join(dir, "launchctl-fake");
  await writeFile(
    launchctlBin,
    fakeLaunchctlScript(opts.launchctl ?? { list: 1, load: 1, unload: 1 }, launchctlLog),
  );
  await chmod(launchctlBin, 0o755);
  return {
    home,
    brokerHome,
    brokerLog: join(brokerHome, "broker.log"),
    brokerPid: join(brokerHome, "broker.pid"),
    openLog,
    launchAgentsDir,
    plistPath: join(launchAgentsDir, "com.atn.broker.plist"),
    launchctlLog,
    env: {
      PATH: `${fakeOpenDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      PAA_HOME: home,
      PAA_BROKER_HOME: brokerHome,
      PAA_BROKER_BIN: bin,
      PAA_URL: BASE_URL,
      PAA_LAUNCH_AGENTS_DIR: launchAgentsDir,
      PAA_LAUNCHCTL: launchctlBin,
    } as Record<string, string>,
  };
}

async function paa(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/**
 * detached の broker(孫プロセス)は `login` 自身の exit より後にログを書き終える —— fork/exec の
 * 実時間分だけ遅れる。固定 sleep だとその幅を過小/過大に見積もるので、条件を満たすまで poll する。
 */
async function waitForContent(
  path: string,
  predicate: (s: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (predicate(content)) return content;
    if (Date.now() > deadline) return content;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("atn login / atn broker (PBI-0046)", () => {
  test("AC-1: credential 無しから pairing して broker を detached 起動する", async () => {
    const { env, home, brokerLog, brokerPid } = await freshEnv();
    const res = await paa(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("This machine is now connected to @aya");
    expect(res.out).toContain("appear under Your AI");

    const file = await readJson(join(home, "credentials.json"));
    expect(file.runtimes.broker).toMatchObject({ name: hostname(), base_url: BASE_URL });
    expect(file.runtimes.broker.token).toMatch(/^par_login_/);

    // pid file は `<pid> <起動時刻>`(PBI-0048 レビュー AC-X3 の修正)。fake broker は即 exit するので
    // 起動時刻が取れず pid だけの行になることもある —— 先頭が pid であることだけを固定する
    const pid = (await readFile(brokerPid, "utf8")).trim();
    expect(pid).toMatch(/^\d+(\s|$)/);

    const log = await waitForContent(brokerLog, (s) => s.includes("token=par_login_"));
    expect(log).toContain("token=par_login_");
    expect(log).toContain(`ws=${BASE_URL.replace(/^http/, "ws")}/v1/broker/ws`);
    // PAA_CLI の argv0 は process.execPath(bun 自体の絶対 path)。launchd の最小 PATH は
    // bare な "bun" を解決できないため(PBI-0048)
    expect(log).toContain(`cli=${process.execPath}:`);
    expect(log).toContain("paa.ts");
  }, 30_000);

  test("AC-2: 有効な credential があれば再 pairing しない", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_precreated";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_precreated",
        token,
        base_url: BASE_URL,
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { PAA_HOME: home },
    );
    const res = await paa(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("This machine is now connected to @aya");
    expect(pairStartCalls).toBe(0);
  }, 30_000);

  test("--url で別 server を明示したら、既存 credential を使い回さず再 pairing する", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_other_server";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_other_server",
        token,
        base_url: BASE_URL,
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { PAA_HOME: home },
    );
    // 接続不能な別 server を明示 —— 既存 credential(BASE_URL 向け)を無条件に使い回して
    // 「接続しました」を偽陽性で出さないことを固定する
    const res = await paa(["login", "--no-open", "--url", "http://127.0.0.1:1"], env);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain("now connected");
  }, 30_000);

  test("AC-4: binary が見つからない場合は build 案内で exit 1(credential は保持される)", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_ac4";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_ac4",
        token,
        base_url: BASE_URL,
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { PAA_HOME: home },
    );
    const res = await paa(["broker"], { ...env, PAA_BROKER_BIN: "/nonexistent/atn-broker-xyz" });
    expect(res.code).toBe(1);
    expect(res.err).toContain("cargo build --release --manifest-path broker/Cargo.toml");
    // credential は broker 起動失敗と無関係に保持され続ける
    const file = await readJson(join(home, "credentials.json"));
    expect(file.runtimes.broker.runtime_id).toBe("rt_broker_ac4");
  }, 30_000);

  test("AC-5: 既に broker が生きていれば二重起動しない", async () => {
    const { env, brokerLog } = await freshEnv({ longLived: true });
    const first = await paa(["login", "--no-open"], env);
    expect(first.code).toBe(0);

    const second = await paa(["login", "--no-open"], env);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already running");

    const log = await waitForContent(brokerLog, (s) => s.includes("spawn "));
    const spawnCount = log.split("\n").filter((l) => l.startsWith("spawn ")).length;
    expect(spawnCount).toBe(1);
  }, 30_000);

  test("非対話実行(このテスト harness)では自動 open が発火しない(--no-open 有無どちらでも)", async () => {
    const { env, openLog } = await freshEnv();
    await paa(["login", "--no-open"], env);
    await expect(readFile(openLog, "utf8")).rejects.toThrow();

    const { env: env2, openLog: openLog2 } = await freshEnv();
    await paa(["login"], env2);
    await expect(readFile(openLog2, "utf8")).rejects.toThrow();
  }, 30_000);

  test("AC-X2: server が一時的に不能なら transient retry 後に failed で exit 1(credential は書かれない)", async () => {
    const { env, home } = await freshEnv();
    claimMode = "transient503";
    const res = await paa(["login", "--no-open"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("NG pairing failed");
    const file = await readJson(join(home, "credentials.json")).catch(() => ({ runtimes: {} }));
    expect(file.runtimes.broker).toBeUndefined();
  }, 30_000);

  test("AC-X3: 2 本の login を同時実行しても credentials.json は壊れず broker は 1 本だけ生き残る", async () => {
    const { env, home, brokerLog } = await freshEnv({ longLived: true });
    const [a, b] = await Promise.all([
      paa(["login", "--no-open"], env),
      paa(["login", "--no-open"], env),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // 両方が同時に「credential 無し」を見て pairing に入る保証は timing 依存のため、
    // 「壊れずに収束する」ことだけを固定する(厳密に 2 回とは限らない)
    expect(pairStartCalls).toBeGreaterThanOrEqual(1);

    const file = await readJson(join(home, "credentials.json"));
    expect(file.runtimes.broker.token).toMatch(/^par_login_/);

    const log = await waitForContent(brokerLog, (s) => s.includes("spawn "));
    const spawnCount = log.split("\n").filter((l) => l.startsWith("spawn ")).length;
    expect(spawnCount).toBe(1);
  }, 30_000);

  test("broker: 未接続なら login を案内して失敗する", async () => {
    const { env } = await freshEnv();
    const res = await paa(["broker"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("atn login");
  }, 30_000);
});

// レビュー(有界)の攻撃 test(PBI-0046 review 2026-08-27)。レビュー時は `test.failing` で「今は破れている」を
// 固定し、実装ステージの修正(pairing.ts の startPairing / paa.ts の withStaleTakeoverLock)で `test` に戻した。
describe("PBI-0046 review: AC-X2 / AC-X3 攻撃", () => {
  test(
    "AC-X2 攻撃: pair/start 自体が不達(fetch reject)でも NG 表示で exit 1(生の stack trace を出さない)",
    async () => {
      const { env } = await freshEnv();
      env.PAA_URL = "http://127.0.0.1:9"; // 閉じている port → fetch が reject
      const res = await paa(["login", "--no-open"], env);
      expect(res.code).toBe(1);
      expect(res.err).toContain("NG pairing failed");
      expect(res.err).toContain("cannot connect to");
      expect(res.err).not.toContain("Unable to connect");
    },
    30_000,
  );

  test(
    "AC-X3 攻撃: 死んだ pid を指す stale pid file がある状態で login を 2 本同時に実行しても broker は 1 本だけ起動する(6 回反復)",
    async () => {
      // レビュー時の実測: lock 無しの readFile → rm → link では 20 回中 1 回、後発の rm が先発の link 済み
      // file を消して両方 spawn した。stale 再利用を withStaleTakeoverLock で直列化した後は 0 回であること
      const { env, brokerLog, brokerPid } = await freshEnv({ longLived: true });
      // 先に credential を作っておく(pairing の競合ではなく pid file の競合だけを見る)
      const first = await paa(["login", "--no-open"], env);
      expect(first.code).toBe(0);
      await waitForContent(brokerLog, (s) => s.includes("spawn "));
      for (let round = 0; round < 6; round++) {
        // 前回の broker(sleep 5 の fake)を殺し、死んだ pid + 本物の起動時刻の行 = stale file を作る
        const raw = await readFile(brokerPid, "utf8");
        const stalePid = Number(raw.trim().split(/\s+/)[0]);
        try {
          process.kill(stalePid, "SIGKILL");
        } catch {
          // 既に終了
        }
        await new Promise((r) => setTimeout(r, 50));
        await writeFile(brokerPid, raw);
        const before = (await readFile(brokerLog, "utf8")).split("\n").filter((l) => l.startsWith("spawn ")).length;
        const [a, b] = await Promise.all([paa(["login", "--no-open"], env), paa(["login", "--no-open"], env)]);
        expect(a.code).toBe(0);
        expect(b.code).toBe(0);
        const log = await waitForContent(
          brokerLog,
          (s) => s.split("\n").filter((l) => l.startsWith("spawn ")).length > before,
        );
        const after = log.split("\n").filter((l) => l.startsWith("spawn ")).length;
        expect(after - before).toBe(1);
      }
    },
    60_000,
  );
});

// ---- PBI-0046 再レビュー(有界)の攻撃 test(2026-08-28)。レビューセッションが追加 ----
describe("PBI-0046 再レビュー: AC-X3 攻撃", () => {
  test(
    "stale pid file 下で login を 3 本同時に実行しても broker は 1 本だけ起動する",
    async () => {
      // fix の lock 直列化は「待合者数に依存せず」成立するはず — 競合者を 2 本 → 3 本に増やしても
      // 二重 spawn は起きない(lock の mkdir mutex は先着 1 本に全員を順番待ちさせる)
      const { env, brokerLog, brokerPid } = await freshEnv({ longLived: true });
      const first = await paa(["login", "--no-open"], env);
      expect(first.code).toBe(0);
      await waitForContent(brokerLog, (s) => s.includes("spawn "));
      const raw = await readFile(brokerPid, "utf8");
      const stalePid = Number(raw.trim().split(/\s+/)[0]);
      try {
        process.kill(stalePid, "SIGKILL");
      } catch {
        // 既に終了
      }
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(brokerPid, raw);
      const before = (await readFile(brokerLog, "utf8")).split("\n").filter((l) => l.startsWith("spawn ")).length;
      const [a, b, c] = await Promise.all([
        paa(["login", "--no-open"], env),
        paa(["login", "--no-open"], env),
        paa(["login", "--no-open"], env),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(c.code).toBe(0);
      const log = await waitForContent(
        brokerLog,
        (s) => s.split("\n").filter((l) => l.startsWith("spawn ")).length > before,
      );
      const after = log.split("\n").filter((l) => l.startsWith("spawn ")).length;
      expect(after - before).toBe(1);
    },
    30_000,
  );
});
