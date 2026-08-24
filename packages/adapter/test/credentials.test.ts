import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  getCredential,
  loadCredentials,
  removeCredential,
  saveCredential,
  type RuntimeCredential,
} from "../src/credentials.ts";

// AC-1 / AC-2: credential は runtime kind ごとに保存され、2 つ目の pairing が 1 つ目を
// 上書きしない(1 runtime = 1 credential = 1 runtime_id — 要件 §15.1)。

const cred = (id: string): RuntimeCredential => ({
  runtime_id: `rt_${id}`,
  token: `par_${id}`,
  base_url: "http://localhost:8787",
  name: `MacBook / ${id}`,
  paired_at: new Date().toISOString(),
});

async function tempEnv() {
  return { PAA_HOME: await mkdtemp(join(tmpdir(), "paa-cred-")) };
}

describe("credential store", () => {
  test("未作成なら空、保存すると kind ごとに引ける", async () => {
    const env = await tempEnv();
    expect((await loadCredentials(env)).runtimes).toEqual({});

    await saveCredential("claude", cred("claude"), env);
    await saveCredential("codex", cred("codex"), env);

    const file = await loadCredentials(env);
    expect(Object.keys(file.runtimes).sort()).toEqual(["claude", "codex"]);
    expect((await getCredential("claude", env))?.runtime_id).toBe("rt_claude");
    expect((await getCredential("codex", env))?.token).toBe("par_codex");
    expect(await getCredential("hermes", env)).toBeUndefined();
  });

  test("同じ kind の再 pair は置き換え、別 kind は残る", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("a"), env);
    await saveCredential("codex", cred("codex"), env);
    await saveCredential("claude", cred("b"), env);

    const file = await loadCredentials(env);
    expect(file.runtimes.claude?.runtime_id).toBe("rt_b");
    expect(file.runtimes.codex?.runtime_id).toBe("rt_codex");
  });

  test("file mode は 0600(他 user から token を読めない)", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsPath(env), "utf8")).version).toBe(1);
  });

  test("remove は該当 kind だけ消す", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    await saveCredential("codex", cred("codex"), env);

    expect(await removeCredential("claude", env)).toBe(true);
    expect(await removeCredential("claude", env)).toBe(false);
    expect(Object.keys((await loadCredentials(env)).runtimes)).toEqual(["codex"]);
  });

  // ---- PBI-0004: 同時 install(claude と codex)で entry を落とさない ----

  test("AC-10: 同一プロセス内の並行 save が互いの entry を消さない", async () => {
    const env = await tempEnv();
    await Promise.all([
      saveCredential("claude", cred("claude"), env),
      saveCredential("codex", cred("codex"), env),
      saveCredential("hermes", cred("hermes"), env),
    ]);
    expect(Object.keys((await loadCredentials(env)).runtimes).sort()).toEqual([
      "claude",
      "codex",
      "hermes",
    ]);
  });

  test("AC-10/AC-11: 別プロセスの並行 save でも全 entry が残り、壊れた JSON にならない", async () => {
    const env = await tempEnv();
    const module = new URL("../src/credentials.ts", import.meta.url).href;
    const kinds = ["claude", "codex", "hermes", "aider"];
    const procs = kinds.map((kind) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { saveCredential } = await import(${JSON.stringify(module)});
           await saveCredential(${JSON.stringify(kind)}, {
             runtime_id: "rt_${kind}", token: "par_${kind}",
             base_url: "http://localhost:8787", name: ${JSON.stringify(kind)},
             paired_at: new Date().toISOString(),
           }, { PAA_HOME: ${JSON.stringify(env.PAA_HOME)} });`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(errs.join("")).toBe("");

    const file = await loadCredentials(env);
    expect(file.version).toBe(1);
    expect(Object.keys(file.runtimes).sort()).toEqual([...kinds].sort());
    // lock file を残さない(次の install が 5 秒待たされる)
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(env.PAA_HOME)).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 60_000);
});
