import { describe, expect, test } from "bun:test";
import { generateAgentId, generateId, isAgentId } from "../src/id.ts";

describe("agent_id", () => {
  test("形式 agt_ + hex32 で毎回異なる", () => {
    const a = generateAgentId();
    const b = generateAgentId();
    expect(a).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(b).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(isAgentId(a)).toBe(true);
    expect(isAgentId("agt_xyz")).toBe(false);
    expect(isAgentId("acc_" + a.slice(4))).toBe(false);
  });

  test("UUIDv7 の時間順序性: 連続生成 1000 件が辞書順", () => {
    const ids = Array.from({ length: 1000 }, () => generateId("thr"));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
