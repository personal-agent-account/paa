#!/usr/bin/env bun
// paa-mask CLI(PBI-0177)。
//   paa-mask -- <MCP server の command と args>   … proxy として起動
//   paa-mask --dry-run < text                     … 何が伏せられるか確認(stdin → stdout)
//
// **stdout には JSON-RPC 行(または --dry-run の結果)以外を絶対に書かない** — proxy 経路は
// MCP の stdio 面そのもので、1 行でも混ぜると親の handshake が壊れる。案内・エラーは全部 stderr。

import { dryRunMask, loadConfig, secretsPath } from "./masking.ts";
import { runProxy } from "./proxy.ts";

function usage(): string {
  return [
    "paa-mask -- <command> [args...]   任意の MCP server の前段に立つ proxy として起動",
    "paa-mask --dry-run                stdin の文字列に対し、何が伏せられるかを stdout に出す",
    "",
    `secrets file: ${secretsPath()} (0600 必須。無ければ mask 無しで動く)`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--dry-run")) {
    const text = await Bun.stdin.text();
    let config;
    try {
      config = loadConfig();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    console.log(dryRunMask(text, config));
    return 0;
  }

  // bun は `paa-mask -- foo bar` の `--` 自体を process.argv から取り除く(bun 自身の CLI 引数と
  // script 引数を区切る記法として消費される — 実測済み)。よって argv には既に子 command だけが
  // 残っている前提で良い(`--` を探して分割する必要が無い。子 command が独自に `--` を含む場合も
  // そのまま args へ渡る)
  const [command, ...childArgs] = argv;
  if (!command) {
    console.error("使い方:\n" + usage());
    return 2;
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  try {
    const handle = runProxy(
      {
        parentIn: Bun.stdin.stream(),
        parentOut: { write: (s) => process.stdout.write(s) },
        spawnChild: () => {
          const proc = Bun.spawn({
            cmd: [command, ...childArgs],
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
          });
          return { stdin: proc.stdin, stdout: proc.stdout, exited: proc.exited };
        },
      },
      config,
    );
    return await handle.exited;
  } catch (e) {
    console.error(`子 command を起動できません: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
