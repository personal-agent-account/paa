// Native PAA E2EE の versioned envelope(アーキ §9-11)。
// 平文を random content key で 1 回だけ AEAD 暗号化し、content key を
// 宛先 device ごとに HPKE で wrap する。独自暗号は作らない:
// HPKE = RFC 9180(@hpke/core)、content AEAD = WebCrypto AES-GCM。
// private key は device の外に出さない(Cloud には public key のみ — アーキ §10)。

import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

export const SUITE_ID = "hpke-p256-sha256-a128gcm" as const;
export const ENVELOPE_VERSION = 1 as const;

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export interface EnvelopeRecipient {
  device_key_id: string;
  /** HPKE encapsulated key (base64url) */
  enc: string;
  /** HPKE で wrap された content key (base64url) */
  wrapped_key: string;
}

export interface EncryptedEnvelope {
  v: typeof ENVELOPE_VERSION;
  suite: typeof SUITE_ID;
  recipients: EnvelopeRecipient[];
  /** content AEAD の IV (base64url) */
  iv: string;
  /** AES-GCM ciphertext (base64url) */
  ciphertext: string;
}

export interface DeviceKeyPair {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

// Buffer(Node 専用)に依存しない実装。Bun / browser(apps/web の Vite bundle) 両方の
// atob/btoa + Uint8Array だけで完結させる(この package は 3 環境から呼ばれる)。
const b64u = {
  encode: (buf: ArrayBuffer | Uint8Array): string => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode: (s: string): Uint8Array => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(withPad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },
};

/** public key JWK から決定的に device key ID を導出(sha256 の先頭 16 byte) */
export async function deriveKeyId(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return "dvk_" + b64u.encode(digest.slice(0, 16));
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const kp = (await suite.kem.generateKeyPair()) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { keyId: await deriveKeyId(publicJwk), publicJwk, privateJwk };
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

export async function seal(
  plaintext: Uint8Array,
  recipients: { keyId: string; publicJwk: JsonWebKey }[],
): Promise<EncryptedEnvelope> {
  if (recipients.length === 0) {
    throw new Error("envelope needs at least one recipient device");
  }
  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await crypto.subtle.importKey(
    "raw",
    contentKeyRaw,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    plaintext as BufferSource,
  );

  const wrapped: EnvelopeRecipient[] = [];
  for (const r of recipients) {
    const sender = await suite.createSenderContext({
      recipientPublicKey: await importPublic(r.publicJwk),
    });
    const wrappedKey = await sender.seal(contentKeyRaw as BufferSource);
    wrapped.push({
      device_key_id: r.keyId,
      enc: b64u.encode(sender.enc),
      wrapped_key: b64u.encode(wrappedKey),
    });
  }
  return {
    v: ENVELOPE_VERSION,
    suite: SUITE_ID,
    recipients: wrapped,
    iv: b64u.encode(iv),
    ciphertext: b64u.encode(ciphertext),
  };
}

/**
 * 鍵委譲(Account Recovery — PBI-0010)。既存 recipient(from)の private key で
 * content key だけを取り出し(ciphertext には触れない)、新 recipient(to)向けに re-wrap する。
 * 返すのは追加する recipient entry 1 件のみ — 呼び出し元は envelope 全体を作り直さず
 * `recipients` 配列へ追記できる
 */
export async function addRecipient(
  envelope: EncryptedEnvelope,
  from: { keyId: string; privateJwk: JsonWebKey },
  to: { keyId: string; publicJwk: JsonWebKey },
): Promise<EnvelopeRecipient> {
  if (envelope.v !== ENVELOPE_VERSION || envelope.suite !== SUITE_ID) {
    throw new Error(`unsupported envelope version/suite: ${envelope.v}/${envelope.suite}`);
  }
  const mine = envelope.recipients.find((r) => r.device_key_id === from.keyId);
  if (!mine) throw new Error("this device is not a recipient of the envelope");

  const recipient = await suite.createRecipientContext({
    recipientKey: await importPrivate(from.privateJwk),
    enc: b64u.decode(mine.enc) as BufferSource,
  });
  const contentKeyRaw = await recipient.open(
    b64u.decode(mine.wrapped_key) as BufferSource,
  );

  const sender = await suite.createSenderContext({
    recipientPublicKey: await importPublic(to.publicJwk),
  });
  const wrappedKey = await sender.seal(contentKeyRaw as BufferSource);
  return {
    device_key_id: to.keyId,
    enc: b64u.encode(sender.enc),
    wrapped_key: b64u.encode(wrappedKey),
  };
}

export async function open(
  envelope: EncryptedEnvelope,
  device: { keyId: string; privateJwk: JsonWebKey },
): Promise<Uint8Array> {
  if (envelope.v !== ENVELOPE_VERSION || envelope.suite !== SUITE_ID) {
    throw new Error(`unsupported envelope version/suite: ${envelope.v}/${envelope.suite}`);
  }
  const mine = envelope.recipients.find((r) => r.device_key_id === device.keyId);
  if (!mine) throw new Error("this device is not a recipient of the envelope");

  const recipient = await suite.createRecipientContext({
    recipientKey: await importPrivate(device.privateJwk),
    enc: b64u.decode(mine.enc) as BufferSource,
  });
  const contentKeyRaw = await recipient.open(
    b64u.decode(mine.wrapped_key) as BufferSource,
  );
  const contentKey = await crypto.subtle.importKey(
    "raw",
    contentKeyRaw,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64u.decode(envelope.iv) as BufferSource },
    contentKey,
    b64u.decode(envelope.ciphertext) as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// ---------- 添付の実体(PBI-0074 / W13) ----------
// envelope の外に置く blob 用の 1 回鍵 AEAD。keyB64 は FileRef.key に入り、FileRef ごと
// envelope 平文に seal される — つまり内容鍵は宛先 device の HPKE の内側に入る。server は
// blob も keyB64 も平文で見ない(E2EE アーキ §9 を添付に貫く)。

export interface FileCrypt {
  ciphertext: Uint8Array;
  /** base64(key 32byte ‖ iv 12byte)。FileRef.key に入れる値 */
  keyB64: string;
}

export async function encryptFileBytes(bytes: Uint8Array): Promise<FileCrypt> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    bytes as BufferSource,
  );
  const combined = new Uint8Array(44);
  combined.set(raw, 0);
  combined.set(iv, 32);
  return { ciphertext: new Uint8Array(ciphertext), keyB64: b64u.encode(combined) };
}

export async function decryptFileBytes(
  ciphertext: Uint8Array,
  keyB64: string,
): Promise<Uint8Array> {
  const combined = b64u.decode(keyB64);
  if (combined.length !== 44) throw new Error("invalid file key length");
  const raw = combined.slice(0, 32);
  const iv = combined.slice(32);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}
