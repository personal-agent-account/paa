import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELEGATION_POLICY,
  decideSend,
  type AccountDelegationPolicy,
} from "../src/delegation.ts";
import { decideBucket, shouldNotify } from "../src/routing.ts";

const runtime = { kind: "runtime", runtimeId: "rt_x" } as const;
const human = { kind: "human" } as const;

describe("decideSend(図4 の全分岐)", () => {
  test("human は常に allow(owner 本人)", () => {
    expect(
      decideSend({ actor: human, peerKnownContact: false, policy: DEFAULT_DELEGATION_POLICY }),
    ).toBe("allow");
  });
  test("runtime + unknown sender は contact override があっても ask", () => {
    expect(
      decideSend({
        actor: runtime,
        peerKnownContact: false,
        policy: DEFAULT_DELEGATION_POLICY,
        contactOverride: { auto_reply: true },
      }),
    ).toBe("ask");
  });
  test("runtime + known + override auto_reply=ON は allow", () => {
    expect(
      decideSend({
        actor: runtime,
        peerKnownContact: true,
        policy: DEFAULT_DELEGATION_POLICY,
        contactOverride: { auto_reply: true },
      }),
    ).toBe("allow");
  });
  test("runtime + known + default policy(send_reply=ask) は ask", () => {
    expect(
      decideSend({ actor: runtime, peerKnownContact: true, policy: DEFAULT_DELEGATION_POLICY }),
    ).toBe("ask");
  });
  test("runtime + known + account policy send_reply=auto は allow", () => {
    const policy: AccountDelegationPolicy = {
      mail: { ...DEFAULT_DELEGATION_POLICY.mail, send_reply: "auto" },
    };
    expect(decideSend({ actor: runtime, peerKnownContact: true, policy })).toBe("allow");
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
