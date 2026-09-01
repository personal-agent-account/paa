#!/usr/bin/env bun
// PAA Account tools の MCP server(stdio)。
// 使い方: PAA_TOKEN=par_xxx [PAA_URL=http://localhost:8787] bun packages/mcp/src/server.ts
// Claude Code 等の runtime はこれを MCP server として登録すると @handle として attach できる。

import { credentialsPath, getCredential } from "@paa/adapter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSecrets, maskValue, restoreText } from "./masking.ts";
import {
  labelInputShape,
  replyInputShape,
  rulesPutInputShape,
  sendInputShape,
} from "./schemas.ts";
import { createAccountTools } from "./tools.ts";

// credential は pairing で保存済みのものを使う(要件 §15.2: API key の copy/paste を標準 UX に
// しない)。PAA_RUNTIME_KIND が credential store の entry を選ぶ。PAA_TOKEN は手動/CI 用の逃げ道。
const kind = process.env.PAA_RUNTIME_KIND;
const stored = kind ? await getCredential(kind) : undefined;
const token = process.env.PAA_TOKEN ?? stored?.token;
if (!token) {
  console.error(
    `PAA credential が見つかりません (PAA_RUNTIME_KIND=${kind ?? "未設定"}, ${credentialsPath()})\n` +
      "PAA repo 直下で 'bun run paa install claude' / 'bun run paa install codex' を実行して pairing してください",
  );
  process.exit(1);
}
const tools = createAccountTools({
  baseUrl: process.env.PAA_URL ?? stored?.base_url ?? "http://localhost:8787",
  token,
  deviceKind: kind ?? "default",
  // triage session(EP-0013 W3)。broker が dedicated session の env に載せた scope token。
  // 普通に起動した session には無いので header も送られない = 全権のまま
  scopeToken: process.env.PAA_SESSION_SCOPE,
});

// secret masking(REQ-69)。~/.paa/secrets.json が在れば tool 応答の文字列値を `⟨s:n⟩` に置き換え、
// send / reply の text だけ復元する。0600 以外の file は起動を拒否する(fail-closed)
let secrets: string[];
try {
  secrets = loadSecrets();
} catch (e) {
  console.error(`secrets.json を読めません: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const server = new McpServer({ name: "paa-account", version: "0.1.0" });

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(maskValue(v, secrets), null, 2) }],
});

server.tool(
  "whoami",
  "attach している Agent Account の identity と未読数を返す",
  {},
  async () => json(await tools.whoami()),
);

server.tool(
  "inbox_list",
  "受信 message の metadata 一覧(本文なし)。本文は inbox_read で取得する",
  {},
  async () => json(await tools.inbox_list()),
);

server.tool(
  "inbox_read",
  "message_id を指定して本文を読む",
  { message_id: z.string() },
  async ({ message_id }) => json(await tools.inbox_read(message_id)),
);

server.tool(
  "send",
  "@handle 宛に message を送る。delegation policy により承認待ち(pending_approval)になることがある",
  sendInputShape,
  // text だけ mask の逆変換(restore)。agent が通知から credential を引用して送れるようにする為
  async (input) =>
    json(
      await tools.send({
        ...input,
        text: input.text !== undefined ? restoreText(input.text, secrets) : undefined,
      }),
    ),
);

server.tool(
  "reply",
  "自分の Account 内の thread に返信する(owner との共有 thread。owner instruction の結果報告先)",
  replyInputShape,
  async (input) =>
    json(
      await tools.reply({
        ...input,
        text: input.text !== undefined ? restoreText(input.text, secrets) : undefined,
      }),
    ),
);

server.tool(
  "agents_list",
  "この Account から話しかけられる相手の一覧。runtimes = 同じ Account の runtime(name / kind / is_default / live = 今 wake が届くか)、contacts = 宛先(address は send の to にそのまま渡せる)。相手 Account の稼働状態は返さない(設計上の非公開)",
  {},
  async () => json(await tools.agents_list()),
);

server.tool("contacts_list", "contacts 一覧", {}, async () =>
  json(await tools.contacts_list()),
);

server.tool(
  "contacts_get",
  "contact 1 件を取得",
  { contact_id: z.string() },
  async ({ contact_id }) => json(await tools.contacts_get(contact_id)),
);

server.tool(
  "mark_read",
  "message を既読にする(この runtime の read state のみ変わる)",
  { message_id: z.string() },
  async ({ message_id }) => json(await tools.mark_read(message_id)),
);

server.tool(
  "approval_get",
  "自分が起こした approval(send/reply の承認待ち)の状態を取得する。pending/approved/rejected。content は含まない",
  { approval_id: z.string() },
  async ({ approval_id }) => json(await tools.approval_get(approval_id)),
);

server.tool(
  "notification_label",
  "notification item に triage label を付ける(action=要対応 / fyi=参考 / discard=不要)。summary は device 鍵で seal して送る",
  labelInputShape,
  async ({ message_id, label, summary }) =>
    json(await tools.notification_label(message_id, label, summary)),
);

server.tool(
  "rules_put",
  "owner が言葉で頼んだ捌き方を rule として保存する(nl = 言葉の原文・scope = 対象・action = 捌き方)。server が正規化して layer(metadata / content)を決め、正規化済み rule を返す —— 返ってきた rule の内容を owner に 1 文で確認(echo)すること。同じ nl の再 put は上書き更新になる(rule は増えない)。sender / keywords を scope に入れると content rule になり server には暗号化されて保存される",
  rulesPutInputShape,
  async (input) => json(await tools.rules_put(input)),
);

server.tool(
  "rules_list",
  "保存済み rule の一覧。content rule の scope は device 鍵で復元して返す",
  {},
  async () => json(await tools.rules_list()),
);

await server.connect(new StdioServerTransport());
