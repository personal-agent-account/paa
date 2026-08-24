import type { RuntimeAdapter } from "@paa/adapter";
import { claudeAdapter } from "@paa/adapter-claude";
import { codexAdapter } from "@paa/adapter-codex";

// official adapter の一覧(配布戦略 §8)。community adapter はここへ 1 行足せば載る。
export const ADAPTERS: RuntimeAdapter[] = [claudeAdapter, codexAdapter];

export function findAdapter(id: string): RuntimeAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id.toLowerCase());
}

export const SUPPORTED_IDS = ADAPTERS.map((a) => a.id);
