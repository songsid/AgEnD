/**
 * #1510: turn boundaries from a CLI's own transcript, for the reply-completion guard of a backend whose pane alone is
 * not proof that a turn ended (codex; recordings in tests/fixtures/reply-guard-1510).
 *
 * The guard asks one question after its idle confirmation: did the turn that took THIS delivery end, and has nothing
 * started since? Ownership is evidence, not shape: the turn is the one whose user message is the text AgEnD pasted,
 * written after the delivery armed. Rollouts are shared by working directory, so another instance's turn in the same
 * directory never carries our text — no match is "unknown", and unknown never starts a recovery (fail-safe).
 */

/** One boundary record, in transcript order. `turnId` is empty when the record came before any start was read. */
export type TranscriptTurnEvent =
  | { readonly kind: "start"; readonly turnId: string }
  | { readonly kind: "user"; readonly turnId: string; readonly text: string; readonly at: number }
  | { readonly kind: "end"; readonly turnId: string; readonly end: "complete" | "aborted" | "error" };

/**
 * `ended`: our turn and every turn after it ended normally. `running`: our turn, or one after it, has not ended.
 * `aborted`: our turn was interrupted (Esc). `error`: it ended without an answer (a provider error). `unknown`: our
 * delivery is not in the transcript we follow.
 */
export type TranscriptTurnVerdict = "ended" | "running" | "aborted" | "error" | "unknown";

interface Turn { id: string; users: Array<{ text: string; at: number }>; end?: "complete" | "aborted" | "error" }

/** The same words, whatever the paste did to line breaks and indentation. */
export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, "");
}

const MAX_TURNS = 64;
/** A user record this much older than the arm is an earlier message with the same words, not this delivery. */
const ARM_SKEW_MS = 30_000;

export class TranscriptTurnLedger {
  private turns: Turn[] = [];

  observe(events: readonly TranscriptTurnEvent[]): void {
    for (const e of events) {
      if (e.kind === "start") {
        if (!e.turnId || this.turns.some(t => t.id === e.turnId)) continue;
        this.turns.push({ id: e.turnId, users: [] });
        if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
        continue;
      }
      const turn = e.turnId ? this.turns.find(t => t.id === e.turnId) : undefined;
      if (!turn) continue; // a record from a turn whose start we never read cannot be attributed
      if (e.kind === "user") turn.users.push({ text: normalizeTurnText(e.text), at: e.at });
      else turn.end = e.end;
    }
  }

  /** Forget everything (the source re-baselined, or the instance restarted its CLI). */
  reset(): void { this.turns = []; }

  /** See TranscriptTurnVerdict. `armedAt` is the wall-clock time the delivery armed the guard. */
  verdict(deliveredText: string | undefined, armedAt: number): TranscriptTurnVerdict {
    const wanted = deliveredText ? normalizeTurnText(deliveredText) : "";
    if (!wanted) return "unknown";
    let ours = -1;
    for (let i = this.turns.length - 1; i >= 0 && ours < 0; i--) {
      if (this.turns[i].users.some(u => u.at >= armedAt - ARM_SKEW_MS && u.text.includes(wanted))) ours = i;
    }
    if (ours < 0) return "unknown";
    if (this.turns.slice(ours).some(t => !t.end)) return "running";
    const end = this.turns[ours].end;
    return end === "aborted" ? "aborted" : end === "error" ? "error" : "ended";
  }
}
