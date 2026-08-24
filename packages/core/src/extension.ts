// Account-scoped Extension Sync(PBI-0005)の pure domain。
// 判定順序は docs/diagrams.md 図8 と一致させる(diagrams-check.sh が検査):
// 1. kind が runtime の supportedKinds に無い → unsupported(ただし deleted_at 有りなら
//    2 と同じ扱いで uninstall/noop、既に unsupported 記録済みなら再送せず noop — 冪等性)
// 2. deleted_at あり → materialization 行が有る時だけ uninstall(無ければ noop)
// 3. enabled=false → disable(既に disabled 記録済みなら noop — 冪等性)
// 4. native(actual)に無い → install
// 5. applied_revision < revision → update
// 6. それ以外 → noop
// 7. native に有るが desired にも materialization にも無い → noop。絶対に uninstall しない

export type ExtensionKind = "mcp" | "skill" | "plugin";
export type MaterializationStatus = "applied" | "disabled" | "unsupported" | "failed";

/** PAA 自身の MCP server 名。desired extension として登録させると自分の登録を張り替えてしまう */
export const RESERVED_EXTENSION_NAMES = ["paa"] as const;

export interface DesiredExtension {
  id: string;
  kind: ExtensionKind;
  name: string;
  spec: Record<string, unknown>;
  credentialRef: string | null;
  enabled: boolean;
  revision: number;
  /** null でなければ soft delete 済み(値そのものは判定に使わない) */
  deletedAt: string | null;
}

export interface MaterializationState {
  extensionId: string;
  status: MaterializationStatus;
  appliedRevision: number | null;
}

export type PlanAction =
  | { action: "unsupported"; extensionId: string; name: string; kind: ExtensionKind; detail: string }
  | { action: "uninstall"; extensionId: string; name: string }
  | { action: "disable"; extensionId: string; name: string }
  | {
      action: "install" | "update";
      extensionId: string;
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      credentialRef: string | null;
      revision: number;
    }
  | { action: "noop"; extensionId?: string; name: string };

export interface PlanReconciliationInput {
  desired: DesiredExtension[];
  /** 呼び出し側 runtime 1 台分の materialization のみ */
  materialized: MaterializationState[];
  /** native に実在する extension 名(呼び出し側 runtime の listExtensions 結果) */
  actual: string[];
  supportedKinds: ExtensionKind[];
}

/** soft delete 済み desired extension の扱い(unsupported/対応 kind 共通): 行が有れば uninstall、無ければ noop */
function planDeletion(ext: DesiredExtension, mat: MaterializationState | undefined): PlanAction {
  return mat
    ? { action: "uninstall", extensionId: ext.id, name: ext.name }
    : { action: "noop", extensionId: ext.id, name: ext.name };
}

export function planReconciliation(input: PlanReconciliationInput): PlanAction[] {
  const materializedByExt = new Map(input.materialized.map((m) => [m.extensionId, m]));
  const actualNames = new Set(input.actual);
  const desiredNames = new Set(input.desired.map((d) => d.name));
  const actions: PlanAction[] = [];

  for (const ext of input.desired) {
    const mat = materializedByExt.get(ext.id);

    if (!input.supportedKinds.includes(ext.kind)) {
      // 未対応 kind でも soft delete されたら desired 行を消す経路(uninstall)に乗せる —
      // ここで noop 固定にすると、native には何も無いのに materialization 行と desired 行が
      // 永遠に残り続ける(purge に一度も到達しない)
      if (ext.deletedAt != null) {
        actions.push(planDeletion(ext, mat));
        continue;
      }
      // 既に unsupported として記録済みなら再送しない — 3 段目(disable)と同じ冪等性ガード。
      // 無いと desired に plugin/skill が 1 件でもある限り毎 sync で status を送り直し、
      // extension_materializations.updated_at が無意味に更新され続ける
      if (mat?.status === "unsupported") {
        actions.push({ action: "noop", extensionId: ext.id, name: ext.name });
        continue;
      }
      actions.push({
        action: "unsupported",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        detail: `kind "${ext.kind}" はこの runtime では未対応です`,
      });
      continue;
    }
    if (ext.deletedAt != null) {
      actions.push(planDeletion(ext, mat));
      continue;
    }
    if (!ext.enabled) {
      // 既に disabled で記録済みなら再送しない — noop で status を送らないのが冪等性の実体
      // (送ると updated_at が無意味に更新され「差分が無い」が DB 上で観測できなくなる)
      actions.push(
        mat?.status === "disabled"
          ? { action: "noop", extensionId: ext.id, name: ext.name }
          : { action: "disable", extensionId: ext.id, name: ext.name },
      );
      continue;
    }
    if (!actualNames.has(ext.name)) {
      actions.push({
        action: "install",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        spec: ext.spec,
        credentialRef: ext.credentialRef,
        revision: ext.revision,
      });
      continue;
    }
    if ((mat?.appliedRevision ?? 0) < ext.revision) {
      actions.push({
        action: "update",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        spec: ext.spec,
        credentialRef: ext.credentialRef,
        revision: ext.revision,
      });
      continue;
    }
    actions.push({ action: "noop", extensionId: ext.id, name: ext.name });
  }

  // 7: native に有るが desired に無い extension(人が手で入れた物・paa MCP server 自身)は
  // 絶対に uninstall しない。noop として明示する(黙って除外すると不変条件が検査できない)
  for (const name of actualNames) {
    if (desiredNames.has(name)) continue;
    actions.push({ action: "noop", name });
  }

  return actions;
}

const CREDENTIAL_LIKE_KEYS = ["token", "apikey", "password", "secret", "authorization"];

/** key を正規化(小文字化 + `_`/`-` 除去)してから比較する。api_key も apiKey も同じ扱いにするため */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function findCredentialLikeKey(value: unknown, path = ""): string | null {
  if (value == null || typeof value !== "object") return null;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (
      typeof v === "string" &&
      v.length > 0 &&
      CREDENTIAL_LIKE_KEYS.some((bad) => normalizeKey(key).includes(bad))
    ) {
      return here;
    }
    if (v != null && typeof v === "object") {
      const nested = findCredentialLikeKey(v, here);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * spec の中に生 credential(token / api_key / password / secret / authorization を key に持つ
 * 非空文字列)が有れば拒否する。アーキ §14「Credentials are referenced, not copied」の強制点。
 */
export function validateExtensionSpec(
  spec: Record<string, unknown>,
): { ok: true } | { ok: false; key: string } {
  const found = findCredentialLikeKey(spec);
  return found ? { ok: false, key: found } : { ok: true };
}
