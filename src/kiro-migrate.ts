/**
 * #2598 B2: move one kiro instance from classic (`kiro_ui: legacy`, the v1 engine) to the TUI (v2), carrying its
 * conversation. kiro 3.0 drops the classic engine; an instance switched by editing `kiro_ui` alone used to start an
 * empty conversation unnoticed (it has no TUI record, so its first TUI launch starts fresh).
 *
 * The move: the instance's classic conversation (the one its v1 record holds) is armed as its TUI adoption, `kiro_ui`
 * is set to `tui` in fleet.yaml, and a running instance is restarted. Its first TUI launch then resumes exactly that
 * conversation by id, once — kiro copies the whole classic history into its session files and freezes the classic
 * copy — and records it as the instance's TUI conversation. From then on the engine floor (kiroEngineFloor) refuses
 * any classic launch of it: going back would resume the frozen copy and lose everything done since.
 *
 * It is a fleet-admin decision: migrate_kiro_instance only asks; the move runs on the admin's Confirm in General.
 */
import type { FleetConfig, InstanceConfig } from "./types.js";
import { armKiroTuiMigration, disarmKiroTuiMigration, inspectKiroTuiMigration, type KiroTuiMigration } from "./backend/kiro-identity.js";
import { instanceCredentialProfile } from "./backend/credential-profile.js";
import { t } from "./locale.js";

export interface KiroMigrateDeps {
  agendHome: string;
  fleetConfig(): FleetConfig | null;
  /** Writes fleet.yaml; throws when it cannot. */
  saveFleetConfig(): void;
  status(name: string): string;
  restart(name: string): Promise<void>;
}

/** What a confirmed move will do; checked again when the admin confirms. */
export interface KiroMigrationPlan {
  name: string;
  workingDirectory: string;
  credentialProfile: string | null;
  /** The classic conversation carried over; null = the instance moves with a fresh conversation. */
  classicId: string | null;
}

function target(deps: KiroMigrateDeps, name: string): { inst: InstanceConfig; workingDirectory: string; credentialProfile: string | null } | string {
  const fleet = deps.fleetConfig();
  const inst = fleet?.instances && Object.hasOwn(fleet.instances, name) ? fleet.instances[name] : undefined;
  if (!inst) return t("kiro_migrate.not_fleet_instance", name);
  const backend = inst.backend ?? fleet?.defaults?.backend ?? "claude-code";
  if (backend !== "kiro-cli") return t("kiro_migrate.not_kiro", name, backend);
  const ui = inst.kiro_ui ?? "legacy";
  if (ui !== "legacy") return t("kiro_migrate.not_legacy", name, ui);
  if (typeof inst.working_directory !== "string" || !inst.working_directory) return t("kiro_migrate.no_directory", name);
  return {
    inst,
    workingDirectory: inst.working_directory,
    credentialProfile: instanceCredentialProfile(inst as never, fleet?.defaults as never, "kiro-cli"),
  };
}

function refusal(name: string, m: Extract<KiroTuiMigration, { kind: "refused" }>): string {
  return t(`kiro_migrate.refused_${m.reason.replaceAll("-", "_")}`, name);
}

/** Judge a request; nothing is written. `startFresh` allows moving an instance that has no classic conversation. */
export function planKiroMigration(deps: KiroMigrateDeps, name: string, startFresh: boolean): { ok: true; plan: KiroMigrationPlan } | { ok: false; error: string } {
  const found = target(deps, name);
  if (typeof found === "string") return { ok: false, error: found };
  const inspected = inspectKiroTuiMigration({ agendHome: deps.agendHome, instance: name, workingDirectory: found.workingDirectory, credentialProfile: found.credentialProfile });
  if (inspected.kind === "refused") return { ok: false, error: refusal(name, inspected) };
  if (!inspected.classicId && !startFresh) return { ok: false, error: t("kiro_migrate.no_classic", name) };
  return { ok: true, plan: { name, workingDirectory: found.workingDirectory, credentialProfile: found.credentialProfile, classicId: inspected.classicId } };
}

/** The confirmation prompt's text. */
export function kiroMigrationPrompt(plan: KiroMigrationPlan, running: boolean): string {
  return [
    t("kiro_migrate.prompt_title", plan.name),
    plan.classicId ? t("kiro_migrate.prompt_carry", plan.classicId) : t("kiro_migrate.prompt_fresh"),
    t("kiro_migrate.prompt_one_way"),
    running ? t("kiro_migrate.prompt_restart") : t("kiro_migrate.prompt_next_start"),
  ].join("\n");
}

/**
 * Carry out a confirmed move. Judged again first (the prompt lived for minutes): the instance must still be classic,
 * in the same directory and profile, holding the same classic conversation. Config first, then the adoption; either
 * failing leaves the instance as it was. Returns the outcome, worded for General.
 */
export async function applyKiroMigration(deps: KiroMigrateDeps, plan: KiroMigrationPlan): Promise<{ ok: boolean; text: string }> {
  const found = target(deps, plan.name);
  if (typeof found === "string") return { ok: false, text: found };
  const again = inspectKiroTuiMigration({ agendHome: deps.agendHome, instance: plan.name, workingDirectory: found.workingDirectory, credentialProfile: found.credentialProfile });
  if (again.kind === "refused") return { ok: false, text: refusal(plan.name, again) };
  if (found.workingDirectory !== plan.workingDirectory || found.credentialProfile !== plan.credentialProfile || again.classicId !== plan.classicId) {
    return { ok: false, text: t("kiro_migrate.changed", plan.name) };
  }
  const { inst } = found;
  const before = inst.kiro_ui;
  const restoreConfig = (): void => { if (before === undefined) delete inst.kiro_ui; else inst.kiro_ui = before; };
  inst.kiro_ui = "tui";
  try { deps.saveFleetConfig(); } catch (err) {
    restoreConfig();
    return { ok: false, text: t("kiro_migrate.save_failed", plan.name, (err as Error).message) };
  }
  const opts = { agendHome: deps.agendHome, instance: plan.name, workingDirectory: plan.workingDirectory, credentialProfile: plan.credentialProfile };
  let armed: KiroTuiMigration;
  try { armed = armKiroTuiMigration(opts); } catch { armed = { kind: "refused", reason: "unreadable" }; }
  if (armed.kind === "refused" || armed.classicId !== plan.classicId) {
    if (armed.kind === "ready" && armed.classicId) disarmKiroTuiMigration(opts);
    restoreConfig();
    try { deps.saveFleetConfig(); } catch { /* the running classic CLI is untouched; the next save writes it again */ }
    return { ok: false, text: armed.kind === "refused" ? refusal(plan.name, armed) : t("kiro_migrate.changed", plan.name) };
  }
  const carried = plan.classicId ? t("kiro_migrate.done_carry", plan.classicId) : t("kiro_migrate.done_fresh");
  if (deps.status(plan.name) !== "running") return { ok: true, text: `${t("kiro_migrate.done_next_start", plan.name)} ${carried}` };
  try {
    await deps.restart(plan.name);
  } catch (err) {
    return { ok: true, text: `${t("kiro_migrate.done_restart_failed", plan.name, (err as Error).message)} ${carried}` };
  }
  return { ok: true, text: `${t("kiro_migrate.done", plan.name)} ${carried}` };
}
