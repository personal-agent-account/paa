// PAA Account tools contract(要件 §16)の実装。
// runtime は paired credential で HTTP API を叩く。tool は §16 の 7 操作のみ:
// whoami / inbox.list / inbox.read / send / contacts.list / contacts.get / mark_read。
// memory.* / task.* / browser.* 等は提供しない(要件 §16 の非提供リスト)。
//
// PBI-0006(要件 §9-11): send / inbox_read は sender・recipient 双方の account が
// active device を持つ時、自動的に E2EE(HPKE envelope)を使う。片方でも device が
// 無ければ平文のまま送受信する(server 側の強制拒否はしない設計。backlog/PBI-0006 参照)。

import { fromEnvelopePlaintext, toEnvelopePlaintext, type MessageContent } from "@paa/core";
import { getOrCreateDeviceKey } from "@paa/adapter";
import { open, seal, type EncryptedEnvelope } from "@paa/crypto-envelope";

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

interface DevicePublicKey {
  id: string;
  public_key_jwk: JsonWebKey;
}

/** 自分の device key を用意し、server 側へ upsert 登録する(冪等 — 呼ぶたびに送ってよい) */
async function ensureOwnDevice(config: PaaClientConfig) {
  const record = await getOrCreateDeviceKey(config.deviceKind ?? "default");
  await call(config, "/v1/devices", {
    body: {
      device_name: config.deviceKind ?? "default",
      device_key_id: record.keyId,
      public_key_jwk: record.publicJwk,
    },
  });
  return record;
}

/**
 * seal 先の device 一覧(宛先 account ∪ 自分 account)を組み立てる。
 * 宛先に active device が 1 件も無ければ null(= 平文 fallback の合図)。
 */
async function resolveSealTargets(
  config: PaaClientConfig,
  toHandle: string,
): Promise<{ keyId: string; publicJwk: JsonWebKey }[] | null> {
  const bare = toHandle.replace(/^@/, "");
  const theirs = (await call(config, `/v1/handles/${encodeURIComponent(bare)}/devices`)) as DevicePublicKey[];
  if (theirs.length === 0) return null;
  await ensureOwnDevice(config);
  const mine = (await call(config, "/v1/devices")) as DevicePublicKey[];
  return [...theirs, ...mine].map((d) => ({ keyId: d.id, publicJwk: d.public_key_jwk }));
}

export interface SendInput {
  to: string;
  text?: string;
  urls?: string[];
  files?: { name: string; ref: string }[];
  force?: boolean;
}

async function sealForSend(
  config: PaaClientConfig,
  toHandle: string,
  content: { text?: string; urls?: string[]; files?: SendInput["files"] },
): Promise<MessageContent> {
  try {
    const targets = await resolveSealTargets(config, toHandle);
    if (!targets) return content;
    const plaintext = new TextEncoder().encode(JSON.stringify(toEnvelopePlaintext(content)));
    return { envelope: await seal(plaintext, targets) };
  } catch (e) {
    console.error(`[paa-mcp] E2EE seal に失敗したため平文で送信します: ${e}`);
    return content;
  }
}

async function openIfEnvelope<T extends { content: MessageContent }>(
  config: PaaClientConfig,
  message: T,
): Promise<T | (Omit<T, "content"> & { content: MessageContent & { undecryptable?: true } })> {
  const envelope = message.content.envelope as EncryptedEnvelope | undefined;
  if (envelope == null) return message;
  try {
    const own = await getOrCreateDeviceKey(config.deviceKind ?? "default");
    const plaintextBytes = await open(envelope, own);
    const plaintext = JSON.parse(new TextDecoder().decode(plaintextBytes));
    return { ...message, content: fromEnvelopePlaintext(plaintext) };
  } catch {
    return { ...message, content: { undecryptable: true } };
  }
}

/** §16 contract の 7 操作。MCP server と検査の双方がこの実装を使う */
export function createAccountTools(config: PaaClientConfig) {
  return {
    whoami: () => call(config, "/v1/whoami"),
    inbox_list: () => call(config, "/v1/inbox/messages"),
    inbox_read: async (messageId: string) => {
      const message = (await call(config, `/v1/messages/${messageId}`)) as { content: MessageContent };
      return openIfEnvelope(config, message);
    },
    send: async (input: SendInput) => {
      const { to, text, urls, files, force } = input;
      const content = await sealForSend(config, to, { text, urls, files });
      return call(config, "/v1/send", { body: { to, force, ...content } });
    },
    contacts_list: () => call(config, "/v1/contacts"),
    contacts_get: (contactId: string) => call(config, `/v1/contacts/${contactId}`),
    mark_read: (messageId: string) =>
      call(config, `/v1/messages/${messageId}/read`, { body: {} }),
  };
}

export type AccountTools = ReturnType<typeof createAccountTools>;
