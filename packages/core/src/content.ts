// MVP の message content(要件 §9): text / file / URL のみ。独自 Task/Work object を作らない。
// envelope は Native E2EE(アーキ§9-11)の暗号化済み payload。plaintext と排他ではなく、
// E2EE 経路では text/files/urls の代わりに envelope だけが入る。

export interface FileRef {
  name: string;
  /** object storage 等への参照。内部 blob は `paa-file:<id>`(PBI-0074)。それ以外は URL 文字列 */
  ref: string;
  /**
   * 内部 blob の内容鍵(base64。crypto-envelope の encryptFileBytes が出す keyB64)。
   * FileRef ごと envelope 平文に seal される為、server には見えない(E2EE §9)
   */
  key?: string;
  size?: number;
  mime?: string;
}

export interface MessageContent {
  text?: string;
  files?: FileRef[];
  urls?: string[];
  /** crypto-envelope の EncryptedEnvelope(JSON)。運営側は復号できない */
  envelope?: unknown;
}

export function isEmptyContent(c: MessageContent): boolean {
  return (
    !c.text?.trim() &&
    !(c.files && c.files.length > 0) &&
    !(c.urls && c.urls.length > 0) &&
    c.envelope == null
  );
}

/** envelope の中に seal する平文の形(PBI-0006)。text/files/urls をそのまま JSON にするだけ */
export interface EnvelopePlaintext {
  text?: string;
  files?: FileRef[];
  urls?: string[];
}

export function toEnvelopePlaintext(c: MessageContent): EnvelopePlaintext {
  const p: EnvelopePlaintext = {};
  if (c.text !== undefined) p.text = c.text;
  if (c.files !== undefined) p.files = c.files;
  if (c.urls !== undefined) p.urls = c.urls;
  return p;
}

export function fromEnvelopePlaintext(p: EnvelopePlaintext): MessageContent {
  const c: MessageContent = {};
  if (p.text !== undefined) c.text = p.text;
  if (p.files !== undefined) c.files = p.files;
  if (p.urls !== undefined) c.urls = p.urls;
  return c;
}
