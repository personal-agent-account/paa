#!/usr/bin/env bun
// PAA Account tools の MCP server(stdio)。
// 使い方: PAA_TOKEN=par_xxx [PAA_URL=http://localhost:8787] bun packages/mcp/src/server.ts
// Claude Code 等の runtime はこれを MCP server として登録すると @handle として attach できる。

import { credentialsPath, getCredential } from "@paa/adapter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendInputShape } from "./schemas.ts";
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
});

const server = new McpServer({ name: "paa-account", version: "0.1.0" });

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
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
  async (input) => json(await tools.send(input)),
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

await server.connect(new StdioServerTransport());
