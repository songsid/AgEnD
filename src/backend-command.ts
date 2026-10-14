/**
 * #1806: `/backend` — move an instance to another CLI backend from chat, choosing its model and effort on the way.
 *
 * backend → model → effort → confirm, then ONE config write and ONE relaunch: update_instance_config's backend switch
 * (`applyInstanceConfigPatch`), which starts the new backend fresh (#1217) and keeps its credential-profile login gate.
 * Nothing is written or restarted between the steps — a backend restarted on the old model, then again on the new
 * one, is two chances to fail instead of one.
 *
 * This file is the steps only, and it is pure: for the arguments chosen so far, the next question (with its choices),
 * the confirmation, or a refusal. Every check runs on every call, so the typed form (`/backend codex gpt-5 high`) and
 * each click of a menu are judged the same way, and a refusal comes before anything is written. Discord, Telegram and
 * the web chat only present it (fleet-manager.ts, web-commands.ts).
 */
import type { ModelOption } from "./backend/types.js";

/** The word that picks the inherited value of a model or an effort, in the typed form and in the menus. */
export const BACKEND_DEFAULT = "default";

/** The most choices one step offers: a Discord select menu's 25, less "default". */
const MAX_MODEL_CHOICES = 24;

export interface BackendCommandDeps {
  /** The backend the instance runs now. */
  currentBackend(instance: string): string;
  /** What the instance runs on now, as a reply shows it: "claude-code · opus". */
  currentDisplay(instance: string): string;
  /** Backends whose CLI is installed on this host, found the way the launch finds it; never removed or test-only ones. */
  installedBackends(): string[];
  /** The models `/model` would offer on that backend; empty when none are known. */
  models(backend: string): Promise<ModelOption[]>;
  /** A name the backend accepts beyond its list (claude-code's aliases and account catalog). */
  modelKnown(backend: string, model: string): boolean;
  /** `/effort`'s levels on that backend for this model (codex's differ per model; null: the CLI's own default model). */
  effortLevels(backend: string, model: string | null): string[];
  /** The model or effort the instance inherits when it has none of its own (fleet defaults). */
  inherited(key: "model" | "effort"): string | undefined;
  /** Whether a model name looks like one of this backend's (advisory, as `/model`'s warning). */
  modelCompatible(backend: string, model: string): boolean;
  /** Whether the instance runs now, and is in a turn. */
  state(instance: string): { running: boolean; busy: boolean; status: string };
  t(key: string, ...args: string[]): string;
}

/** What a confirmed `/backend` writes: `null` = the inherited value (no override of the instance's own). */
export interface BackendPlan { backend: string; model: string | null; effort: string | null }

/** One choice of a step. `token` is the argument it adds; `label` what the button says. */
export interface BackendChoice { token: string; label: string }

export type BackendStep =
  | { kind: "choose"; step: "backend" | "model" | "effort"; args: string[]; text: string; choices: BackendChoice[]; current: string | null }
  | { kind: "confirm"; args: string[]; plan: BackendPlan; from: string; text: string }
  /** `noop`: not a refusal of bad input — the instance already runs that backend, so there is nothing to do. */
  | { kind: "refuse"; text: string; noop?: boolean };

/** A chosen model or effort as a reply says it; `null` is the inherited one, named. */
function shown(deps: BackendCommandDeps, key: "model" | "effort", value: string | null): string {
  if (value !== null) return value;
  const inherited = deps.inherited(key);
  return inherited ? deps.t("backend.default_inherited", inherited) : deps.t("backend.default_cli");
}

/** How a plan's model and effort read in the reply after it is applied ("—": the backend has no effort setting). */
export function planDisplay(deps: BackendCommandDeps, plan: BackendPlan): { model: string; effort: string } {
  const levels = deps.effortLevels(plan.backend, plan.model ?? deps.inherited("model") ?? null);
  return { model: shown(deps, "model", plan.model), effort: levels.length ? shown(deps, "effort", plan.effort) : "—" };
}

/**
 * Split a typed argument string the way every surface does: on whitespace, except inside double quotes — a model can
 * have spaces in its name (antigravity's "Gemini 3.5 Flash (High)").
 */
export function backendArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]!).filter(Boolean);
}

/** The arguments as one string that backendArgs splits back into the same tokens (the web's choice ids). */
export function joinBackendArgs(args: readonly string[]): string {
  return args.map(a => /\s/.test(a) ? `"${a}"` : a).join(" ");
}

/**
 * A model name the backend's launch line can carry. Antigravity's builder shell-quotes the name whole (its catalog
 * has display names); every other builder runs validateModel's rule. Never a control character or a double quote.
 */
