#!/usr/bin/env bun
// plugin(.mcp.json)から起動される launcher。実体は packages/mcp の MCP server。
//
// marketplace install は marketplace repo を clone するだけで node_modules を持たない
// (node_modules は .gitignore 済み)。そのままでは依存が解決できず起動しないので、
// 解決に失敗した時だけ repo root の bun install を撃つ。
// node_modules の置き場所は package manager の layout 次第(bun は node_modules/.bun に
// 実体を置き workspace 側へ symlink する)なので、場所を当てにいかず import の失敗で判定する。
// Bun は解決結果を process 内に持つため、install 後は同じ process で読み直せない ——
// 新しい process で本体を起動し、stdio をそのまま渡して終了コードを引き継ぐ。
//
// stdout は MCP の stdio transport が占有している —— install の出力を 1 byte も混ぜない。
import { fileURLToPath } from "node:url";

const repoRootUrl = new URL("../../../", import.meta.url);
const serverEntry = new URL("packages/mcp/src/server.ts", repoRootUrl);

const isMissingModule = (e: unknown): boolean =>
  /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/.test(
    e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e),
  );

try {
  await import(serverEntry.href);
} catch (e) {
  if (!isMissingModule(e)) throw e;
  const repoRoot = fileURLToPath(repoRootUrl);
  process.stderr.write(`paa: 依存が未取得です。${repoRoot} で bun install を実行します...\n`);
  const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stderr.write(new TextDecoder().decode(install.stderr));
  if (!install.success) {
    process.stderr.write(
      `paa: bun install に失敗しました。'cd ${repoRoot} && bun install' を手で実行してください\n`,
    );
    process.exit(1);
  }
  const child = Bun.spawn(["bun", fileURLToPath(serverEntry)], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  process.exit(await child.exited);
}
