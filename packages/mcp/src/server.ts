#!/usr/bin/env bun
// PAA Account tools の MCP server(stdio)。
// 使い方: PAA_TOKEN=par_xxx [PAA_URL=http://localhost:8787] bun packages/mcp/src/server.ts
// Claude Code 等の runtime はこれを MCP server として登録すると @handle として attach できる。

import { credentialsPath, getCredential } from "@paa/adapter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSecrets, maskValue, restoreText } from "atn-mask";
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
    `No All Together Now credential was found (PAA_RUNTIME_KIND=${kind ?? "unset"}, ${credentialsPath()})\n` +
      "Run 'atn install claude' / 'atn install codex' to pair this runtime first",
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

// secret masking(REQ-69)。~/.atn/secrets.json が在れば tool 応答の文字列値を `⟨s:n⟩` に置き換え、
// send / reply の text だけ復元する。0600 以外の file は起動を拒否する(fail-closed)
let secrets: string[];
try {
  secrets = loadSecrets();
} catch (e) {
  console.error(`Could not read secrets.json: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const server = new McpServer({ name: "atn-account", version: "0.2.0" });

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(maskValue(v, secrets), null, 2) }],
});

server.tool(
  "whoami",
  "Identity of the attached agent account and its unread count",
  {},
  async () => json(await tools.whoami()),
);

server.tool(
  "inbox_list",
  "List received messages (metadata only, no bodies). Use inbox_read for the body",
  {},
  async () => json(await tools.inbox_list()),
);

server.tool(
  "inbox_read",
  "Read a message body by message_id",
  { message_id: z.string() },
  async ({ message_id }) => json(await tools.inbox_read(message_id)),
);

server.tool(
  "send",
  "Send a message to an @handle. The delegation policy may put it in pending_approval",
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
  "Reply in a thread inside your own account (the thread shared with the owner — where owner instructions are reported back)",
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
  "Who this account can talk to. runtimes = runtimes of the same account (name / kind / is_default / live = whether a wake reaches it now); contacts = addresses (pass address straight to send's to). The other account's liveness is never returned (by design)",
  {},
  async () => json(await tools.agents_list()),
);

server.tool("contacts_list", "List contacts", {}, async () =>
  json(await tools.contacts_list()),
);

server.tool(
  "contacts_get",
  "Get one contact",
  { contact_id: z.string() },
  async ({ contact_id }) => json(await tools.contacts_get(contact_id)),
);

server.tool(
  "mark_read",
  "Mark a message as read (only this runtime's read state changes)",
  { message_id: z.string() },
  async ({ message_id }) => json(await tools.mark_read(message_id)),
);

server.tool(
  "approval_get",
  "Status of an approval you raised (a send/reply awaiting approval): pending / approved / rejected. Content is not included",
  { approval_id: z.string() },
  async ({ approval_id }) => json(await tools.approval_get(approval_id)),
);

server.tool(
  "notification_label",
  "Put a triage label on a notification item (action = needs handling / fyi = for information / discard = not needed). The summary is sealed with the device key before sending",
  labelInputShape,
  async ({ message_id, label, summary }) =>
    json(await tools.notification_label(message_id, label, summary)),
);

server.tool(
  "rules_put",
  "Save how the owner asked to handle things as a rule (nl = their words verbatim, scope = what it applies to, action = what to do). The server normalizes it, picks the layer (metadata / content) and returns the normalized rule — echo it back to the owner in one sentence. Putting the same nl again updates in place (no duplicate rules). sender / keywords in scope make it a content rule, stored encrypted on the server",
  rulesPutInputShape,
  async (input) => json(await tools.rules_put(input)),
);

server.tool(
  "rules_list",
  "List saved rules. The scope of content rules is restored with the device key",
  {},
  async () => json(await tools.rules_list()),
);

await server.connect(new StdioServerTransport());
