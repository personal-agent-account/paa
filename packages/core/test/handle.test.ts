import { describe, expect, test } from "bun:test";
import { normalizeHandle, validateHandle } from "../src/handle.ts";

describe("normalizeHandle", () => {
  test("trim + 先頭@除去 + 小文字化", () => {
    expect(normalizeHandle(" @Aya ")).toBe("aya");
    expect(normalizeHandle("@@AYA")).toBe("aya");
  });
  test("冪等", () => {
    for (const input of [" @Aya ", "aya_01", "@X_9"]) {
      const once = normalizeHandle(input);
      expect(normalizeHandle(once)).toBe(once);
    }
  });
});

describe("validateHandle", () => {
  test("正常系", () => {
    expect(validateHandle("aya_01")).toEqual({ ok: true, handle: "aya_01" });
    expect(validateHandle(" @AYA ")).toEqual({ ok: true, handle: "aya" });
  });
  test("境界: 3 字と 30 字は ok、2 字と 31 字は ng", () => {
    expect(validateHandle("abc").ok).toBe(true);
    expect(validateHandle("a".repeat(30)).ok).toBe(true);
    expect(validateHandle("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateHandle("")).toEqual({ ok: false, reason: "too_short" });
    expect(validateHandle("a".repeat(31))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
  test("charset: 先頭は a-z、本体は a-z0-9_", () => {
    expect(validateHandle("1aya")).toEqual({ ok: false, reason: "invalid_start" });
    expect(validateHandle("_aya")).toEqual({ ok: false, reason: "invalid_start" });
    expect(validateHandle("aya-x")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validateHandle("aya.x")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validateHandle("あやか")).toEqual({ ok: false, reason: "invalid_start" });
  });
  test("予約語(RFC 2142 系含む)", () => {
    for (const h of ["postmaster", "admin", "abuse", "PAA"]) {
      expect(validateHandle(h)).toEqual({ ok: false, reason: "reserved" });
    }
  });
});
