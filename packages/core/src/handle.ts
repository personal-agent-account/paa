// public handle の規則。判定順序は docs/diagrams.md 図2 と一致させる:
// normalize → 長さ → charset(先頭/本体) → 予約語。
// ASCII 限定で開始(未決: Unicode handle。狭→広は互換なので後から広げられる)。
// handle は email-compatible address の local-part にもなるため(アーキ§8)、
// 予約語には RFC 2142 の標準 mailbox 名を含める。

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "abuse",
  "admin",
  "administrator",
  "agent",
  "api",
  "contact",
  "hostmaster",
  "help",
  "info",
  "mail",
  "marketing",
  "mod",
  "moderator",
  "noc",
  "noreply",
  "no_reply",
  "official",
  "paa",
  "postmaster",
  "root",
  "sales",
  "security",
  "staff",
  "support",
  "system",
  "team",
  "webmaster",
  "www",
]);

export type HandleErrorReason =
  | "too_short"
  | "too_long"
  | "invalid_start"
  | "invalid_chars"
  | "reserved";

export type HandleResult =
  | { ok: true; handle: string }
  | { ok: false; reason: HandleErrorReason };

/** trim → 先頭の @ を除去 → 小文字化。冪等。 */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

export function validateHandle(input: string): HandleResult {
  const handle = normalizeHandle(input);
  if (handle.length < HANDLE_MIN) return { ok: false, reason: "too_short" };
  if (handle.length > HANDLE_MAX) return { ok: false, reason: "too_long" };
  if (!/^[a-z]/.test(handle)) return { ok: false, reason: "invalid_start" };
  if (!/^[a-z][a-z0-9_]*$/.test(handle))
    return { ok: false, reason: "invalid_chars" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  return { ok: true, handle };
}
