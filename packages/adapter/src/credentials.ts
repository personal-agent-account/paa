import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// pairing で得た runtime credential のローカル保管(要件 §15.2「API key の copy/paste を
// 標準 UX にしない」)。runtime kind ごとに 1 entry —— 1 runtime = 1 credential = 1 runtime_id
// (要件 §15.1)。単一 token にすると 2 つ目の pair が 1 つ目を上書きし、
// per-actor read state(§23.1)が 1 actor に潰れる。
//
// 書き込みは「1 file に複数 kind の map」なので read-modify-write になる。
// `atn install claude` と `atn install codex` は同時に走りうるため、load〜write を
// lock file で直列化し、temp file 名はプロセス固有にする(共有 temp 名だと後発の
// rename が ENOENT で落ち、先発の内容も失われる)。

export interface RuntimeCredential {
  runtime_id: string;
  token: string;
  base_url: string;
  /** §32.4 の "MacBook / Claude Code" 表示に使う */
  name: string;
  paired_at: string;
}

export interface CredentialFile {
  version: 1;
  runtimes: Record<string, RuntimeCredential>;
}

type Env = Record<string, string | undefined>;

/** lock 待ちの上限。超えたら「別プロセスが使用中」として明示的に失敗する */
const LOCK_TIMEOUT_MS = 5_000;
/** 保持者が死んで取り残された lock を壊すまでの経過時間 */
const LOCK_STALE_MS = 30_000;

export function paaHome(env: Env = process.env): string {
  return env.PAA_HOME ?? join(homedir(), ".atn");
}

export function credentialsPath(env: Env = process.env): string {
  return join(paaHome(env), "credentials.json");
}

export async function loadCredentials(env: Env = process.env): Promise<CredentialFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8")) as CredentialFile;
    if (parsed?.version !== 1 || typeof parsed.runtimes !== "object") {
      throw new Error(`unsupported credentials file: ${credentialsPath(env)}`);
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runtimes: {} };
    throw e;
  }
}

export async function getCredential(
  kind: string,
  env: Env = process.env,
): Promise<RuntimeCredential | undefined> {
  return (await loadCredentials(env)).runtimes[kind];
}

/** 既存 entry を保ったまま 1 kind を書き換える。file mode は 0600(他 user から読めない) */
export async function saveCredential(
  kind: string,
  credential: RuntimeCredential,
  env: Env = process.env,
): Promise<void> {
  await withCredentialLock(env, async () => {
    const file = await loadCredentials(env);
    file.runtimes[kind] = credential;
    await writeCredentials(file, env);
  });
}

export async function removeCredential(kind: string, env: Env = process.env): Promise<boolean> {
  return withCredentialLock(env, async () => {
    const file = await loadCredentials(env);
    if (!(kind in file.runtimes)) return false;
    delete file.runtimes[kind];
    await writeCredentials(file, env);
    return true;
  });
}

/** load〜write を直列化する。同時 install が互いの entry を消さないための唯一の砦 */
async function withCredentialLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      // wx = 既存なら EEXIST。これが lock の獲得そのもの
      await (await open(lockPath, "wx", 0o600)).close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lockPath)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The credential store is in use by another process: ${lockPath}\n` +
            "Wait for the other 'atn install' to finish, or delete the lock if it is stale",
        );
      }
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function writeCredentials(file: CredentialFile, env: Env): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 途中で落ちても壊れた JSON を残さないよう temp → rename。
  // temp 名はプロセス固有(共有名だと同時実行が互いの temp を上書きし rename が ENOENT)
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await chmod(path, 0o600);
}
