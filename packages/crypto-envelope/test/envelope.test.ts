import { describe, expect, test } from "bun:test";
import {
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
