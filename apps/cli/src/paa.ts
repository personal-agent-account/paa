#!/usr/bin/env bun
import {
  apiCall,
  DEFAULT_BASE_URL,
  doctorRuntime,
  fetchBrief,
  formatBrief,
  installRuntime,
  loadCredentials,
  pairRuntime,
  reconcile,
  uninstallRuntime,
  type AdapterContext,
  type Finding,
  type PairPrompt,
  type RuntimeAdapter,
} from "@paa/adapter";
import { hostname } from "node:os";
import { ADAPTERS, findAdapter, SUPPORTED_IDS } from "./registry.ts";

// paa —— Personal Agent Account の入口(配布戦略 §7.2 Common Installation Engine の CLI 面)。
// plugin-first UX でもここを通るので、pairing / install / 診断のロジックは 1 系統。

const USAGE = `paa —— Personal Agent Account

使い方: repo 直下で  bun run paa <command>
        (どこからでも paa で呼びたい場合: cd apps/cli && bun link)

  install <runtime>     runtime を pair して MCP server を登録する
  uninstall <runtime>   MCP 登録とローカル credential を消す
  pair <runtime>        pairing のみ行う
  status                attach 先と未読の要約を出す (本文は出さない)
  doctor [runtime]      接続状態を診断する
  runtimes              対応 runtime と接続状態の一覧
  extensions            desired extension 一覧 + runtime 別 status
  sync [runtime]        Extension Sync を実行する(runtime 省略時は接続済み全部)

  --url <base-url>      Account API (既定: $PAA_URL または ${DEFAULT_BASE_URL})
  --repair              install 時に credential を作り直す
  --dry-run             sync 時、plan を出すだけで native/DB に書き込まない

対応 runtime: ${SUPPORTED_IDS.join(", ")}`;

const ctx: AdapterContext = { env: process.env };

/**
 * 明示された Account API の URL。指定が無ければ undefined を返す ——
 * ここで既定値に潰すと install 側が「既存 credential と違う server を指された」と誤認し、
 * リモートに pair 済みの人の credential を localhost へ張り替えてしまう
 */
function baseUrlOf(args: string[]): string | undefined {
  const i = args.indexOf("--url");
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return process.env.PAA_URL;
}

function showPrompt(prompt: PairPrompt): void {
  console.log(`
  1. browser で開く: ${prompt.verification_uri_complete}
  2. code: ${prompt.user_code}
  3. Account 側で「承認」を押す (${Math.round(prompt.expires_in / 60)} 分以内)

  承認を待っています...`);
}

function printFindings(findings: Finding[]): boolean {
  for (const f of findings) console.log(`  ${f.ok ? "OK " : "NG "} ${f.label}: ${f.detail}`);
  return findings.every((f) => f.ok);
}

