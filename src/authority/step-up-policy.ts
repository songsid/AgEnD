/**
 * #1939 §5: the one source for step-ups — the catalog of actions people can pick from, the default enforced list, the
 * user's custom actions, and `enforcedStepUps(config)`, the one reader every consumer goes through (delivery_status now;
 * the /authorize page, the receipt writer and the instructions in later stages). docs/design/1939-verified-web-sessions.md.
 */
import { createHash } from "node:crypto";
import type { WebVerifiedAuthorityConfig } from "../types.js";

/** What a step-up's target names (§4 StepUpTarget). */
export type StepUpTargetKind = "sha" | "pr" | "issue" | "branch" | "tag" | "instance" | "account" | "text";

export interface StepUpAction {
  readonly id: string;
  readonly label: string;
  readonly label_zh: string;
  /** The target kinds it may name; a custom action names free text. */
  readonly targets: readonly StepUpTargetKind[];
  readonly custom?: true;
}

/** §5's table. Its ids are the catalog's; a custom action may not reuse one. */
export const STEP_UP_CATALOG: readonly StepUpAction[] = Object.freeze([
  { id: "release", label: "Publish a package, push a release tag, create a GitHub release", label_zh: "發布套件、推送 release tag、建立 GitHub release", targets: ["tag"] },
  { id: "force-push", label: "Force-push or delete a remote branch", label_zh: "強制推送或刪除遠端分支", targets: ["branch"] },
  { id: "delete-instance", label: "Delete, replace or tear down an instance", label_zh: "刪除、取代或拆除 instance", targets: ["instance"] },
  { id: "merge", label: "Merge into a protected branch", label_zh: "合併進受保護的分支", targets: ["pr"] },
  { id: "history-rewrite", label: "Rebase, reset or amend anything already pushed and shared", label_zh: "對已推送並共用的內容 rebase、reset 或 amend", targets: ["branch"] },
  { id: "real-account", label: "Requests on a real vendor account or host login", label_zh: "使用真實的供應商帳號或主機登入發出請求", targets: ["account"] },
  { id: "deploy", label: "Deploy to a shared or production environment", label_zh: "部署到共用或正式環境", targets: ["text"] },
  { id: "close", label: "Close or lock an issue or PR that someone else opened", label_zh: "關閉或鎖定別人開的 issue 或 PR", targets: ["pr", "issue"] },
  { id: "credential", label: "Switch an instance to another account or credential profile", label_zh: "把 instance 換到另一個帳號或憑證設定檔", targets: ["instance"] },
  { id: "fleet-control", label: "Stop, restart or update the whole fleet", label_zh: "停止、重新啟動或更新整個 fleet", targets: ["text"] },
].map(a => Object.freeze({ ...a, targets: Object.freeze([...a.targets]) as readonly StepUpTargetKind[] })));

/** Enforced unless the user says otherwise (§11.5). */
export const DEFAULT_ENFORCED: readonly string[] = Object.freeze(["release", "force-push", "delete-instance"]);

/** A custom action's id (§5). */
export const CUSTOM_STEP_UP_ID = /^[a-z][a-z0-9-]{2,31}$/;
/** A label is one line of text people read on the Authorize page and in the DM. */
export const STEP_UP_LABEL_MAX = 80;

const catalogIds = new Set(STEP_UP_CATALOG.map(a => a.id));
const isLabel = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= STEP_UP_LABEL_MAX && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v);

