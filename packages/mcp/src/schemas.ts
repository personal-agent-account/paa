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

// 自然言語 rule(EP-0013 W4 / REQ-54)。runtime が owner の言葉を JSON に compile して渡す。
// server が layer(metadata / content)を導出し、正規化済み rule を応答として返す ——
// それを owner に 1 文で echo する(REQ-54「解釈を同一 thread で返す」)のが runtime の仕事。
// 同じ nl の再 put は更新になる(rule は増えない)
export const rulesPutInputShape = {
  nl: z.string().describe("owner の言葉の原文(例: newsletter は毎朝 9 時にまとめて)"),
  scope: z
    .object({
      source_kind: z.enum(["mail", "paa", "webhook", "android", "windows", "macos", "ios", "digest"]).optional(),
      app_id: z.string().optional().describe("発生源 app(例: com.example.app)。ここで指定した語は metadata として平文保存される"),
      time_window: z.string().optional(),
      sender: z.string().optional().describe("本文・送信者の語。指定すると content rule になり server には暗号化されて保存される"),
      keywords: z.array(z.string()).optional().describe("本文の語。指定すると content rule になる"),
    })
    .optional(),
  action: z.object({
    type: z.enum(["immediate", "digest", "discard", "cloud_visibility"]),
    schedule: z.string().optional().describe("digest 用「HH:MM」(例: 09:00)"),
    tz: z.string().optional().describe("digest 用 IANA tz(例: Asia/Tokyo。既定 UTC)"),
    visibility: z.enum(["full", "masked", "local_only", "none"]).optional().describe("cloud_visibility 用"),
  }),
};