function requireAdapter(id: string | undefined) {
  if (!id) fail(`runtime を指定してください (${SUPPORTED_IDS.join(", ")})`);
  const adapter = findAdapter(id);
  if (!adapter) {
    fail(`未対応の runtime: ${id}\n対応: ${SUPPORTED_IDS.join(", ")}`);
  }
  return adapter;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const baseUrl = baseUrlOf(args);

switch (command) {
  case "install": {
    const adapter = requireAdapter(target);
    const outcome = await installRuntime({
      adapter,
      ctx,
      baseUrl,
      onPrompt: showPrompt,
      repair: args.includes("--repair"),
    });
    if (outcome.status === "runtime_not_found") fail(`NG ${outcome.detail}`);
    if (outcome.status === "denied") fail("NG pairing が拒否されました");
    if (outcome.status === "expired") fail("NG pairing が期限切れです。もう一度実行してください");
    if (outcome.status === "failed") fail(`NG pairing に失敗しました: ${outcome.detail}`);
    console.log(
      `\n${adapter.displayName} を ${outcome.credential.name} として接続しました${
        outcome.paired ? "" : " (既存 credential を再利用)"
      }`,
    );
    if (!printFindings(outcome.findings)) process.exit(1);
    console.log(`\n${adapter.displayName} を再起動すると @account の tool が使えます`);
    break;
  }

  case "uninstall": {
    const adapter = requireAdapter(target);
    const outcome = await uninstallRuntime({ adapter, ctx, baseUrl });
    console.log(
      `${adapter.displayName}: MCP 登録 ${outcome.unregistered ? "削除" : "削除できず"} / ` +
        `credential ${outcome.credentialRemoved ? "削除" : "無し"}`,
    );
    // 「未登録だった」と「CLI が壊れていて消せなかった」を混ぜない
    if (outcome.detail) console.log(`  理由: ${outcome.detail}`);
    console.log("Cloud 側の接続解除は web の Settings → Connected runtimes から行ってください");
    break;
  }

  case "pair": {
    const adapter = requireAdapter(target);
    const outcome = await pairRuntime({
      baseUrl: baseUrl ?? DEFAULT_BASE_URL,
      kind: adapter.id,
      name: `${hostname()} / ${adapter.displayName}`,
      onPrompt: showPrompt,
    });
    if (outcome.status === "denied") fail("NG pairing が拒否されました");
    if (outcome.status === "expired") fail("NG pairing が期限切れです");
    if (outcome.status === "failed") fail(`NG pairing に失敗しました: ${outcome.detail}`);
    console.log(`\n接続しました: ${outcome.credential.name} (${outcome.credential.runtime_id})`);
    break;
  }

  case "status": {
    const credentials = (await loadCredentials()).runtimes;
    const entries = Object.entries(credentials);
    if (entries.length === 0) {
      fail(`未接続です。'bun run paa install ${SUPPORTED_IDS[0]}' から始めてください`);
    }
    for (const [kind, credential] of entries) {
      const adapter = findAdapter(kind);
      console.log(`\n[${adapter?.displayName ?? kind}] ${credential.name}`);
      try {
        // 要件 §19: session 開始時に見せるのは metadata のみ(本文は出さない)
        console.log(formatBrief(await fetchBrief(credential.base_url, credential.token)));
      } catch (e) {
        console.log(`  NG ${(e as Error).message}`);
      }
    }
    break;
  }

  case "doctor": {
    let ok = true;
    for (const adapter of target ? [requireAdapter(target)] : ADAPTERS) {
      console.log(`\n[${adapter.displayName}]`);
      ok = printFindings(await doctorRuntime({ adapter, ctx, baseUrl })) && ok;
    }
    if (!ok) process.exit(1);
    break;
  }

  case "runtimes": {
    const credentials = (await loadCredentials()).runtimes;
    for (const adapter of ADAPTERS) {
      const detected = await adapter.detect(ctx);
      const credential = credentials[adapter.id];
      console.log(
        `${adapter.id.padEnd(8)} ${adapter.displayName.padEnd(14)} ` +
          `${detected.installed ? "検出" : "未検出"} / ` +
          `${credential ? `接続済み (${credential.runtime_id})` : "未接続"}`,
      );
    }
    break;
  }

  case "extensions": {
    const credentials = (await loadCredentials()).runtimes;
    const entry = Object.values(credentials)[0];
    if (!entry) fail(`未接続です。'bun run paa install ${SUPPORTED_IDS[0]}' から始めてください`);
    const res = await apiCall(entry.base_url, "/v1/extensions", { token: entry.token });
    if (res.status !== 200) fail(`NG /v1/extensions が ${res.status} を返しました`);
    const list = res.body as any[];
    if (list.length === 0) {
      console.log("desired extension はまだ登録されていません");
      break;
    }
    for (const ext of list) {
      const status =
        (ext.materializations as any[])
          .map((m) => `${m.runtime_id}:${m.status}`)
          .join(", ") || "(未 sync)";
      const flags = [ext.enabled ? null : "disabled", ext.deleted_at ? "削除待ち" : null]
        .filter(Boolean)
        .join(",");
      console.log(
        `${ext.name.padEnd(16)} ${ext.kind.padEnd(8)} rev${ext.revision}` +
          `${flags ? ` [${flags}]` : ""} — ${status}`,
      );
    }
    break;
  }

  case "sync": {
    const dryRun = args.includes("--dry-run");
    const credentials = (await loadCredentials()).runtimes;
    const targets: RuntimeAdapter[] = target
      ? [requireAdapter(target)]
      : ADAPTERS.filter((a) => credentials[a.id]);
    if (targets.length === 0) {
      fail(`未接続です。'bun run paa install ${SUPPORTED_IDS[0]}' から始めてください`);
    }
    let anyFailed = false;
    for (const adapter of targets) {
      const credential = credentials[adapter.id];
      if (!credential) {
        console.log(`\n[${adapter.displayName}] 未接続。skip`);
        continue;
      }
      console.log(`\n[${adapter.displayName}]`);
      const result = await reconcile({
        adapter,
        ctx,
        baseUrl: credential.base_url,
        token: credential.token,
        runtimeId: credential.runtime_id,
        dryRun,
      });
      const acted = result.plan.filter((item) => item.action !== "noop");
      if (acted.length === 0) {
        console.log("  差分なし");
      }
      for (const item of acted) {
        console.log(`  ${item.action.padEnd(12)} ${item.name}`);
      }
      if (dryRun) {
        console.log("  (dry-run: 何も書き込んでいません)");
        continue;
      }
      for (const f of result.failed) {
        console.log(`  NG ${f.name}: ${f.detail}`);
      }
      if (result.failed.length > 0) anyFailed = true;
    }
    if (anyFailed) process.exit(1);
    break;
  }

  case "--help":
  case "help":
  case undefined:
    console.log(USAGE);
    break;

  default:
    fail(`不明な command: ${command}\n\n${USAGE}`);
}
