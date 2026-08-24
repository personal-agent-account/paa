// 受信 routing(要件 §10)。判定順序は docs/diagrams.md 図3 と一致させる:
// blocked → contact 既知 → inbox / 未知 → requests。

export type Bucket = "inbox" | "requests" | "blocked";

export interface RoutingInput {
  senderBlocked: boolean;
  senderKnownContact: boolean;
}

export function decideBucket(input: RoutingInput): Bucket {
  if (input.senderBlocked) return "blocked";
  return input.senderKnownContact ? "inbox" : "requests";
}

/** blocked bucket は保存のみ。notification を出さない(block を悟らせない — 要件 §28) */
export function shouldNotify(bucket: Bucket): boolean {
  return bucket !== "blocked";
}
