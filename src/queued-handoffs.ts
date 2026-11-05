/**
 * #3030: messages handed to a busy CLI's own input queue (Claude Code, Codex) that the CLI has not taken yet.
 *
 * A hand-off is accepted by the CLI's queue long before a turn consumes it, and that queue lives only in the CLI
 * process: an `agend stop` / restart / update (or a crash) before the running turn ends drops it, and nothing in AgEnD
 * knew. Each such hand-off is recorded here before AgEnD calls it handed off, and removed once the CLI's transcript
 * shows it taken (or once it is settled after a restart). What is still here when the instance's next CLI comes up was
 * held by a CLI that is gone: the daemon checks its transcript from the hand-off's checkpoint and redelivers it once
 * only when the transcript proves it was never taken (ownership is evidence: never pasted twice).
 *
 * One small JSON file per instance (`queued-handoffs.json` in the instance directory), written atomically. Entries hold
 * what a redelivery needs (the inbound content and its channel metadata) and the transcript checkpoint taken before
 * the paste.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const QUEUED_HANDOFFS_FILE = "queued-handoffs.json";
/** Entries kept per instance; past this the oldest goes (logged by the caller). */
export const QUEUED_HANDOFFS_MAX = 50;
/** A redelivered message lost again is redelivered again, at most this many times in all. */
export const QUEUED_HANDOFF_MAX_REDELIVERIES = 3;

export interface QueuedHandoff {
  id: string;
  /** The unique leading marker of the pasted body: `[agend-delivery-id:…]` or `[agend-human-id:…]`. */
  marker: string;
  backend: string;
  /** The transcript and offset before the paste. */
  path: string;
  offset: number;
  /** The inbound as pushChannelMessage got it: a redelivery goes through it again. */
  content: string;
  meta: Record<string, string>;
  /** The CLI that held it: `${bootId}:${spawnGeneration}`. Settled only by a later CLI. */
  holder: string;
  createdAt: number;
  redeliveries: number;
}

function isEntry(v: unknown): v is QueuedHandoff {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.marker === "string" && typeof e.backend === "string"
    && typeof e.path === "string" && Number.isSafeInteger(e.offset) && (e.offset as number) >= 0
    && typeof e.content === "string" && !!e.meta && typeof e.meta === "object" && !Array.isArray(e.meta)
    && Object.values(e.meta as object).every(x => typeof x === "string")
    && typeof e.holder === "string" && typeof e.createdAt === "number" && Number.isSafeInteger(e.redeliveries);
}

export class QueuedHandoffStore {
  private readonly path: string;
  constructor(instanceDir: string) { this.path = join(instanceDir, QUEUED_HANDOFFS_FILE); }

  /** Every readable entry; an unreadable file reads as none (logged by the caller through `readError`). */
  list(): QueuedHandoff[] {
    let text: string;
    try { text = readFileSync(this.path, "utf-8"); } catch { return []; }
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch { return []; }
  }

  private write(entries: QueuedHandoff[]): void {
    atomicWriteFileSync(this.path, JSON.stringify(entries) + "\n", { mode: 0o600 });
  }

  /** Adds (or replaces, by id) an entry; returns the entries dropped for the cap, oldest first. */
  put(entry: QueuedHandoff): QueuedHandoff[] {
    const entries = this.list().filter(e => e.id !== entry.id);
    entries.push(entry);
    const dropped = entries.length > QUEUED_HANDOFFS_MAX ? entries.splice(0, entries.length - QUEUED_HANDOFFS_MAX) : [];
    this.write(entries);
    return dropped;
  }

  /** Removes an entry; true when it was there. */
  remove(id: string): boolean {
    const entries = this.list();
    const rest = entries.filter(e => e.id !== id);
    if (rest.length === entries.length) return false;
    this.write(rest);
    return true;
  }

  get(id: string): QueuedHandoff | undefined { return this.list().find(e => e.id === id); }
}
