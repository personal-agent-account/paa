import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELEGATION_POLICY,
  decideSend,
  mailStage,
  resolveMailPolicy,
  type AccountDelegationPolicy,
  type DelegationResult,
  type MailDelegationPolicy,
} from "../src/delegation.ts";
import { decideBucket, shouldNotify } from "../src/routing.ts";

const runtime = { kind: "runtime", runtimeId: "rt_x" } as const;
const human = { kind: "human" } as const;

const policyOf = (patch: Partial<MailDelegationPolicy>): AccountDelegationPolicy => ({
  mail: { ...DEFAULT_DELEGATION_POLICY.mail, ...patch },
});

describe("mailStage(要件 §22.2 の 3 択)", () => {
  test("draft=false は send_reply に関わらず read(矛盾状態も read に倒す)", () => {
    expect(mailStage(policyOf({ draft: false }).mail)).toBe("read");
    expect(mailStage(policyOf({ draft: false, send_reply: "auto" }).mail)).toBe("read");
  });
  test("draft=true, send_reply=ask は ask", () => {
    expect(mailStage(policyOf({ draft: true, send_reply: "ask" }).mail)).toBe("ask");
  });
  test("draft=true, send_reply=auto は auto", () => {
    expect(mailStage(policyOf({ draft: true, send_reply: "auto" }).mail)).toBe("auto");
  });
});

// actor × draft × known × contact.auto_reply × send_reply の全組合せ(図4 v2 / PBI-0029 AC-1〜7)
describe("decideSend(図4 v2 の全分岐)", () => {
  const cases: Array<{
    name: string;
    actor: typeof human | typeof runtime;
    draft: boolean;
    known: boolean;
    override?: boolean;
    sendReply: "ask" | "auto";
    expected: DelegationResult;
  }> = [
    {
      name: "human は draft/known に関わらず allow(owner 本人)",
      actor: human,
      draft: false,
      known: false,
      sendReply: "auto",
      expected: { decision: "allow", reason: "human_owner", stage: "read", override: false },
    },
    {
      name: "AC-1: runtime + draft=false + known は deny/read_only(read が最優先)",
      actor: runtime,
      draft: false,
      known: true,
      sendReply: "ask",
      expected: { decision: "deny", reason: "read_only", stage: "read", override: false },
    },
    {
      name: "AC-7: runtime + draft=false + send_reply=auto(矛盾)も deny/read_only, stage=read",
      actor: runtime,
      draft: false,
      known: true,
      sendReply: "auto",
      expected: { decision: "deny", reason: "read_only", stage: "read", override: false },
    },
    {
      name: "runtime + draft=false + unknown も deny/read_only(read が unknown より優先)",
      actor: runtime,
      draft: false,
      known: false,
      sendReply: "ask",
      expected: { decision: "deny", reason: "read_only", stage: "read", override: false },
    },
    {
      name: "runtime + unknown sender は contact override があっても ask/unknown_sender",
      actor: runtime,
      draft: true,
      known: false,
      override: true,
      sendReply: "ask",
      expected: { decision: "ask", reason: "unknown_sender", stage: "ask", override: false },
    },
    {
      name: "AC-3: runtime + known + override auto_reply=ON は allow/contact_auto_reply",
      actor: runtime,
      draft: true,
      known: true,
      override: true,
      sendReply: "ask",
      expected: { decision: "allow", reason: "contact_auto_reply", stage: "ask", override: false },
    },
    {
      name: "AC-2: runtime + known + send_reply=ask(既定) は ask/account_ask",
      actor: runtime,
      draft: true,
      known: true,
      sendReply: "ask",
      expected: { decision: "ask", reason: "account_ask", stage: "ask", override: false },
    },
    {
      name: "runtime + known + send_reply=auto は allow/account_auto",
      actor: runtime,
      draft: true,
      known: true,
      sendReply: "auto",
      expected: { decision: "allow", reason: "account_auto", stage: "auto", override: false },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const policy = policyOf({ draft: c.draft, send_reply: c.sendReply });
      const result = decideSend({
        actor: c.actor,
        peerKnownContact: c.known,
        policy,
        contactOverride: c.override !== undefined ? { auto_reply: c.override } : undefined,
      });
      expect(result).toEqual(c.expected);
    });
  }
});

