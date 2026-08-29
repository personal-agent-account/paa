// PAA Account tools contract(要件 §16)の実装。
// runtime は paired credential で HTTP API を叩く。tool は §16 の 8 操作:
// whoami / inbox.list / inbox.read / send / contacts.list / contacts.get / mark_read / approval_get。
// memory.* / task.* / browser.* 等は提供しない(要件 §16 の非提供リスト)。
//
// PBI-0006(要件 §9-11): send / inbox_read は sender・recipient 双方の account が
// active device を持つ時、自動的に E2EE(HPKE envelope)を使う。片方でも device が
// 無ければ平文のまま送受信する(server 側の強制拒否はしない設計。backlog/PBI-0006 参照)。

import type { MessageContent } from "@paa/core";
import { openIfEnvelope as openEnvelope, sealForHandle } from "@paa/adapter";

export interface PaaClientConfig {
  baseUrl: string;
  token: string;
  /** device key の永続化単位(credential store の kind と同じ)。省略時は "default" */
  deviceKind?: string;
}

export class PaaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`PAA API error ${status}: ${JSON.stringify(body)}`);
  }
}

async function call(
  config: PaaClientConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new PaaApiError(res.status, body);
  return body;
}

/**
 * E2EE の作法(device upsert → 宛先公開鍵 → seal / open)は `@paa/adapter` の e2ee.ts が正本。
 * `paa agent`(PBI-0057)も同じ関数を使う —— client 側に 2 つ目の実装を置かない。
 */
const e2eeCall = (config: PaaClientConfig) =>
  (path: string, init?: { method?: string; body?: unknown }) => call(config, path, init);

const deviceKindOf = (config: PaaClientConfig) => config.deviceKind ?? "default";

export interface SendInput {
  to: string;
  text?: string;
  urls?: string[];
  files?: { name: string; ref: string }[];
  force?: boolean;
}

/** §16 contract の 8 操作。MCP server と検査の双方がこの実装を使う */
export function createAccountTools(config: PaaClientConfig) {
  return {
    whoami: () => call(config, "/v1/whoami"),
    inbox_list: () => call(config, "/v1/inbox/messages"),
    inbox_read: async (messageId: string) => {
      const message = (await call(config, `/v1/messages/${messageId}`)) as { content: MessageContent };
      return openEnvelope(deviceKindOf(config), message);
    },
    send: async (input: SendInput) => {
      const { to, text, urls, files, force } = input;
      const content = await sealForHandle(e2eeCall(config), deviceKindOf(config), to, { text, urls, files });
      return call(config, "/v1/send", { body: { to, force, ...content } });
    },
    contacts_list: () => call(config, "/v1/contacts"),
    contacts_get: (contactId: string) => call(config, `/v1/contacts/${contactId}`),
    mark_read: (messageId: string) =>
      call(config, `/v1/messages/${messageId}/read`, { body: {} }),
    // PBI-0031: 自分が起こした approval の pending/approved/rejected を polling できる。
    // content は server が返さない(human の編集後本文を runtime に見せる理由が無い)
    approval_get: (approvalId: string) => call(config, `/v1/approvals/${approvalId}`),
  };
}

export type AccountTools = ReturnType<typeof createAccountTools>;
