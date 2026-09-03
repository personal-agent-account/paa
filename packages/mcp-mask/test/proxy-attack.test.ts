// レビュー攻撃 test(newway §12.2 (b)。PBI-0177 AC-X3 を破りに行く)。
// PBI の AC-X3: 「親が id 1〜20 を同時に送り子が順不同で返す → 各応答が自分の id の method に
// 従って mask される（result を取り違えない）」。既存 proxy.test.ts は実 subprocess(echo fixture)
// 越しの end-to-end だけで、fixture が同期応答する為に実際の順不同は起きていなかった
// (G2 の記載どおり「構造で担保。実測は AC-4/5 の subprocess test」— 出所は id 順を仮定していないかを
// 直接検査していなかった)。ここでは runProxy を直接呼び、子の応答順を完全に制御して検査する。
import { describe, expect, test } from "bun:test";
import { runProxy, type ProxyDeps } from "../src/proxy.ts";
import type { MaskConfig } from "../src/masking.ts";

function linesStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l + "\n"));
      controller.close();
    },
  });
}

describe("proxy attack: AC-X3 応答の順不同(id→method の対応を取り違えないか)", () => {
  test("id=2(初期化・非 mask 対象method)の応答が id=1(tools/call・mask 対象)より先に返っても、id ごとの method で正しく mask/非mask が分かれる", async () => {
    const config: MaskConfig = { secrets: ["TOPSECRET"], patterns: { email: false, phone: false, card: false, keys: false } };

    const req1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    const req2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });

    const parentOutLines: string[] = [];
    let childStdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const childStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        childStdoutController = controller;
      },
    });

    const deps: ProxyDeps = {
      parentIn: linesStream([req1, req2]),
      parentOut: { write: (s) => parentOutLines.push(s) },
      spawnChild: () => ({
        stdin: {
          write: () => 0,
          flush: () => 0,
          end: () => {
            // 親からの2 request を送り切った後、子は「初期化(id=2)を先に・tools/call(id=1)を後に」
            // 返す(実サーバでも起こり得る順不同 — 例: id=1 が重い処理で遅延する)。
            // 両方の result に同じ秘密文字列を混ぜ、method 別の mask 有無を判別可能にする
            childStdoutController!.enqueue(
              encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { note: "TOPSECRET-in-init" } }) + "\n"),
            );
            childStdoutController!.enqueue(
              encoder.encode(
                JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "TOPSECRET-in-call" }] } }) + "\n",
              ),
            );
            childStdoutController!.close();
            return 0;
          },
        },
        stdout: childStdout,
        exited: Promise.resolve(0),
      }),
    };

    runProxy(deps, config);
    // parentOut への書き込みが 2 行揃うまで待つ(non-blocking な async IIFE なので poll する)
    for (let i = 0; i < 100 && parentOutLines.length < 2; i++) await new Promise((r) => setTimeout(r, 5));

    expect(parentOutLines.length).toBe(2);
    const byId = new Map(parentOutLines.map((l) => JSON.parse(l)).map((m: any) => [m.id, m]));

    // id=2(initialize)は MASKED_METHODS 対象外 — 秘密文字列がそのまま残る
    expect(JSON.stringify(byId.get(2))).toContain("TOPSECRET-in-init");
    // id=1(tools/call)は mask 対象 — 秘密文字列が result から消え、placeholder に変わる
    const call1 = JSON.stringify(byId.get(1));
    expect(call1).not.toContain("TOPSECRET-in-call");
    expect(call1).toMatch(/⟨s:\d+⟩-in-call/);
  });
});
