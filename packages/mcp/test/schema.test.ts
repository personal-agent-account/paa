import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { sendInputShape } from "../src/schemas.ts";

// server.ts が実際に server.tool("send", ..., sendInputShape, ...) へ渡すのと同じ shape を
// ここで直接 import して検査する。contract.test.ts は tools.ts(HTTP 経由)しか通らないため、
// server.ts の zod schema が SendInput/pickContent から乖離しても検出できなかった(files 欠落の回帰)。

describe("MCP send tool の zod schema(packages/mcp/src/server.ts と同一の shape)", () => {
  test("files 添付を保持する(regression: files が schema に無いと silently drop される)", () => {
    const parsed = z.object(sendInputShape).parse({
      to: "@shibu",
      files: [{ name: "doc.pdf", ref: "blob://abc", size: 123, mime: "application/pdf" }],
    });
    expect(parsed.files).toEqual([
      { name: "doc.pdf", ref: "blob://abc", size: 123, mime: "application/pdf" },
    ]);
  });

  test("text だけの最小 payload も通る", () => {
    const parsed = z.object(sendInputShape).parse({ to: "@shibu", text: "hi" });
    expect(parsed.text).toBe("hi");
    expect(parsed.files).toBeUndefined();
  });
});