export function modelNameCarried(backend: string, model: string): boolean {
  if (!model || /[\x00-\x1f\x7f"]/.test(model) || model.trim() !== model) return false;
  return backend === "antigravity" || /^[A-Za-z0-9._:/[\]-]+$/.test(model);
}

/** The next step for these arguments: `[]`, `[backend]`, `[backend, model]` or `[backend, model, effort]`. */
export async function backendStep(deps: BackendCommandDeps, instance: string, args: readonly string[]): Promise<BackendStep> {
  const { t } = deps;
  if (args.length > 3) return { kind: "refuse", text: t("backend.usage") };
  const from = deps.currentBackend(instance);
  const installed = deps.installedBackends();
  if (args.length === 0) {
    return {
      kind: "choose", step: "backend", args: [], current: from,
      text: t("backend.menu", deps.currentDisplay(instance)),
      choices: installed.map(b => ({ token: b, label: b === from ? `✓ ${b}` : b })),
    };
  }

  const backend = args[0]!.toLowerCase();
  if (!installed.includes(backend)) {
    return { kind: "refuse", text: t("backend.not_installed", args[0]!, installed.join(", ") || "—") };
  }
  // The same backend is not a switch: nothing to restart for. A model or effort on it is /model's and /effort's job.
  if (backend === from) return { kind: "refuse", text: t("backend.same", instance, backend), noop: true };

  const models = await deps.models(backend);
  const defaultModel = deps.inherited("model");
  const modelDisplay = (m: string | null) => shown(deps, "model", m);
  if (args.length === 1) {
    const listed = models.slice(0, MAX_MODEL_CHOICES).map(o => ({ token: o.id, label: o.description ? `${o.label} — ${o.description}` : o.label }));
    return {
      kind: "choose", step: "model", args: [backend], current: null,
      text: t(models.length ? "backend.model_menu" : "backend.model_menu_empty", backend),
      choices: [{ token: BACKEND_DEFAULT, label: `${t("backend.default")} (${modelDisplay(null)})` }, ...listed],
    };
  }

  const modelArg = args[1]!;
  let model: string | null = null;
  if (modelArg.toLowerCase() !== BACKEND_DEFAULT) {
    // Only a name this backend's launch line can carry (validateModel's rule, or antigravity's quoting), then known.
    const known = modelNameCarried(backend, modelArg)
      && (models.some(o => o.id === modelArg) || deps.modelKnown(backend, modelArg));
    if (!known) {
      const names = [BACKEND_DEFAULT, ...models.slice(0, MAX_MODEL_CHOICES).map(o => o.id)].join(", ");
      return { kind: "refuse", text: t("backend.unknown_model", modelArg, backend, names) };
    }
    model = modelArg;
  }

  // The levels of the model that will run: the one chosen, else the inherited one, else the CLI's default (#1806 review).
  const levels = deps.effortLevels(backend, model ?? defaultModel ?? null);
  const effortDisplay = (e: string | null) => shown(deps, "effort", e);
  if (args.length === 2 && levels.length > 0) {
    return {
      kind: "choose", step: "effort", args: [backend, modelArg], current: null,
      text: t("backend.effort_menu", backend, modelDisplay(model)),
      choices: [{ token: BACKEND_DEFAULT, label: `${t("backend.default")} (${effortDisplay(null)})` }, ...levels.map(l => ({ token: l, label: l }))],
    };
  }

  let effort: string | null = null;
  if (args.length === 3) {
    const effortArg = args[2]!.toLowerCase();
    if (levels.length === 0) return { kind: "refuse", text: t("backend.no_effort", backend) };
    if (effortArg !== BACKEND_DEFAULT) {
      if (!levels.includes(effortArg)) return { kind: "refuse", text: t("backend.unknown_effort", args[2]!, backend, [BACKEND_DEFAULT, ...levels].join(", ")) };
      effort = effortArg;
    }
  }

  const plan: BackendPlan = { backend, model, effort };
  const effectiveModel = model ?? defaultModel;
  const lines = [
    t("backend.confirm_head", instance, deps.currentDisplay(instance), backend),
    t("backend.confirm_model", modelDisplay(model)),
    levels.length ? t("backend.confirm_effort", effortDisplay(effort)) : t("backend.confirm_no_effort", backend),
    ...(effectiveModel && !deps.modelCompatible(backend, effectiveModel) ? [t("model.pattern_warning", effectiveModel, backend).trim()] : []),
    "",
  ];
  const state = deps.state(instance);
  if (state.running) {
    lines.push(t("backend.confirm_restart", instance), t("backend.confirm_fresh", backend));
    lines.push(state.busy ? t("backend.confirm_busy", instance) : t("backend.confirm_turn"));
  } else {
    lines.push(t("backend.confirm_not_running", instance, state.status, backend));
  }
  const confirmedArgs = [backend, model ?? BACKEND_DEFAULT, ...(levels.length ? [effort ?? BACKEND_DEFAULT] : [])];
  return { kind: "confirm", args: confirmedArgs, plan, from, text: lines.join("\n") };
}
