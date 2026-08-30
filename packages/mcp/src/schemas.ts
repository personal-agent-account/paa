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

export const replyInputShape = {
  thread_id: z.string().describe("返信先の thread id(owner との共有 thread 含む)"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("already_handled の thread へ強制送信"),
  refs: z
    .array(z.string())
    .optional()
    .describe("処理した notification item の id(§18。owner instruction thread への報告で参照先を done にする)"),
};

// triage(EP-0013 W3)の label 付け。MCP からは "none" を見せない(label 無し状態への復帰は
// human の web UI / API が担う — triage agent が未処理に戻す経路は作らない)。
export const labelInputShape = {
  message_id: z.string().describe("notification item の message id"),
  label: z.enum(["action", "fyi", "discard"]).describe("action=要対応 / fyi=参考 / discard=不要"),
  summary: z
    .string()
    .optional()
    .describe("短い要約(140 字以内推奨)。MCP が device 鍵で seal してから送る"),
};
