/**
 * #2834: Claude's usage-limit pause (#816) and an exhausted credit balance came from pane text, so an agent printing or
 * quoting the words paused itself (agend-leader 2026-10-29 01:24:51, this agent 2026-10-28 18:11:48). Both now come from
 * Claude's own transcript records, captured from claude 2.1.312 in an isolated container (mock API, offline):
 * - usage pause: a `system` record, subtype `informational`, "Usage limit reached · continuing automatically at … · esc to cancel";
 * - credit: an `assistant` `isApiErrorMessage` record, status 400, `error: "billing_error"`, "Credit balance is too low"
 *   (the screen says "Credit balance too low · Add funds…", which the old pane pattern never matched).
 * Same events as before: the usage pause notifies (with the usage-API second opinion), credit pauses.
 *
 * Isolation: temp dirs; no tmux, no CLI, no network.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2834-")); dirs.push(d); return d; };

/** Records as claude 2.1.312 wrote them (fields trimmed). */
const USAGE_NOTE = { type: "system", subtype: "informational", content: "Usage limit reached · continuing automatically at 6:53pm · esc to cancel" };
const USAGE_ERROR = { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit",
  message: { role: "assistant", content: [{ type: "text", text: "You've hit your 5-hour limit · resets 6:53pm (UTC)" }] } };
const CREDIT_ERROR = { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 400, error: "billing_error",
  message: { role: "assistant", content: [{ type: "text", text: "Credit balance is too low" }] } };

/** A daemon wired to a monitor the way Daemon wires its own. */
function wired() {
  const dir = tmp();
  const daemon = new Daemon("worker", { working_directory: dir, log_level: "silent" } as any, dir, false, undefined, undefined, logger) as any;
  const monitor = new TranscriptMonitor(tmp(), logger) as any;
  monitor.on("api_error", (text: string, status: number | null, _at: number | null, kind: string | null) => daemon.noteClaudeApiError(text, status, kind));
  monitor.on("system_informational", (text: string) => daemon.noteClaudeInformational(text));
  const errors: any[] = [];
  daemon.on("pty_error", (e: any) => errors.push(e));
  return { daemon, record: (e: unknown) => monitor.processEntry(e), errors };
}

describe("#2834: the monitor passes Claude's own records on", () => {
  it("an informational system record → system_informational; an API error carries its error kind", () => {
    const m = new TranscriptMonitor(tmp(), logger) as any;
    const notes: string[] = []; const errs: unknown[][] = [];
    m.on("system_informational", (t: string) => notes.push(t));
    m.on("api_error", (...a: unknown[]) => errs.push(a));
    m.processEntry(USAGE_NOTE); m.processEntry(CREDIT_ERROR);
    m.processEntry({ type: "system", subtype: "turn_duration", durationMs: 1 });
    expect(notes).toEqual([USAGE_NOTE.content]);
    expect(errs).toEqual([["Credit balance is too low", 400, null, "billing_error"]]);
  });
});

describe("#2834: the same events as before, from the records", () => {
  it("a 5-hour limit: the error record alone says nothing; the informational note gives today's notice (cross-checked)", () => {
    const { record, errors } = wired();
    record(USAGE_ERROR);
    expect(errors).toEqual([]);
    record(USAGE_NOTE);
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "notify", verifyQuota: true, skipCooldown: true, skipRecoveryWait: true,
      message: "Claude Code usage limit reached — paused; continuing automatically at 6:53pm" })]);
  });

  it("an exhausted credit balance pauses, as the old pattern meant to", () => {
    const { record, errors } = wired();
    record(CREDIT_ERROR);
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "pause", message: "Insufficient API credits" })]);
  });

  it("other API errors do not (a 400 of another kind, a 500, a rate-limit 429)", () => {
    const { record, errors } = wired();
    const err = (status: number, error: string, text: string) => ({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: status, error,
      message: { role: "assistant", content: [{ type: "text", text }] } });
    record(err(400, "invalid_request", "API Error: 400 prompt is too long"));
    record(err(500, "server_error", "API Error: 500"));
    record(err(429, "rate_limit", "API Error: Rate limit reached"));
    expect(errors).toEqual([]);
  });

  it("#2822 is unchanged: the model's own limit still starts its hold", () => {
    const { daemon, record, errors } = wired();
    record({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit",
      message: { role: "assistant", content: [{ type: "text", text: "You've reached your Fable limit. /model to switch models." }] } });
    expect(daemon.usageHold()).toMatchObject({ model: "Fable" });
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "notify" })]);
  });

  it("an agent's own text quoting the words is output, not a record: nothing", () => {
    const { record, errors } = wired();
    record({ type: "assistant", message: { role: "assistant", content: [{ type: "text",
      text: "The pane said \"Usage limit reached · continuing automatically at 6:53pm · esc to cancel\" and \"Credit balance is too low\"." }] } });
    record({ type: "user", message: { role: "user", content: "Usage limit reached · continuing automatically at 6:53pm · esc to cancel" } });
    expect(errors).toEqual([]);
  });
});

describe("#2834: a session's first records are read, history is not replayed", () => {
  const line = (e: unknown) => JSON.stringify(e) + "\n";
  function monitorAt(path: string) {
    const m = new TranscriptMonitor(tmp(), logger) as any;
    m.resolveTranscriptPath = async () => path;
    const errs: unknown[][] = []; m.on("api_error", (...a: unknown[]) => errs.push(a));
    return { m, errs };
  }
  it("a transcript created after the monitor began (a new session): its first record — the credit error — is read", async () => {
    const { m, errs } = monitorAt(join(tmp(), "new-session.jsonl"));
    const path = await m.resolveTranscriptPath();
    writeFileSync(path, line({ type: "user", message: { role: "user", content: "message 1" } }) + line(CREDIT_ERROR));
    await m.pollIncrement(); await m.pollIncrement();
    expect(errs).toEqual([["Credit balance is too low", 400, null, "billing_error"]]);
  });
  it("a transcript that existed before (a resumed session): its history is not replayed; what is appended is read", async () => {
    const path = join(tmp(), "old-session.jsonl");
    writeFileSync(path, line(CREDIT_ERROR));                                          // yesterday's error
    await new Promise(r => setTimeout(r, 5));
    const { m, errs } = monitorAt(path);
    await m.pollIncrement(); await m.pollIncrement();
    expect(errs).toEqual([]);
    appendFileSync(path, line(CREDIT_ERROR));
    await m.pollIncrement();
    expect(errs).toHaveLength(1);
  });
});
