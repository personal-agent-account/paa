import {
  planReconciliation,
  type DesiredExtension,
  type MaterializationState,
  type PlanAction,
} from "@paa/core";
import { apiCall } from "./api.ts";
import type { AdapterContext, RuntimeAdapter } from "./contract.ts";

// Reconcile engine(PBI-0005)。Common Installation Engine(install.ts)と同じ場所に置く:
// desired を API から取得 → listExtensions で actual → planReconciliation → applyExtension
// を 1 件ずつ → noop 以外の結果を POST /v1/extensions/:id/status へ返す。
// credential_ref はここでローカル解決する(env:NAME → process.env.NAME)。secret は Account を
// 一度も通らない。1 件の失敗で全体を止めない(残りは適用し、失敗分だけ failed を報告する)。

type Env = Record<string, string | undefined>;

export interface ReconcileOptions {
  adapter: RuntimeAdapter;
  ctx: AdapterContext;
  baseUrl: string;
  /** 対象 runtime の credential token */
  token: string;
  runtimeId: string;
  /** plan だけ出して native/DB に一切書き込まない */
  dryRun?: boolean;
  /** credential_ref(env:NAME)解決用。既定は process.env */
  env?: Env;
}

export interface ReconcileItemResult {
  action: PlanAction["action"];
  name: string;
}

export interface ReconcileFailure {
  name: string;
  detail: string;
}

export interface ReconcileResult {
  plan: PlanAction[];
  applied: ReconcileItemResult[];
  failed: ReconcileFailure[];
}

interface DesiredWireMaterialization {
  runtime_id: string;
  status: string;
  applied_revision: number | null;
  detail: string | null;
}

interface DesiredWire {
  id: string;
  kind: DesiredExtension["kind"];
  name: string;
  spec: Record<string, unknown>;
  credential_ref: string | null;
  enabled: boolean;
  revision: number;
  deleted_at: string | null;
  materializations: DesiredWireMaterialization[];
}

async function reportStatus(
  options: ReconcileOptions,
  extensionId: string,
  body: { status: string; appliedRevision?: number | null; detail?: string },
): Promise<void> {
  await apiCall(options.baseUrl, `/v1/extensions/${extensionId}/status`, {
    token: options.token,
    method: "POST",
    body: {
      status: body.status,
      applied_revision: body.appliedRevision ?? null,
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
    },
  });
}

/** env:NAME 形式の credential_ref をローカル解決する。scheme は env: のみ対応(未決の問い) */
function resolveCredentialRef(
  ref: string | null,
  env: Env,
): { ok: true; env: Record<string, string> } | { ok: false; detail: string } {
  if (ref == null) return { ok: true, env: {} };
  const m = /^env:(.+)$/.exec(ref);
  if (!m) return { ok: false, detail: `未対応の credential_ref scheme です: ${ref}` };
  const name = m[1]!;
  const value = env[name];
  if (!value) return { ok: false, detail: `${ref} を解決できません` };
  return { ok: true, env: { [name]: value } };
}

function asStringRecord(v: unknown): Record<string, string> {
  if (v == null || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const env = options.env ?? process.env;
  const res = await apiCall<DesiredWire[]>(options.baseUrl, "/v1/extensions", {
    token: options.token,
  });
  if (res.status !== 200) {
    throw new Error(`GET /v1/extensions failed: ${res.status}`);
  }

  const desired: DesiredExtension[] = res.body.map((d) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    spec: d.spec,
    credentialRef: d.credential_ref,
    enabled: d.enabled,
    revision: d.revision,
    deletedAt: d.deleted_at,
  }));
  const materialized: MaterializationState[] = res.body.flatMap((d) =>
    d.materializations
      .filter((m) => m.runtime_id === options.runtimeId)
      .map((m) => ({
        extensionId: d.id,
        status: m.status as MaterializationState["status"],
        appliedRevision: m.applied_revision,
      })),
  );

  const listing = await options.adapter.listExtensions(options.ctx);
  const actual = listing.map((l) => l.name);

  const plan = planReconciliation({
    desired,
    materialized,
    actual,
    supportedKinds: options.adapter.extensionKinds,
  });

  if (options.dryRun) return { plan, applied: [], failed: [] };

  const applied: ReconcileItemResult[] = [];
  const failed: ReconcileFailure[] = [];

  for (const item of plan) {
    if (item.action === "noop") continue;

    if (item.action === "unsupported") {
      await reportStatus(options, item.extensionId, { status: "unsupported", detail: item.detail });
      applied.push({ action: item.action, name: item.name });
      continue;
    }

    if (item.action === "uninstall" || item.action === "disable") {
      try {
        await options.adapter.applyExtension(options.ctx, { action: item.action, name: item.name });
        await reportStatus(options, item.extensionId, {
          status: item.action === "uninstall" ? "uninstalled" : "disabled",
        });
        applied.push({ action: item.action, name: item.name });
      } catch (e) {
        const detail = (e as Error).message;
        failed.push({ name: item.name, detail });
        await reportStatus(options, item.extensionId, { status: "failed", detail });
      }
      continue;
    }

    // install | update
    const resolved = resolveCredentialRef(item.credentialRef, env);
    if (!resolved.ok) {
      failed.push({ name: item.name, detail: resolved.detail });
      await reportStatus(options, item.extensionId, { status: "failed", detail: resolved.detail });
      continue;
    }
    try {
      await options.adapter.applyExtension(options.ctx, {
        action: item.action,
        name: item.name,
        kind: item.kind,
        spec: item.spec,
        env: { ...asStringRecord(item.spec.env), ...resolved.env },
      });
      await reportStatus(options, item.extensionId, {
        status: "applied",
        appliedRevision: item.revision,
      });
      applied.push({ action: item.action, name: item.name });
    } catch (e) {
      const detail = (e as Error).message;
      failed.push({ name: item.name, detail });
      await reportStatus(options, item.extensionId, { status: "failed", detail });
    }
  }

  return { plan, applied, failed };
}
