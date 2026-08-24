import { apiCall } from "./api.ts";

// Session start behavior(要件 §19)。session 開始時に Mailbox 本文を自動注入せず、
// 小さい metadata だけを見せる。ここに本文を足さないこと —— token 消費・KV 肥大・
// prompt injection surface を増やさないための境界。

export interface SessionBrief {
  agent_id: string;
  handle: string;
  display_name: string;
  runtime_id?: string;
  unread: number;
  /** 未読の送信元内訳(名前と件数のみ) */
  senders: { name: string; count: number }[];
  /** 未知 sender からの未読(requests bucket) */
  requests: number;
}

export async function fetchBrief(baseUrl: string, token: string): Promise<SessionBrief> {
  const who = await apiCall(baseUrl, "/v1/whoami", { token });
  if (who.status !== 200) {
    throw new Error(`whoami failed: ${who.status} ${JSON.stringify(who.body)}`);
  }
  const inbox = await apiCall<any[]>(baseUrl, "/v1/inbox/messages", { token });
  return buildBrief(who.body, Array.isArray(inbox.body) ? inbox.body : []);
}

/** metadata のみから brief を組む(本文 key は入力に無く、出力にも作らない) */
export function buildBrief(whoami: any, messages: any[]): SessionBrief {
  const unreadMessages = messages.filter((m) => m?.read !== true);
  const counts = new Map<string, number>();
  for (const m of unreadMessages) {
    if (m?.bucket !== "inbox") continue;
    const name = String(m?.sender_display ?? "unknown");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    agent_id: whoami.agent_id,
    handle: whoami.handle,
    display_name: whoami.display_name,
    ...(whoami.actor?.runtime_id ? { runtime_id: whoami.actor.runtime_id } : {}),
    unread: Number(whoami.unread ?? 0),
    senders: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    requests: unreadMessages.filter((m) => m?.bucket === "requests").length,
  };
}

/**
 * 要件 §19 の表示形。
 *
 * unread は whoami(inbox bucket・全期間)、senders は inbox/messages(直近 N 件の window)
 * から来る —— 母集団が違うので内訳の合計が unread に届かないことがある。
 * 黙って差を落とすと「Unread: 25 なのに内訳が 1 行も無い」という読めない brief になるので、
 * 差分を必ず 1 行にして見せる。
 */
export function formatBrief(brief: SessionBrief): string {
  const lines = [`Attached as @${brief.handle}`, `Unread: ${brief.unread}`];
  for (const s of brief.senders) lines.push(`- ${s.name} ×${s.count}`);
  const shown = brief.senders.reduce((n, s) => n + s.count, 0);
  if (brief.unread > shown) lines.push(`- ほか ×${brief.unread - shown}`);
  if (brief.requests > 0) lines.push(`- (requests: ${brief.requests})`);
  return lines.join("\n");
}
