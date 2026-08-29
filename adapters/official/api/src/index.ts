import {
  getCredential,
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type DetectResult,
  type ExtensionApplyAction,
  type ExtensionListing,
  type Finding,
  type RuntimeAdapter,
} from "@paa/adapter";

// 外部 API provider 用の official adapter(PBI-0070 / EP-0009 C)。
//
// 他の adapter と違い **native の設定ファイルを 1 つも持たない** —— この runtime の実体は
// 端末側の `paa agent <provider>`(PBI-0057)で、MCP server を登録する相手の CLI が存在しない。
// それでも adapter を置くのは、自動登録(図18)が kind ごとに `paa adopt` → `adapter.register` を
// 通す 1 本道だからで、ここに no-op の実装を置くことで「API runtime だけ登録経路が別」という
// 2 本目の道を作らずに済む。
//
// 3 provider は同じ手順で、違うのは id と表示名だけ —— factory 1 つで 3 つ作る(部品を 3 枚書かない)。

const PROVIDERS: { provider: string; displayName: string }[] = [
  { provider: "openai", displayName: "OpenAI (API)" },
  { provider: "gemini", displayName: "Gemini (API)" },
  { provider: "anthropic", displayName: "Anthropic (API)" },
];

export function apiProviderAdapter(provider: string, displayName: string): RuntimeAdapter {
  const id = `${provider}-api`;
  return {
    id,
    displayName,
    // wake は broker(launch_api)が担う。adapter 自身は pair / status だけ(他の official と同じ宣言)
    capabilities: STAGE0_CAPABILITIES,

    // 端末に binary は無い。registry 側の `detect.always` と同じ理由で常に present
    async detect(): Promise<DetectResult> {
      return { installed: true, detail: `${displayName} は端末側 runtime(paa agent)として常に利用できます` };
    },

    // 書くものが無い。credential は engine(install/adopt)が credentials.json へ保存済み
    async register(): Promise<void> {},
    async unregister(): Promise<void> {},

    async doctor(ctx: AdapterContext): Promise<Finding[]> {
      const credential = await getCredential(id, ctx.env);
      return [
        {
          ok: credential != null,
          label: `${displayName} の接続`,
          detail: credential
            ? `credential あり(${credential.base_url})。API key は Connections から resolve する`
            : "未接続。'bun run paa login' でこの Mac を接続してください",
        },
      ];
    },

    // MCP server を持たないので extension の materialize 対象にならない
    extensionKinds: [],
    async listExtensions(): Promise<ExtensionListing[]> {
      return [];
    },
    async applyExtension(_ctx: AdapterContext, _action: ExtensionApplyAction): Promise<void> {},
  };
}

export const apiAdapters: RuntimeAdapter[] = PROVIDERS.map((p) =>
  apiProviderAdapter(p.provider, p.displayName),
);
