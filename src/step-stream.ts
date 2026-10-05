/**
 * Live per-instance step stream (#1218 spike): what an agent is doing, step by step — each tool it calls, what came
 * back, what it said — for the dashboard to show as it happens.
 *
 * Source: the CLI's own transcript, through the TranscriptMonitor the daemon already runs (claude-code JSONL, codex
 * rollouts, kiro's data store, opencode's db — transcript-sources.ts). Nothing here reads the tmux pane or adds a poll:
 * steps ride on events the daemon already receives, so the pane-driven idle/busy state machine sees no difference.
 *
 * Volume: a step is a short, redacted label — never the raw tool input or output — and steps leave the daemon in
 * batches, at most one per interval, with a bound on what waits. A burst beyond it is coalesced into one "skipped"
 * step rather than queued without end.
 */
import { redactSecrets } from "./tool-progress.js";

export type StepKind = "tool" | "result" | "text" | "skipped";

export interface Step {
  /** Per daemon process, increasing: the order steps happened in, and what a page asks for after a gap. */
  seq: number;
  /** Epoch ms when the daemon saw it (the transcript poll), not when the CLI did it. */
  ts: number;
  kind: StepKind;
  /** The tool's name, for tool steps. */
  name?: string;
  /** One line, redacted and capped. */
  text: string;
  /** A tool result the CLI marked as an error. */
  error?: true;
}

/** The longest text a step carries. */
export const STEP_TEXT_MAX = 240;

/** One redacted line of at most STEP_TEXT_MAX characters. */
export function stepText(raw: unknown): string {
  const flat = redactSecrets(String(raw ?? "")).replace(/\s+/g, " ").trim();
  return flat.length > STEP_TEXT_MAX ? `${flat.slice(0, STEP_TEXT_MAX - 1)}…` : flat;
}

/**
 * What a tool returned, as one line. Claude Code gives a string or a list of content blocks (text, images); other
 * transcript sources give nothing at all, and then there is no result text.
 */
export function resultPreview(output: unknown): string {
  if (typeof output === "string") return stepText(output);
  if (Array.isArray(output)) {
    const parts = output.map(block => {
      if (block && typeof block === "object") {
        const b = block as { type?: unknown; text?: unknown };
        if (typeof b.text === "string") return b.text;
        if (b.type === "image") return "[image]";
      }
      return "";
    }).filter(Boolean);
    return stepText(parts.join(" "));
  }
  return "";
}

export interface StepBatcherOptions {
  /** Shortest time between two batches. */
  intervalMs?: number;
  /** Most steps one batch carries. */
  maxBatch?: number;
  /** Most steps waiting at once; beyond it the oldest are folded into one "skipped" step. */
  maxPending?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Collects steps and hands them on in batches: the first step of a quiet period starts a timer, and when it fires
 * everything waiting (up to maxBatch) goes in one call. Never more than one call per interval, whatever the CLI does.
 */
export class StepBatcher {
  private readonly pending: Step[] = [];
  private skipped = 0;
  private seq = 0;
  private timer: unknown = null;
  private disposed = false;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly send: (steps: Step[]) => void, opts: StepBatcherOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1_000;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxPending = opts.maxPending ?? 200;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A tool call, labelled by the caller (the daemon's operator-facing summary). */
  tool(name: string, label: string): void { this.push({ kind: "tool", name, text: stepText(label || name) }); }

  /** What a tool returned; `name` is whatever the source calls it (Claude Code: the tool_use id). */
  result(name: string, output: unknown, isError = false): void {
    this.push({ kind: "result", name, text: resultPreview(output), ...(isError ? { error: true as const } : {}) });
  }

  /** Something the agent said. */
  text(text: string): void {
    const t = stepText(text);
    if (t) this.push({ kind: "text", text: t });
  }

  private push(step: Omit<Step, "seq" | "ts">): void {
    if (this.disposed) return;
    this.pending.push({ seq: ++this.seq, ts: this.now(), ...step });
    // A runaway loop must not grow the daemon: the oldest waiting steps fold into a count.
    while (this.pending.length > this.maxPending) { this.pending.shift(); this.skipped++; }
    if (this.timer === null) this.timer = this.setTimer(() => this.flush(), this.intervalMs);
  }

  /** Send what is waiting (one batch); if more is left, the next batch waits a full interval. */
  flush(): void {
    this.timer = null;
    if (this.disposed) return;
    const batch: Step[] = [];
    if (this.skipped > 0) {
      batch.push({ seq: this.pending[0]?.seq ?? this.seq, ts: this.now(), kind: "skipped", text: `${this.skipped} steps skipped (too many at once)` });
      this.skipped = 0;
    }
    batch.push(...this.pending.splice(0, this.maxBatch - batch.length));
    if (batch.length) this.send(batch);
    if (this.pending.length) this.timer = this.setTimer(() => this.flush(), this.intervalMs);
  }

  /** Drop what is waiting and stop the timer; later steps start a new batch as usual. */
  clear(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending.length = 0;
    this.skipped = 0;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending.length = 0;
  }
}

/**
 * The fleet's copy: the recent steps of each instance, for a page that opens after they happened. Bounded per
 * instance; in memory only. Each daemon process numbers its steps from 1, so a restart starts a new `boot`.
 */
export class InstanceStepLog {
  private readonly byInstance = new Map<string, { boot: string; steps: Step[] }>();
  constructor(private readonly perInstance = 300) {}

  /** Append a batch; a batch from a new daemon boot replaces what the old one said. Returns what was kept. */
  append(instance: string, boot: string, steps: Step[]): Step[] {
    let slot = this.byInstance.get(instance);
    if (!slot || slot.boot !== boot) { slot = { boot, steps: [] }; this.byInstance.set(instance, slot); }
    const last = slot.steps.at(-1)?.seq ?? 0;
    const fresh = steps.filter(s => s.seq > last || s.kind === "skipped");
    slot.steps.push(...fresh);
    if (slot.steps.length > this.perInstance) slot.steps.splice(0, slot.steps.length - this.perInstance);
    return fresh;
  }

  list(instance: string): { boot: string | null; steps: Step[] } {
    const slot = this.byInstance.get(instance);
    return slot ? { boot: slot.boot, steps: slot.steps.slice() } : { boot: null, steps: [] };
  }

  forget(instance: string): void { this.byInstance.delete(instance); }
}
