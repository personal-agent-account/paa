import { fromEnvelopePlaintext, toEnvelopePlaintext, type MessageContent } from "@paa/core";
import { open, seal, type EncryptedEnvelope } from "@paa/crypto-envelope";
import { getOrCreateDeviceKey } from "./devicekeys.ts";

// Native E2EE(要件 §9-11 / PBI-0006)の client 側の作法を 1 箇所に集める。
// 使うのは MCP tools(packages/mcp)と `atn agent`(apps/cli。PBI-0057)の 2 つで、
// どちらも「device を upsert 登録 → 宛先の公開鍵を引く → seal / open」の同じ手順を踏む。
// HTTP の呼び方(認証・error 型)は呼び出し側で違うので `call` を注入する —— ここに 2 つ目の
// API client を作らないための境界(呼び出し側の error 型・retry 方針をそのまま活かす)。

export type E2eeCall = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

interface DevicePublicKey {
  id: string;
  public_key_jwk: JsonWebKey;
}

/** 自分の device key を用意し、server 側へ upsert 登録する(冪等 — 呼ぶたびに送ってよい) */
export async function ensureOwnDevice(call: E2eeCall, deviceKind: string) {
  const record = await getOrCreateDeviceKey(deviceKind);
  await call("/v1/devices", {
    body: {
      device_name: deviceKind,
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
export async function resolveSealTargets(
  call: E2eeCall,
  deviceKind: string,
  toHandle: string,
): Promise<{ keyId: string; publicJwk: JsonWebKey }[] | null> {
  const bare = toHandle.replace(/^@/, "");
  const theirs = (await call(`/v1/handles/${encodeURIComponent(bare)}/devices`)) as DevicePublicKey[];
  if (theirs.length === 0) return null;
  await ensureOwnDevice(call, deviceKind);
  const mine = (await call("/v1/devices")) as DevicePublicKey[];
  return [...theirs, ...mine].map((d) => ({ keyId: d.id, publicJwk: d.public_key_jwk }));
}

/**
 * 平文 fallback は **「宛先に active device が 0 件」の 1 経路だけ**(PBI-0006 AC-7)。
 * seal や device 解決の失敗を捕まえて平文へ落とすのは設計に無い downgrade で、
 * 誰でも壊れた JWK を 1 件自分に登録するだけで、その account 宛の全送信を平文に
 * (= 運営が読める状態に)落とせてしまう(PBI-0023 F4)。失敗はそのまま呼び出し元へ投げる。
 */
export async function sealForHandle(
  call: E2eeCall,
  deviceKind: string,
  toHandle: string,
  content: { text?: string; urls?: string[]; files?: MessageContent["files"] },
): Promise<MessageContent> {
  const targets = await resolveSealTargets(call, deviceKind, toHandle);
  if (!targets) return content;
  const plaintext = new TextEncoder().encode(JSON.stringify(toEnvelopePlaintext(content)));
  return { envelope: await seal(plaintext, targets) };
}

/** envelope なら自分の device key で開く。開けなければ `{undecryptable:true}` に落とす(本文は作らない) */
export async function openIfEnvelope<T extends { content: MessageContent }>(
  deviceKind: string,
  message: T,
): Promise<T | (Omit<T, "content"> & { content: MessageContent & { undecryptable?: true } })> {
  const envelope = message.content.envelope as EncryptedEnvelope | undefined;
  if (envelope == null) return message;
  try {
    const own = await getOrCreateDeviceKey(deviceKind);
    const plaintextBytes = await open(envelope, own);
    const plaintext = JSON.parse(new TextDecoder().decode(plaintextBytes));
    return { ...message, content: fromEnvelopePlaintext(plaintext) };
  } catch {
    return { ...message, content: { undecryptable: true } };
  }
}