/** Every problem in `web.verified_authority.step_up`, for the config validator (paths under it). */
export function stepUpPolicyProblems(stepUp: unknown): Array<{ path: string; message: string; warning?: true }> {
  const out: Array<{ path: string; message: string; warning?: true }> = [];
  const base = "web.verified_authority.step_up";
  if (stepUp === undefined) return out;
  if (!stepUp || typeof stepUp !== "object" || Array.isArray(stepUp)) return [{ path: base, message: "must be a mapping (enforce, custom)" }];
  const s = stepUp as Record<string, unknown>;
  for (const k of Object.keys(s)) if (k !== "enforce" && k !== "custom") out.push({ path: `${base}.${k}`, message: "unknown key (known: enforce, custom) — ignored", warning: true });
  const custom = new Set<string>();
  if (s.custom !== undefined) {
    if (!Array.isArray(s.custom)) out.push({ path: `${base}.custom`, message: "must be a list of { id, label, label_zh }" });
    else s.custom.forEach((entry: unknown, i: number) => {
      const at = `${base}.custom[${i}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { out.push({ path: at, message: "must be a mapping { id, label, label_zh }" }); return; }
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (k !== "id" && k !== "label" && k !== "label_zh") out.push({ path: `${at}.${k}`, message: "unknown key (known: id, label, label_zh) — ignored", warning: true });
      if (typeof e.id !== "string" || !CUSTOM_STEP_UP_ID.test(e.id)) out.push({ path: `${at}.id`, message: "must be 3–32 characters: a lower-case letter, then lower-case letters, digits or -" });
      else if (catalogIds.has(e.id)) out.push({ path: `${at}.id`, message: `"${e.id}" is a built-in action; pick another id` });
      else if (custom.has(e.id)) out.push({ path: `${at}.id`, message: `"${e.id}" is defined twice` });
      else custom.add(e.id);
      if (!isLabel(e.label)) out.push({ path: `${at}.label`, message: `must be one line of text, at most ${STEP_UP_LABEL_MAX} characters` });
      if (e.label_zh !== undefined && !isLabel(e.label_zh)) out.push({ path: `${at}.label_zh`, message: `must be one line of text, at most ${STEP_UP_LABEL_MAX} characters` });
    });
  }
  if (s.enforce !== undefined) {
    if (!Array.isArray(s.enforce)) out.push({ path: `${base}.enforce`, message: "must be a list of action ids" });
    else s.enforce.forEach((id: unknown, i: number) => {
      if (typeof id !== "string" || !(catalogIds.has(id) || custom.has(id))) {
        out.push({ path: `${base}.enforce[${i}]`, message: `unknown action (known: ${[...catalogIds, ...custom].join(", ")})` });
      }
    });
  }
  return out;
}

/** The catalog plus the user's valid custom actions, by id. A custom entry the validator refuses is left out. */
export function stepUpActions(config: WebVerifiedAuthorityConfig | undefined): ReadonlyMap<string, StepUpAction> {
  const table = new Map<string, StepUpAction>(STEP_UP_CATALOG.map(a => [a.id, a]));
  const custom = config?.step_up?.custom;
  if (Array.isArray(custom)) for (const e of custom) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !CUSTOM_STEP_UP_ID.test(e.id) || table.has(e.id) || !isLabel(e.label)) continue;
    table.set(e.id, Object.freeze({ id: e.id, label: e.label, label_zh: isLabel(e.label_zh) ? e.label_zh : e.label, targets: Object.freeze(["text"] as StepUpTargetKind[]), custom: true as const }));
  }
  return table;
}

export interface StepUpPolicy {
  /** Informational: changes when the list changes. Not the revocation epoch (§5). */
  version: string;
  /** The ids AgEnD enforces now, in the merged table, in the order configured. */
  enforced: string[];
}

/**
 * §5: the enforced list in force — the user's (`step_up.enforce`), else the default. An id no longer in the merged table
 * is simply not enforced (the validator reports it).
 */
export function enforcedStepUps(config: WebVerifiedAuthorityConfig | undefined): StepUpPolicy {
  const table = stepUpActions(config);
  const asked = Array.isArray(config?.step_up?.enforce) ? config!.step_up!.enforce : DEFAULT_ENFORCED;
  const enforced = [...new Set(asked.filter((id): id is string => typeof id === "string" && table.has(id)))];
  const version = createHash("sha256").update(JSON.stringify(enforced)).digest("hex").slice(0, 12);
  return { version, enforced };
}
