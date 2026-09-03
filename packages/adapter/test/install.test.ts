import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/credentials.ts";
import { installRuntime, doctorRuntime, uninstallRuntime } from "../src/install.ts";
import {
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type RegisterInput,
  type RuntimeAdapter,
} from "../src/contract.ts";

// AC-13: 診断(diagnostics)。credential が revoke 済み(401)なら「再 pair せよ」を出す。
// runtime CLI に依存せず engine の判定だけを見るため、fake adapter を使う。

let revoked = false;
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (revoked) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

const calls: string[] = [];
const registered: RegisterInput[] = [];
const fakeAdapter: RuntimeAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: STAGE0_CAPABILITIES,
  detect: async () => ({ installed: true, detail: "fake 1.0.0" }),
  register: async (_ctx, input) => {
    calls.push("register");
    registered.push(input);
  },
  unregister: async () => {
    calls.push("unregister");
  },
  doctor: async () => [{ ok: true, label: "MCP 登録", detail: "あり" }],
  extensionKinds: ["mcp"],
  listExtensions: async () => [],
  applyExtension: async () => {},
};
const ctx: AdapterContext = { env: {} };

async function envWithCredential() {
  // PAA_BINARY_BASE_URL は誰も listen していない port に向ける —— installRuntime は
  // binary(PBI-0137)を取りに行くので、指定しないと unit test が公開 Release を叩く
  const env = {
    PAA_HOME: await mkdtemp(join(tmpdir(), "paa-doctor-")),
    PAA_BINARY_BASE_URL: "http://127.0.0.1:1",
  };
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_1",
      token: "par_x",
      base_url: base,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    env,
  );
  return env;
}

describe("doctor", () => {
  test("未 pair なら pairing を促す", async () => {
    const env = { PAA_HOME: await mkdtemp(join(tmpdir(), "paa-doctor-")) };
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env });
    const credential = findings.find((f) => f.label === "credential")!;
    expect(credential.ok).toBe(false);
    expect(credential.detail).toContain("atn install claude");
  });

  test("credential が有効なら全て OK", async () => {
    revoked = false;
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env: await envWithCredential() });
    expect(findings.every((f) => f.ok)).toBe(true);
    expect(findings.map((f) => f.label)).toContain("Account connection");
  });

  test("revoke 済み credential は失効として検出し再 pair を促す(要件 §15.3)", async () => {
    revoked = true;
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env: await envWithCredential() });
    const connection = findings.find((f) => f.label === "Account connection")!;
    expect(connection.ok).toBe(false);
    expect(connection.detail).toContain("revoked");
    revoked = false;
  });
});

describe("uninstall", () => {
  test("MCP 登録とローカル credential の両方を落とす", async () => {
    const env = await envWithCredential();
    const outcome = await uninstallRuntime({ adapter: fakeAdapter, ctx, env });
    expect(outcome).toEqual({ unregistered: true, credentialRemoved: true });
    expect(calls).toContain("unregister");
    // 2 回目は credential が無い
    expect((await uninstallRuntime({ adapter: fakeAdapter, ctx, env })).credentialRemoved).toBe(false);
  });
});

// ---- PBI-0004 ----

// pairing まで応答する 2 台目。--url で「別の Account server」を指した状況を作る
const other = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pair/start") {
      return Response.json(
        {
          device_code: "pdc_other",
          user_code: "WXYZ6789",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          expires_in: 600,
          interval: 2,
          verification_uri: "http://localhost:5173/",
          verification_uri_complete: "http://localhost:5173/?user_code=WXYZ6789",
        },
        { status: 201 },
      );
    }
    if (path === "/v1/pair/claim") {
      return Response.json({ status: "approved", token: "par_other", runtime_id: "rt_other" });
    }
    return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
  },
});
const otherBase = `http://localhost:${other.port}`;
afterAll(() => other.stop(true));

const installOptions = (env: { PAA_HOME: string; PAA_BINARY_BASE_URL: string }, baseUrl: string) => ({
  adapter: fakeAdapter,
  ctx,
  env,
  baseUrl,
  onPrompt: () => {},
  sleep: async () => {},
  now: () => 0,
});

describe("install の base URL 解決", () => {
  test("AC-8: --url が既存 credential と違う server を指したら pair し直す", async () => {
    revoked = false;
    const env = await envWithCredential(); // base_url = stub(= 旧 server)
    const outcome = await installRuntime(installOptions(env, otherBase));

    expect(outcome.status).toBe("installed");
    expect(outcome.status === "installed" && outcome.paired).toBe(true);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(otherBase);
    // runtime に登録される URL も新 server でなければ意味がない
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });

  test("AC-16: --url / PAA_URL が無ければ既存 credential の server を尊重する", async () => {
    revoked = false;
    const env = await envWithCredential(); // base_url = stub(既定値 localhost:8787 ではない)
    // CLI は URL 未指定なら baseUrl を渡さない。ここで既定値に潰すと、リモートに
    // pair 済みの人が引数無しで install しただけで localhost へ張り替わる
    const outcome = await installRuntime({
      adapter: fakeAdapter,
      ctx,
      env,
      onPrompt: () => {},
      sleep: async () => {},
      now: () => 0,
    });
    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(base);
    expect(registered.at(-1)?.baseUrl).toBe(base);
  });

  test("AC-9: 同じ server なら有効な credential を再利用する(pair し直さない)", async () => {
    revoked = false;
    const env = await envWithCredential();
    await installRuntime(installOptions(env, otherBase)); // まず otherBase へ寄せる
    const outcome = await installRuntime(installOptions(env, otherBase));

    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(outcome.status === "installed" && outcome.credential.token).toBe("par_other");
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });
});

describe("uninstall の失敗理由", () => {
  test("AC-12: unregister の失敗を握り潰さず detail に載せる", async () => {
    const broken: RuntimeAdapter = {
      ...fakeAdapter,
      unregister: async () => {
        throw new Error("claude mcp remove failed: command not found");
      },
    };
    const env = await envWithCredential();
    const outcome = await uninstallRuntime({ adapter: broken, ctx, env });

    expect(outcome.unregistered).toBe(false);
    expect(outcome.detail).toContain("command not found");
    // credential 側は消えている(runtime CLI の故障に引きずられない)
    expect(outcome.credentialRemoved).toBe(true);
  });
});
