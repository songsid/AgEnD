/**
 * M-3770 slice 2.5, wiring part 1 (design update-wiring-m3770.md §1, §10.1): which update path `agend update` takes.
 * Phase 2 — the update transaction — only where every condition holds; Phase 1 (today's updater) otherwise, unchanged.
 *
 * V_tx is declared, not inferred: a release that speaks the transaction says so in its package.json,
 * `"agend": { "updateTx": <n> }`. The running version reads its own; the target's comes from `npm view <name>@<exact
 * version>` (never a dist-tag), and is read again from the INSTALLED package.json before the trial (§10.1). Absent or
 * malformed is 0.
 *
 * Until the flip (S-261, after 2.4.0 and the leader's call) the transaction is also switched off here: no release
 * declares `updateTx` yet, and `AGEND_UPDATE_TX` must be "1" for selection to consider Phase 2 at all.
 */
import type { PreflightClass } from "./update-readiness.js";

/** The `agend.updateTx` of a package.json's parsed contents (0: absent or not a positive integer). */
export function updateTxOf(pkg: unknown): number {
  const v = (pkg as { agend?: { updateTx?: unknown } } | null)?.agend?.updateTx;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/** `npm view <name>@<exact version> agend.updateTx --json`, through an injected runner (0: absent, unreadable or not a version). */
export function targetUpdateTx(run: (command: string, args: string[]) => { status: number | null; stdout: string }, npm: string, name: string, version: string): number {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return 0;                          // an exact version only, never a tag
  const r = run(npm, ["view", `${name}@${version}`, "agend.updateTx", "--json"]);
  if (r.status !== 0 || !r.stdout.trim()) return 0;
  try { return updateTxOf({ agend: { updateTx: JSON.parse(r.stdout) } }); } catch { return 0; }
}

export interface PhaseInputs {
  /** `AGEND_UPDATE_TX`: the switch, "1" to consider Phase 2 (off until S-261). */
  switchedOn: boolean;
  preflightClass: PreflightClass;
  runningTx: number;
  targetTx: number;
  /** The fleet's service kind: null is a detached fleet. */
  service: "systemd" | "launchd" | null;
  /** S-230's request-context mode; "unknown" (unreadable) refuses like On. */
  requestContext: "off" | "on" | "unknown";
  /** `readCurrent(home).state`. */
  journal: "none" | "closing" | "open" | "manual" | "unknown";
}

export type PhaseChoice = { phase: 1 | 2; why: string };

/** The lowest V_tx this updater drives (§1). */
export const MIN_UPDATE_TX = 1;

/** §1: Phase 2 iff every condition holds; the first that fails says why Phase 1 runs. */
export function selectUpdatePhase(i: PhaseInputs): PhaseChoice {
  const one = (why: string): PhaseChoice => ({ phase: 1, why });
  if (!i.switchedOn) return one("the update transaction isn't switched on yet");
  if (i.preflightClass !== "self") return one(`the readiness check says ${i.preflightClass}, not self`);
  if (i.runningTx < MIN_UPDATE_TX) return one("the running AgEnD doesn't speak the update transaction");
  if (i.targetTx < MIN_UPDATE_TX) return one("the target AgEnD doesn't speak the update transaction");
  if (i.service === "launchd") return one("macOS service installs keep today's updater for now (S-260)");
  if (i.requestContext !== "off") return one(i.requestContext === "on"
    ? "request-based contact approvals are on: a held message couldn't be replayed with its verification"
    : "whether request-based contact approvals are on can't be read");
  if (i.journal !== "none") return one(`the update journal reads ${i.journal}`);
  return { phase: 2, why: "both versions speak the update transaction" };
}
