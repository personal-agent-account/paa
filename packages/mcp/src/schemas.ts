import { z } from "zod";

// server.ts の各 tool 登録で使う zod shape。副作用(credential 解決・process.exit・stdio connect)を
// 一切持たない純粋な定義だけをここに置き、server.ts とテストの双方から import する。
// こうしておくことで「schema と実装(SendInput/pickContent)のドリフト」をテストで機械検査できる。

export const fileRefShape = z.object({
  name: z.string(),
  ref: z.string(),
  size: z.number().optional(),
  mime: z.string().optional(),
});

export const sendInputShape = {
  to: z.string().describe("@handle"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("already_handled の thread へ強制送信"),
};
