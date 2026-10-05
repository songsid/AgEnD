import { t } from "./locale.js";
import type { InstanceState, InteractionKind, InteractionOwner, InteractionSnapshot } from "./backend/types.js";

export const INTERACTION_CONFIRM_MS = 500;
export const INTERACTION_STALE_MS = 15_000;
const SUSPECTED_CONFIRM_MS = 10_000;

export interface InteractionEvidence {
  kind: InteractionKind;
  /** Private structural request identity. Never exported in a snapshot. */
  identity: string;
  suspected?: boolean;
  dialogKey?: string;
}

export function sameInteractionOwner(a: InteractionOwner, b: InteractionOwner): boolean {
  return a.bootId === b.bootId && a.spawnGeneration === b.spawnGeneration
    && a.launchAttempt === b.launchAttempt && a.launchFenceEpoch === b.launchFenceEpoch;
}

/** One daemon-owned observation; notification dedup and execution state are separate. */
export class InteractionObservation {
  private value: InteractionSnapshot | null = null;
  private identity: string | null = null;
  private lastAttemptOrder: number | null = null;
  private lastObservationMono: number | null = null;
  private candidateMono: number | null = null;
  private sequence = 0;

  reset(owner: InteractionOwner): void {
    this.identity = null;
    this.lastAttemptOrder = null;
    this.lastObservationMono = null;
    this.candidateMono = null;
    this.value = {
      phase: "unverified", kind: null, reason: null, episode: null,
      owner: { ...owner }, since: null, observedAt: null, confirmedAt: null,
      ageMs: null, stale: true, suspected: false,
    };
  }

  private current(owner: InteractionOwner): InteractionSnapshot {
    if (!this.value || !sameInteractionOwner(this.value.owner, owner)) this.reset(owner);
    return this.value!;
  }

  /** A failed/overtaken capture is not evidence that the previous prompt cleared. */
  unverify(owner: InteractionOwner, monotonicAt: number, order = monotonicAt): boolean {
    const value = this.current(owner);
    if (this.lastAttemptOrder !== null && order < this.lastAttemptOrder) return false;
    this.lastAttemptOrder = order;
    value.phase = "unverified";
    this.candidateMono = null;
    return true;
  }

  observe(
    evidence: InteractionEvidence | null,
    owner: InteractionOwner,
    observedAt: number,
    monotonicAt: number,
    outputMoved = false,
    order = monotonicAt,
  ): boolean {
    const value = this.current(owner);
    // Overlapping monitors can finish out of order. An older capture cannot
    // renew freshness or rewind a newer request's observation.
    if (this.lastAttemptOrder !== null && order < this.lastAttemptOrder) return false;
    this.lastAttemptOrder = order;
    const gap = this.lastObservationMono === null ? Infinity : monotonicAt - this.lastObservationMono;
    if (!evidence) {
      this.identity = null;
      this.candidateMono = null;
      Object.assign(value, { phase: "clear", kind: null, reason: null, episode: null,
        since: null, confirmedAt: null, suspected: false });
    } else {
      const suspected = evidence.suspected === true;
      const changed = this.identity !== evidence.identity || value.kind !== evidence.kind || value.suspected !== suspected;
      if (changed) {
        this.identity = evidence.identity;
        value.episode = ++this.sequence;
        value.since = observedAt;
        value.confirmedAt = null;
      }
      if (changed || value.phase === "unverified" || gap >= INTERACTION_STALE_MS || (suspected && outputMoved)) {
        this.candidateMono = monotonicAt;
        value.phase = "candidate";
      }
      value.kind = evidence.kind;
      value.reason = evidence.kind;
      value.suspected = suspected;
      const grace = suspected ? SUSPECTED_CONFIRM_MS : INTERACTION_CONFIRM_MS;
      if (this.candidateMono !== null && monotonicAt - this.candidateMono >= grace) {
        value.phase = "waiting";
        value.confirmedAt ??= observedAt;
      }
    }
    value.observedAt = observedAt;
    value.stale = false;
    this.lastObservationMono = monotonicAt;
    return true;
  }

  snapshot(owner: InteractionOwner, monotonicAt = performance.now()): InteractionSnapshot {
    const value = this.current(owner);
    const ageMs = this.lastObservationMono === null ? null : Math.max(0, monotonicAt - this.lastObservationMono);
    const stale = ageMs === null || ageMs >= INTERACTION_STALE_MS;
    return { ...value, owner: { ...value.owner }, ageMs, stale,
      phase: stale ? "unverified" : value.phase };
  }
}

/** Only outward presentation may project a fourth state. */
export function presentationState(
  execution: InstanceState | "paused" | null,
  interaction: InteractionSnapshot | null,
): InstanceState | "paused" | "awaiting_input" | null {
  return execution !== "paused" && interaction?.phase === "waiting"
    && !interaction.stale && !interaction.suspected ? "awaiting_input" : execution;
}

const BACKEND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", "kiro-cli": "Kiro",
  grok: "Grok", muse: "Muse", antigravity: "Antigravity", opencode: "OpenCode",
};

/** Incident labels are code-owned; never interpolate a pane or arbitrary backend value. */
export function interactionCategory(kind: InteractionKind, backend?: string): string {
  const category = t(`interactive.kind.${kind}`);
  return backend && Object.hasOwn(BACKEND_LABELS, backend) ? `${BACKEND_LABELS[backend]} · ${category}` : category;
}

/** Human text contains only a code-owned category and an observation age. */
export function interactionSummary(interaction: InteractionSnapshot | null): string | null {
  if (!interaction?.kind) return null;
  const kind = t(`interactive.kind.${interaction.kind}`);
  const age = Math.ceil((interaction.ageMs ?? 0) / 1_000);
  if (interaction.phase === "unverified") return t("interaction.unverified", kind, age);
  if (interaction.suspected) return t("interaction.suspected", age);
  return t(interaction.phase === "waiting" ? "interaction.waiting" : "interaction.candidate", kind, age);
}
