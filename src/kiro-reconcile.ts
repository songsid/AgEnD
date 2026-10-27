/** Confirmed option A only: keep the original carried session, preserve the named newer alternative. */
import type { KiroMigrateDeps } from "./kiro-migrate.js";
import { instanceCredentialProfile } from "./backend/credential-profile.js";
import { kiroV1DbPath, kiroV2SessionsDir } from "./backend/kiro.js";
import type { KiroReconcileInput, KiroReconcilePlan } from "./backend/kiro-reconcile-store.js";
import { t } from "./locale.js";
export interface KiroReconcileDeps extends KiroMigrateDeps {
  store(input: KiroReconcileInput, plan?: KiroReconcilePlan, actor?: string, rollbackReceipt?: string): Promise<{ plan?: KiroReconcilePlan; receipt?: string }>;
}
export interface KiroReconciliation { name: string; input: KiroReconcileInput; plan: KiroReconcilePlan }
function target(deps: KiroReconcileDeps, name: string, keep: string, archive: string): KiroReconcileInput {
  const fleet = deps.fleetConfig(), inst = fleet?.instances[name];
  if (!inst || (inst.backend ?? fleet?.defaults?.backend) !== "kiro-cli" || inst.kiro_ui !== "tui" || !inst.working_directory
    || !inst.model || !["stopped", "paused"].includes(deps.status(name))) throw new Error(t("kiro_reconcile.stopped_required"));
  const profile = instanceCredentialProfile(inst, fleet?.defaults, "kiro-cli");
  return { agendHome: deps.agendHome, instance: name, workingDirectory: inst.working_directory, credentialProfile: profile,
    sessionId: keep, archiveId: archive, sessionsDir: kiroV2SessionsDir(), dbPath: kiroV1DbPath(profile), model: inst.model };
}
export async function planKiroReconciliation(deps: KiroReconcileDeps, name: string, keep: string, archive: string, rollbackReceipt?: string): Promise<KiroReconciliation> {
  const input = target(deps, name, keep, archive), result = await deps.store(input, undefined, undefined, rollbackReceipt);
  if (!result.plan || JSON.stringify(target(deps, name, keep, archive)) !== JSON.stringify(input)) throw new Error(t("kiro_reconcile.changed"));
  return { name, input, plan: result.plan };
}
export function kiroReconciliationPrompt(p: KiroReconciliation): string {
  return t(p.plan.rollbackReceipt ? "kiro_reconcile.rollback_prompt" : "kiro_reconcile.prompt", p.name, p.input.sessionId, p.input.archiveId);
}
export async function applyKiroReconciliation(deps: KiroReconcileDeps, p: KiroReconciliation, actor: string): Promise<{ ok: boolean; text: string; receipt?: string }> {
  let lease: ReturnType<KiroReconcileDeps["reserve"]>;
  try { lease = deps.reserve(p.name); } catch (error) { return { ok: false, text: t("kiro_reconcile.failed", p.name, (error as Error).message) }; }
  let receipt: string | undefined;
  const current = () => {
    if (!lease.current()) throw new Error(t("kiro_reconcile.changed"));
    const config = deps.fleetConfig()?.instances[p.name];
    if (!config || (config.backend ?? deps.fleetConfig()?.defaults?.backend) !== "kiro-cli" || config.kiro_ui !== "tui" || config.model !== p.input.model || config.working_directory !== p.input.workingDirectory
      || instanceCredentialProfile(config, deps.fleetConfig()?.defaults, "kiro-cli") !== p.input.credentialProfile) throw new Error(t("kiro_reconcile.changed"));
  };
  try {
    if (JSON.stringify(target(deps, p.name, p.input.sessionId, p.input.archiveId)) !== JSON.stringify(p.input)) throw new Error(t("kiro_reconcile.changed"));
    current();
    const model = await deps.preflight(p.name, { name: p.name, workingDirectory: p.input.workingDirectory, credentialProfile: p.input.credentialProfile, classicId: p.input.sessionId }); current();
    if (model !== p.input.model) throw new Error(t("kiro_reconcile.changed"));
    const result = await deps.store(p.input, p.plan, actor); receipt = result.receipt; current();
    if (!receipt) throw new Error(t("kiro_reconcile.changed"));
    if (!p.plan.rollbackReceipt) {
      await deps.restart(p.name); current(); await deps.verify(p.name, p.input.sessionId, p.input.model, true); current();
      await deps.restart(p.name); current(); await deps.verify(p.name, p.input.sessionId, p.input.model, true); current();
    }
    return { ok: true, receipt, text: t(p.plan.rollbackReceipt ? "kiro_reconcile.rolled_back" : "kiro_reconcile.done", p.name, receipt) };
  } catch (error) {
    let reason = error instanceof SyntaxError ? "Malformed reconciliation data" : (error as Error).message;
    if (lease.current()) { try { await deps.stop(p.name); } catch { reason += " " + t("kiro_migrate.stop_unconfirmed"); } }
    return { ok: false, ...(receipt ? { receipt } : {}), text: t("kiro_reconcile.failed", p.name, reason) };
  } finally { lease.release(); }
}
