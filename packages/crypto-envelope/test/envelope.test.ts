import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  decryptFileBytes,
  encryptFileBytes,
  generateDeviceKeyPair,
  open,
  seal,
  type EncryptedEnvelope,
} from "../src/index.ts";

const text = (s: string) => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array) => new TextDecoder().decode(b);

describe("HPKE versioned envelope (AC-17)", () => {
  test("multi-device roundtrip: 宛先 A/B どちらの device でも開ける", async () => {
    const a = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    const env = await seal(text("この設計見て"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
      { keyId: b.keyId, publicJwk: b.publicJwk },
    ]);
    expect(env.v).toBe(1);
    expect(env.recipients.length).toBe(2);
    expect(fromBytes(await open(env, a))).toBe("この設計見て");
    expect(fromBytes(await open(env, b))).toBe("この設計見て");
  });

  test("非宛先 device では開けない", async () => {
    const a = await generateDeviceKeyPair();
    const c = await generateDeviceKeyPair();
    const env = await seal(text("secret"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
    ]);
    expect(open(env, c)).rejects.toThrow("not a recipient");
    // key ID を偽装して A の wrapped_key を C の鍵で開こうとしても失敗する
    const forged: EncryptedEnvelope = {
      ...env,
      recipients: [{ ...env.recipients[0]!, device_key_id: c.keyId }],
    };
    expect(open(forged, c)).rejects.toThrow();
  });

  test("ciphertext 改竄で復号失敗", async () => {
    const a = await generateDeviceKeyPair();
    const env = await seal(text("tamper me"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
    ]);
    const bytes = Buffer.from(env.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...env, ciphertext: bytes.toString("base64url") };
    expect(open(tampered, a)).rejects.toThrow();
  });

  test("未知 version は拒否", async () => {
    const a = await generateDeviceKeyPair();
    const env = await seal(text("v?"), [{ keyId: a.keyId, publicJwk: a.publicJwk }]);
    const future = { ...env, v: 2 as unknown as 1 };
    expect(open(future, a)).rejects.toThrow("unsupported envelope version");
  });

  test("宛先ゼロは seal 不可", () => {
    expect(seal(text("x"), [])).rejects.toThrow("at least one recipient");
  });
});

describe("鍵委譲 addRecipient(Account Recovery — AC-1 / PBI-0010)", () => {
  test("A 宛の既存 envelope から B 用 recipient entry を作ると、B の鍵で復号できる。ciphertext/iv は不変", async () => {
    const a = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    const env = await seal(text("過去のメッセージ"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
    ]);
    const newEntry = await addRecipient(env, a, { keyId: b.keyId, publicJwk: b.publicJwk });
    expect(newEntry.device_key_id).toBe(b.keyId);

    const delegated: EncryptedEnvelope = {
      ...env,
      recipients: [...env.recipients, newEntry],
    };
    expect(delegated.iv).toBe(env.iv);
    expect(delegated.ciphertext).toBe(env.ciphertext);
    expect(fromBytes(await open(delegated, b))).toBe("過去のメッセージ");
    // A も引き続き復号できる(既存 recipient entry は変更していない)
    expect(fromBytes(await open(delegated, a))).toBe("過去のメッセージ");
  });

  test("委譲元でない device(recipient でない)から addRecipient すると失敗する", async () => {
    const a = await generateDeviceKeyPair();
    const c = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    const env = await seal(text("secret"), [{ keyId: a.keyId, publicJwk: a.publicJwk }]);
    expect(addRecipient(env, c, { keyId: b.keyId, publicJwk: b.publicJwk })).rejects.toThrow(
      "not a recipient",
    );
  });

  test("未知 version の envelope からは委譲できない", async () => {
    const a = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    const env = await seal(text("v?"), [{ keyId: a.keyId, publicJwk: a.publicJwk }]);
    const future = { ...env, v: 2 as unknown as 1 };
    expect(addRecipient(future, a, { keyId: b.keyId, publicJwk: b.publicJwk })).rejects.toThrow(
      "unsupported envelope version",
    );
  });
});

// PBI-0074 / W13: 添付の 1 回鍵 AEAD(FileRef.key で運ぶ)
test("encryptFileBytes → decryptFileBytes の roundtrip(異なる key では開かない)", async () => {
  const plain = new TextEncoder().encode("添付の中身 attachment body");
  const enc = await encryptFileBytes(plain);
  expect(enc.ciphertext.byteLength).toBeGreaterThan(plain.byteLength); // GCM tag 分
  const restored = await decryptFileBytes(enc.ciphertext, enc.keyB64);
  expect(new TextDecoder().decode(restored)).toBe("添付の中身 attachment body");
  const other = await encryptFileBytes(plain);
  let failed = false;
  try {
    await decryptFileBytes(enc.ciphertext, other.keyB64);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
});
