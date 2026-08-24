import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { reconcile } from "../src/reconcile.ts";
import {
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type ExtensionApplyAction,
  type ExtensionListing,
  type RuntimeAdapter,
} from "../src/contract.ts";

// AC-8(未管理を触らない、実 adapter 経路)/ AC-13(credential_ref 未解決)/
// AC-14(部分失敗)/ AC-15,16(dry-run と 冪等性)。
// GET /v1/extensions と POST /v1/extensions/:id/status だけを実装した fake server で
// reconcile() の orchestration(credential 解決・エラー隔離・status 報告規約)だけを検査する
// —— 判定順序そのもの(図8)は packages/core/test/extension.test.ts が純関数として検査済み。

let desiredResponse: unknown[] = [];
const statusCalls: { extensionId: string; body: any }[] = [];

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/extensions" && req.method === "GET") {
      return Response.json(desiredResponse);
    }
    const statusMatch = url.pathname.match(/^\/v1\/extensions\/([^/]+)\/status$/);
    if (statusMatch && req.method === "POST") {
      const body = await req.json();
      statusCalls.push({ extensionId: statusMatch[1]!, body });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

beforeEach(() => {
  desiredResponse = [];
  statusCalls.length = 0;
});

interface FakeAdapterState {
  applyCalls: ExtensionApplyAction[];
  listing: ExtensionListing[];
  throwOn?: string;
}

function makeFakeAdapter(state: FakeAdapterState): RuntimeAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    capabilities: STAGE0_CAPABILITIES,
    detect: async () => ({ installed: true, detail: "fake" }),
    register: async () => {},
    unregister: async () => {},
    doctor: async () => [],
    extensionKinds: ["mcp"],
    listExtensions: async () => state.listing,
    applyExtension: async (_ctx, action) => {
      state.applyCalls.push(action);
      if (state.throwOn === action.name) throw new Error(`boom on ${action.name}`);
    },
  };
}

const ctx: AdapterContext = { env: {} };

describe("reconcile()", () => {
  test("install 成功: applyExtension が呼ばれ、status=applied/applied_revision で報告される", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx", args: ["-y", "gh-mcp"] },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan).toMatchObject([{ action: "install", name: "github" }]);
    expect(state.applyCalls).toMatchObject([
      { action: "install", name: "github", spec: { command: "npx" }, env: {} },
    ]);
    expect(statusCalls).toMatchObject([
      { extensionId: "ext_gh", body: { status: "applied", applied_revision: 1 } },
    ]);
    expect(result.applied).toMatchObject([{ action: "install", name: "github" }]);
    expect(result.failed).toEqual([]);
  });

  test("AC-13: credential_ref が解決できない時は native を書かず failed を報告する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "env:GITHUB_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {}, // GITHUB_TOKEN が無い
    });
    expect(state.applyCalls).toEqual([]); // native を書かない
    expect(result.failed).toMatchObject([{ name: "github", detail: "env:GITHUB_TOKEN を解決できません" }]);
    expect(statusCalls).toMatchObject([
      { extensionId: "ext_gh", body: { status: "failed", detail: "env:GITHUB_TOKEN を解決できません" } },
    ]);
  });

  test("credential_ref が解決できる時は env に注入されて applyExtension へ渡る", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "env:GITHUB_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: { GITHUB_TOKEN: "ghp_realvalue" },
    });
    expect(state.applyCalls).toMatchObject([{ env: { GITHUB_TOKEN: "ghp_realvalue" } }]);
    expect(result.failed).toEqual([]);
    // secret は status 報告には含まれない(applied_revision と status のみ送る)
    expect(JSON.stringify(statusCalls)).not.toContain("ghp_realvalue");
  });

  test("AC-14: 3 件中 1 件だけ失敗しても残り 2 件は適用される", async () => {
    desiredResponse = ["a", "b", "c"].map((name, i) => ({
      id: `ext_${name}`,
      kind: "mcp",
      name,
      spec: { command: "npx" },
      credential_ref: null,
      enabled: true,
      revision: 1,
      deleted_at: null,
      materializations: [],
    }));
    const state: FakeAdapterState = { applyCalls: [], listing: [], throwOn: "b" };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls.map((c) => c.name).sort()).toEqual(["a", "b", "c"]);
    expect(result.applied.map((a) => a.name).sort()).toEqual(["a", "c"]);
    expect(result.failed).toMatchObject([{ name: "b", detail: "boom on b" }]);
    const byExt = Object.fromEntries(statusCalls.map((s) => [s.extensionId, s.body.status]));
    expect(byExt).toEqual({ ext_a: "applied", ext_b: "failed", ext_c: "applied" });
  });

  test("AC-15: dry-run は plan だけを返し、native にも status にも一切書き込まない", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
      dryRun: true,
    });
    expect(result.plan).toMatchObject([{ action: "install", name: "github" }]);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("AC-16: 差分が無ければ noop になり applyExtension も status POST も呼ばれない(冪等性)", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [
          { runtime_id: "rt_1", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [{ name: "github" }] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan).toMatchObject([{ action: "noop", name: "github" }]);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  test("AC-8: 未管理の native extension には applyExtension が一度も呼ばれない", async () => {
    desiredResponse = [];
    const state: FakeAdapterState = {
      applyCalls: [],
      listing: [{ name: "paa" }, { name: "other" }],
    };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan.every((a) => a.action === "noop")).toBe(true);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  test("kind 未対応は unsupported として報告され、applyExtension は呼ばれない", async () => {
    desiredResponse = [
      {
        id: "ext_figma",
        kind: "plugin",
        name: "figma",
        spec: {},
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toMatchObject([{ extensionId: "ext_figma", body: { status: "unsupported" } }]);
  });

  test("AC-10: uninstall 成功時は status=uninstalled(値ではなく行削除 signal)で報告する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: new Date().toISOString(),
        materializations: [
          { runtime_id: "rt_1", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [{ name: "github" }] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls).toMatchObject([{ action: "uninstall", name: "github" }]);
    expect(statusCalls).toMatchObject([{ extensionId: "ext_gh", body: { status: "uninstalled" } }]);
    expect(result.applied).toMatchObject([{ action: "uninstall", name: "github" }]);
  });
});