// PBI-0030: runtime 単位の override(要件 §34)。resolveMailPolicy 1 関数を全 gate が経由する前提
describe("resolveMailPolicy(PBI-0030 の override 解決)", () => {
  const base = policyOf({ draft: true, send_reply: "ask" });

  test("override 無しは account の mail をそのまま返す", () => {
    expect(resolveMailPolicy(base, "rt_x")).toEqual(base.mail);
    expect(resolveMailPolicy(base)).toEqual(base.mail);
  });

  test("該当 runtime の override が指定 key だけ上書きする(他 key は account のまま)", () => {
    const policy: AccountDelegationPolicy = {
      ...base,
      runtime_overrides: { rt_x: { send_reply: "auto" } },
    };
    expect(resolveMailPolicy(policy, "rt_x")).toEqual({ ...base.mail, send_reply: "auto" });
  });

  test("override を持たない他の runtime には効かない", () => {
    const policy: AccountDelegationPolicy = {
      ...base,
      runtime_overrides: { rt_x: { draft: false } },
    };
    expect(resolveMailPolicy(policy, "rt_y")).toEqual(base.mail);
  });
});

describe("decideSend の runtime override(PBI-0030 AC-1/2)", () => {
  test("AC-1: account send_reply=ask でも override send_reply=auto の runtime は allow/account_auto, override=true", () => {
    const policy: AccountDelegationPolicy = {
      mail: { ...DEFAULT_DELEGATION_POLICY.mail, draft: true, send_reply: "ask" },
      runtime_overrides: { rt_x: { send_reply: "auto" } },
    };
    const result = decideSend({
      actor: { kind: "runtime", runtimeId: "rt_x" },
      peerKnownContact: true,
      policy,
    });
    expect(result).toEqual({ decision: "allow", reason: "account_auto", stage: "auto", override: true });

    // override を持たない runtime は account 設定(ask)のまま
    const other = decideSend({
      actor: { kind: "runtime", runtimeId: "rt_y" },
      peerKnownContact: true,
      policy,
    });
    expect(other).toEqual({ decision: "ask", reason: "account_ask", stage: "ask", override: false });
  });

  test("AC-2: override draft=false は deny/read_only, override=true。他 runtime は ask のまま", () => {
    const policy: AccountDelegationPolicy = {
      mail: { ...DEFAULT_DELEGATION_POLICY.mail, draft: true, send_reply: "ask" },
      runtime_overrides: { rt_x: { draft: false } },
    };
    const result = decideSend({
      actor: { kind: "runtime", runtimeId: "rt_x" },
      peerKnownContact: true,
      policy,
    });
    expect(result).toEqual({ decision: "deny", reason: "read_only", stage: "read", override: true });
    expect(mailStage(resolveMailPolicy(policy, "rt_x"))).toBe("read");
    expect(mailStage(resolveMailPolicy(policy, "rt_y"))).toBe("ask");
  });

  test("PBI-0094: peerIsSelf は unknown / read_only より前に allow(self_thread)", () => {
    const runtime = { kind: "runtime", runtimeId: "rt_x" } as const;
    // unknown sender(peerKnownContact: false)でも自分宛ては allow
    expect(
      decideSend({ actor: runtime, peerKnownContact: false, policy: DEFAULT_DELEGATION_POLICY, peerIsSelf: true }),
    ).toEqual({ decision: "allow", reason: "self_thread", stage: "ask", override: false });
    // read_only(draft:false)でも自分宛ては allow(owner への報告は外への副作用が無い)
    const readOnly: AccountDelegationPolicy = {
      mail: { ...DEFAULT_DELEGATION_POLICY.mail, draft: false },
    };
    expect(
      decideSend({ actor: runtime, peerKnownContact: false, policy: readOnly, peerIsSelf: true }),
    ).toEqual({ decision: "allow", reason: "self_thread", stage: "read", override: false });
    // peerIsSelf が無ければ従来どおり(unknown → ask / read_only → deny)
    expect(
      decideSend({ actor: runtime, peerKnownContact: false, policy: DEFAULT_DELEGATION_POLICY }).decision,
    ).toBe("ask");
    expect(
      decideSend({ actor: runtime, peerKnownContact: false, policy: readOnly }).decision,
    ).toBe("deny");
  });
});

describe("decideBucket(図3 の判定順序)", () => {
  test("blocked が最優先(contact 登録済みでも blocked)", () => {
    expect(decideBucket({ senderBlocked: true, senderKnownContact: true })).toBe("blocked");
  });
  test("known → inbox / unknown → requests", () => {
    expect(decideBucket({ senderBlocked: false, senderKnownContact: true })).toBe("inbox");
    expect(decideBucket({ senderBlocked: false, senderKnownContact: false })).toBe("requests");
  });
  test("blocked は notification を出さない", () => {
    expect(shouldNotify("blocked")).toBe(false);
    expect(shouldNotify("inbox")).toBe(true);
    expect(shouldNotify("requests")).toBe(true);
  });
});
