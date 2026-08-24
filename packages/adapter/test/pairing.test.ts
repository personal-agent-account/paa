import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential } from "../src/credentials.ts";
import { pairRuntime } from "../src/pairing.ts";

// AC-6 / AC-7(PBI-0002): device code flow(図 6)。interval を尊重して polling し、
// approved なら credential を書いてから成功を返す。denied / expired を成功にしない。
//
// AC-4〜7(PBI-0004): 人が承認画面を操作している 10 分の間に起きる一過性の失敗で
// pairing を畳まない。畳む時も "expired" を騙らない。

type HttpStep = { __http: number; __body?: unknown };
type ClaimStep = Record<string, unknown> | HttpStep;

/** script の 1 手が「HTTP status を指定した応答」かどうか */
const isHttpStep = (step: ClaimStep): step is HttpStep =>
  typeof (step as HttpStep).__http === "number";

let claims = 0;
let script: ClaimStep[] = [];
const START = {
  device_code: "pdc_test",
  user_code: "ABCD2345",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  expires_in: 6,
  interval: 2,
  verification_uri: "http://localhost:5173/",
  verification_uri_complete: "http://localhost:5173/?user_code=ABCD2345",
};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pair/start") return Response.json(START, { status: 201 });
    if (path === "/v1/pair/claim") {
      const step = script[claims] ?? script.at(-1) ?? { status: "pending" };
      claims++;
      if (isHttpStep(step)) {
        return Response.json(step.__body ?? { error: "boom" }, { status: step.__http });
      }
      return Response.json(step);
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

async function pair(steps: ClaimStep[], options: { expiresIn?: number } = {}) {
  claims = 0;
  script = steps;
  START.expires_in = options.expiresIn ?? 6;
  const env = { PAA_HOME: await mkdtemp(join(tmpdir(), "paa-pair-")) };
  let clock = 0;
  let sleeps = 0;
  const prompts: unknown[] = [];
  const outcome = await pairRuntime({
    baseUrl: base,
    kind: "claude",
    name: "MacBook / Claude Code",
    env,
    onPrompt: (p) => prompts.push(p),
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
    },
    now: () => clock,
  });
  return { outcome, env, prompts, polls: claims, sleeps };
}

describe("pairing engine", () => {
  test("承認されるまで interval 秒で polling し、credential を保存してから成功を返す", async () => {
    const { outcome, env, prompts, polls } = await pair([
      { status: "pending" },
      { status: "pending" },
      { status: "approved", token: "par_abc", runtime_id: "rt_1" },
    ]);
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(3);
    expect(prompts[0]).toMatchObject({
      user_code: "ABCD2345",
      verification_uri_complete: START.verification_uri_complete,
      interval: 2,
    });
    const saved = await getCredential("claude", env);
    expect(saved).toMatchObject({ runtime_id: "rt_1", token: "par_abc", base_url: base });
  });

  test("human が拒否したら denied を返し credential を書かない", async () => {
    const { outcome, env } = await pair([{ status: "pending" }, { status: "denied" }]);
    expect(outcome.status).toBe("denied");
    expect(await getCredential("claude", env)).toBeUndefined();
  });

  test("期限内に承認されなければ expired(無限 polling しない)", async () => {
    const { outcome, env, polls } = await pair([{ status: "pending" }], { expiresIn: 4 });
    expect(outcome.status).toBe("expired");
    // 0s / 2s / 4s の 3 回。3 回目で deadline に到達して打ち切る
    expect(polls).toBe(3);
    expect(await getCredential("claude", env)).toBeUndefined();
  });

  test("server が expired を返した場合も expired", async () => {
    const { outcome } = await pair([{ status: "expired" }]);
    expect(outcome.status).toBe("expired");
  });

  // ---- PBI-0004 ----

  test("AC-7: 1 回目の poll は interval を待たずに撃つ", async () => {
    const { outcome, polls, sleeps } = await pair([
      { status: "approved", token: "par_abc", runtime_id: "rt_1" },
    ]);
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("AC-4: 一過性の 500 は期限切れにせず polling を続ける", async () => {
    const { outcome, env, polls } = await pair(
      [
        { __http: 500 },
        { status: "pending" },
        { status: "approved", token: "par_abc", runtime_id: "rt_1" },
      ],
      { expiresIn: 60 },
    );
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(3);
    expect((await getCredential("claude", env))?.token).toBe("par_abc");
  });

  test("AC-5: 500 が続いたら failed(expired を騙らない)", async () => {
    const { outcome, polls } = await pair([{ __http: 500 }], { expiresIn: 600 });
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.detail).toContain("500");
    expect(polls).toBe(5);
  });

  test("AC-6: 4xx は retry せず即 failed", async () => {
    const { outcome, polls } = await pair(
      [{ __http: 422, __body: { error: "device_code required" } }],
      { expiresIn: 600 },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.detail).toContain("422");
    expect(polls).toBe(1);
  });

  test("約束外の status は failed(黙って expired にしない)", async () => {
    const { outcome } = await pair([{ status: "teapot" }]);
    expect(outcome.status).toBe("failed");
  });
});
