import {
  apiCall,
  getCredential,
  openIfEnvelope,
  sealForHandle,
  type E2eeCall,
} from "@paa/adapter";
import type { MessageContent } from "@paa/core";

// `paa agent <provider>` —— 外部 API provider を「端末で動く runtime」として扱う本体
// (EP-0009 B / PBI-0057)。E2EE(アーキ §9)により server は本文を復号できないので、
// provider API を呼べるのは device key を持つ端末側だけ。ここは **1 turn の下書き** に
// 徹する: tool 実行・自律 loop・streaming は持たない(要件 §35 Model router にしない)。
//
// 経路: runtime credential で thread を読む → device key で復号 → Connections の API key を
// resolve(初回は Connection-scoped ASK を通る) → OpenAI 互換 /chat/completions を 1 回 →
// 返信は POST /v1/threads/:id/reply = decideSend の READ/ASK/AUTO を runtime actor として通る。

/** provider ごとの接続先。**model 名は cutoff 後に変わる**ので `--model` / PAA_AGENT_MODEL で上書きできる
 * (2026-08-28 時点の出典は backlog/PBI-0057 の技術設計に URL で残してある) */
const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.2" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3-flash",
  },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
} as const;

export type AgentProvider = keyof typeof PROVIDERS;
export const AGENT_PROVIDERS = Object.keys(PROVIDERS) as AgentProvider[];
export const isAgentProvider = (p: string): p is AgentProvider => p in PROVIDERS;

/** credential store / device key store の単位。claude / codex と同じ 1 kind = 1 runtime_id */
export const agentKind = (provider: AgentProvider): string => `${provider}-api`;

const SYSTEM_PROMPT =
  "あなたはこの Account の代理として、受け取ったメッセージへの返信の下書きを 1 通だけ書きます。" +
  "本文だけを返し、前置き・署名・宛名の繰り返しは書かないでください。";

export interface AgentOptions {
  provider: AgentProvider;
  threadId: string;
  model?: string;
  /** connection 承認を待つ上限秒。0 で待たない */
  waitSec?: number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface AgentResult {
  status: "sent" | "ask_approval_required" | "denied" | "already_handled" | "failed";
  detail?: string;
  approvalId?: string;
}

interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  content: MessageContent;
}

const APPROVAL_POLL_INTERVAL_MS = 2_000;

/**
 * Connections から API key を取り出す。初回は Connection-scoped ASK(PBI-0055)が入るので
 * 202 pending_approval を受け取り、human が承認するまで `approval_get` を polling する。
 * **key は返り値としてだけ扱い、ファイルにも log にも書かない**(要件 §40.3)。
 */
async function resolveApiKey(
  baseUrl: string,
  token: string,
  provider: AgentProvider,
  waitSec: number,
  log: (line: string) => void,
): Promise<{ ok: true; key: string } | { ok: false; detail: string }> {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const res = await apiCall(baseUrl, `/v1/connections/${provider}/resolve`, {
      token,
      method: "POST",
    });
    if (res.status === 200) {
      const key = res.body?.env?.[`${provider.toUpperCase()}_TOKEN`];
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false, detail: "connection_resolve_empty" };
      }
      return { ok: true, key };
    }
    if (res.status === 202) {
      if (waitSec <= 0) {
        return { ok: false, detail: `承認待ちです(approval_id=${res.body?.approval_id})` };
      }
      log(`${provider} の API key の利用に承認が必要です。承認を待っています...`);
      const approvalId = res.body?.approval_id as string | undefined;
      // 承認されると次の resolve が 200 を返す(approved 行を消費する)ので、
      // ここでは approval の状態だけを見て「待つのをやめる条件」を判定する
      for (;;) {
        if (Date.now() > deadline) return { ok: false, detail: "承認待ちが時間切れです" };
        await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
        if (!approvalId) break;
        const st = await apiCall(baseUrl, `/v1/approvals/${approvalId}`, { token });
        if (st.status !== 200) break;
        if (st.body?.status === "approved") break;
        if (st.body?.status === "rejected") return { ok: false, detail: "承認が拒否されました" };
      }
      continue;
    }
    if (res.status === 403) return { ok: false, detail: "connection_use_denied" };
    return { ok: false, detail: `connection_unavailable(${res.status})` };
  }
}

/** provider の応答本文は表に出さない —— key を echo する API があるため status だけを見せる */
async function draftReply(
  provider: AgentProvider,
  apiKey: string,
  model: string,
  baseUrl: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      }),
    });
  } catch (e) {
    return { ok: false, detail: `provider_unreachable(${(e as Error).name})` };
  }
  if (!res.ok) return { ok: false, detail: `provider_error(${res.status})` };
  const body = (await res.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const text = body?.choices?.[0]?.message?.content ?? "";
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, detail: "empty_draft" };
  }
  return { ok: true, text };
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const kind = agentKind(opts.provider);
  const credential = await getCredential(kind, env);
  if (!credential) {
    return {
      status: "failed",
      detail: `${opts.provider} は未接続です。'bun run paa login' でこの Mac を接続してください`,
    };
  }
  const { base_url: baseUrl, token } = credential;
  const call: E2eeCall = async (path, init) => {
    const res = await apiCall(baseUrl, path, { token, ...init });
    if (res.status >= 400) throw new Error(`account_api_error(${res.status}) ${path}`);
    return res.body;
  };

  const threadRes = await apiCall(baseUrl, `/v1/threads/${opts.threadId}`, { token });
  if (threadRes.status !== 200) {
    return { status: "failed", detail: `thread を読めません(${threadRes.status})` };
  }
  const peerHandle = threadRes.body?.peer_handle as string | null;
  const messages = (threadRes.body?.messages ?? []) as ThreadMessage[];

  // 復号できない message は履歴から落とす(平文を作らない・provider にも渡さない)
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const opened = await openIfEnvelope(kind, m);
    const text = (opened.content as MessageContent).text;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    history.push({ role: m.direction === "in" ? "user" : "assistant", content: text });
  }
  if (history.length === 0) {
    return { status: "failed", detail: "この端末で読める本文がありません" };
  }

  const key = await resolveApiKey(baseUrl, token, opts.provider, opts.waitSec ?? 300, log);
  if (!key.ok) return { status: "failed", detail: key.detail };

  const providerBaseUrl = env.PAA_AGENT_BASE_URL ?? PROVIDERS[opts.provider].baseUrl;
  const model = opts.model ?? env.PAA_AGENT_MODEL ?? PROVIDERS[opts.provider].model;
  const draft = await draftReply(opts.provider, key.key, model, providerBaseUrl, history);
  if (!draft.ok) return { status: "failed", detail: draft.detail };

  // seal は @paa/adapter の e2ee(MCP tools と同じ経路)。相手に active device が無い時だけ平文
  const content = peerHandle
    ? await sealForHandle(call, kind, peerHandle, { text: draft.text })
    : { text: draft.text };
  const reply = await apiCall(baseUrl, `/v1/threads/${opts.threadId}/reply`, {
    token,
    method: "POST",
    body: content,
  });
  if (reply.status === 403) {
    return { status: "denied", detail: reply.body?.reason ?? "delegation_denied" };
  }
  if (reply.status === 409) return { status: "already_handled" };
  if (reply.status !== 202 && reply.status !== 200) {
    return { status: "failed", detail: `reply に失敗しました(${reply.status})` };
  }
  if (reply.body?.status === "ask_approval_required") {
    return { status: "ask_approval_required", approvalId: reply.body?.approval_id };
  }
  return { status: "sent" };
}
