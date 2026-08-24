// Delegation Policy(要件 §22-23)。Human is owner. Agent is a delegated actor.
// 決定順序は docs/diagrams.md 図4 と一致させる:
// human → allow / runtime: unknown sender → ask / contact override → allow /
// account policy(send_reply) → auto なら allow, ask なら ask。

export type DelegationDecision = "allow" | "ask";

export interface MailDelegationPolicy {
  receive: "auto";
  agent_read: boolean;
  draft: boolean;
  send_reply: "ask" | "auto";
  auto_reply: boolean;
}

export interface AccountDelegationPolicy {
  mail: MailDelegationPolicy;
}

// 要件 §23.1 の default
export const DEFAULT_DELEGATION_POLICY: AccountDelegationPolicy = {
  mail: {
    receive: "auto",
    agent_read: true,
    draft: true,
    send_reply: "ask",
    auto_reply: false,
  },
};

export interface ContactDelegationOverride {
  auto_reply?: boolean;
}

export type SendActor =
  | { kind: "human" }
  | { kind: "runtime"; runtimeId: string };

export interface ReplyDecisionInput {
  actor: SendActor;
  /** 送信相手が既知 contact か。unknown sender は AUTO 対象にしない(要件 §10, §13) */
  peerKnownContact: boolean;
  policy: AccountDelegationPolicy;
  contactOverride?: ContactDelegationOverride;
}

export function decideSend(input: ReplyDecisionInput): DelegationDecision {
  if (input.actor.kind === "human") return "allow";
  if (!input.peerKnownContact) return "ask";
  if (input.contactOverride?.auto_reply) return "allow";
  return input.policy.mail.send_reply === "auto" ? "allow" : "ask";
}
