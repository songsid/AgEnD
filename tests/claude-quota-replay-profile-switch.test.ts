/**
 * Quota-notice spam after a profile switch (2026-11-06 15:31–15:35, agend-leader ×14, claude-fable ×6, agend-web-claude ×3):
 * the switch copies the conversation's transcript into the new profile (a NEW path, the whole history in it), and the
 * monitor reads a replacement transcript from its start — so every "Usage limit reached · continuing automatically at …"
 * note Claude ever wrote in that conversation was told again, each with its own long-past reset time (7:10pm ×9, 9:20pm,
 * 1:40am, 10pm, 2pm, 7pm: the leader's transcript holds exactly those, from 2026-10-07 to 10-22). The usage-API second
 * opinion failed right after the switch (fail-closed), so each became a notice.
 *
 * Now: Claude's alarm records (its status notes, its failed API calls) read from a file's start are history unless
 * stamped after the monitor's boundary and after everything already read; a usage note whose reset is already past is
 * not told; repeats of one pause collapse to one notice, until Claude says the limit reset. Other records are read as before.
 *
 * Isolation: temp dirs; no tmux, no CLI, no network.
 */
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { TranscriptMonitor, HISTORY_SKEW_MS } from "../src/transcript-monitor.js";
import { claudeResetInstant } from "../src/quota-notice.js";
import { InstanceLifecycle, type ClaudeQuotaVerdict, type LifecycleContext } from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-quota-replay-")); dirs.push(d); return d; };
const line = (e: unknown) => JSON.stringify(e) + "\n";
const iso = (ms: number) => new Date(ms).toISOString();

/** Claude's usage note as 2.1.312 writes it, stamped. */
const note = (when: string, at: number, again = false) => ({ type: "system", subtype: "informational", timestamp: iso(at),
  content: `Usage limit reached${again ? " again" : ""} · continuing automatically ${when} · esc to cancel` });
const resetNote = (at: number) => ({ type: "system", subtype: "informational", timestamp: iso(at), content: "Usage limit reset · continuing automatically" });
const credit = (at: number) => ({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 400, error: "billing_error", timestamp: iso(at),
  message: { role: "assistant", content: [{ type: "text", text: "Credit balance is too low" }] } });
const said = (text: string, at: number) => ({ type: "assistant", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text }] } });

/** The leader's transcript's usage notes (2026-10-07 … 10-22), local clock times as Claude printed them. */
const LEADER_HISTORY = (() => {
  const d = (m: number, day: number, h: number, min: number) => new Date(2026, m - 1, day, h, min).getTime();
  const out: object[] = [note("at 7:10pm", d(10, 7, 18, 43))];
  for (const min of [46, 47, 48, 48]) out.push(note("at 7:10pm", d(10, 7, 18, min), true));
  for (const [h, min] of [[19, 0], [19, 0], [19, 2], [19, 9]] as const) out.push(note("at 7:10pm", d(10, 7, h, min), true));
  out.push(resetNote(d(10, 7, 19, 10)));
  out.push(note("at 9:20pm", d(10, 8, 20, 42)), resetNote(d(10, 8, 21, 21)));
  out.push(note("at 1:40am", d(10, 18, 1, 38)), resetNote(d(10, 18, 1, 40)));
  out.push(note("at 10pm", d(10, 21, 21, 44)), note("at 2pm", d(10, 22, 12, 55)), note("at 7pm", d(10, 22, 17, 28)));
  return out;
})();

/** A monitor + daemon wired as Daemon wires them; the monitor follows whatever path `follow` names. */
function wired() {
  const dir = tmp();
  const daemon = new Daemon("worker", { working_directory: dir, log_level: "silent" } as any, dir, false, undefined, undefined, logger) as any;
  const monitor = new TranscriptMonitor(tmp(), logger) as any;
  let path = "";
  monitor.resolveTranscriptPath = async () => path;
  monitor.on("api_error", (text: string, status: number | null, _at: number | null, kind: string | null) => daemon.noteClaudeApiError(text, status, kind));
  monitor.on("system_informational", (text: string, at: number | null) => daemon.noteClaudeInformational(text, at));
  const notices: any[] = [], texts: string[] = [];
  daemon.on("pty_error", (e: any) => notices.push(e));
  monitor.on("assistant_text", (t: string) => texts.push(t));
  const poll = async () => { await monitor.pollIncrement(); await monitor.pollIncrement(); };
  return { daemon, monitor, notices, texts, poll, follow: (p: string) => { path = p; } };
}

describe("a profile switch's copied transcript does not tell its old usage notes again", () => {
  it("the leader's case: the known transcript is replaced by a copy of it (the whole history) — no notice; a new note after it is told", async () => {
    const w = wired();
    const before = join(tmp(), "49347c54.jsonl");                                       // the old profile's file
    writeFileSync(before, LEADER_HISTORY.map(line).join("") + line(credit(new Date(2026, 9, 20).getTime())) + line(said("earlier answer", Date.now() - 60_000)));
    w.follow(before); await w.poll();                                                   // attached (at its end)
    const after = join(tmp(), "49347c54.jsonl");                                        // the new profile's copy
    await new Promise(r => setTimeout(r, 20));
    copyFileSync(before, after);
    w.follow(after); await w.poll();                                                    // replaced → read from the top
    expect(w.notices).toEqual([]);                                                      // not 14 usage notices, not a credit pause
    expect(w.texts).toContain("earlier answer");                                        // other records are still read from the top
    // A pause Claude writes now, after the switch: told, once.
    const now = Date.now();
    appendFileSync(after, line(note("in 3h", now + 1)) + line(note("in 3h", now + 2, true)));
    await w.poll();
    expect(w.notices).toEqual([expect.objectContaining({ type: "quota", action: "notify", message: "Claude Code usage limit reached — paused; continuing automatically in 3h" })]);
  });

  it("a monitor started AFTER the switch (no known path): the copy is born after its boundary, but its records are history", async () => {
    const w = wired();
    const src = join(tmp(), "old.jsonl");
    writeFileSync(src, LEADER_HISTORY.map(line).join("") + line(credit(new Date(2026, 9, 20).getTime())));
    await new Promise(r => setTimeout(r, 30));
    const copy = join(tmp(), "copy.jsonl");
    copyFileSync(src, copy);                                                            // born now, after the monitor began
    w.follow(copy); await w.poll();
    expect(w.notices).toEqual([]);
    appendFileSync(copy, line(credit(Date.now() + 1)));
    await w.poll();
    expect(w.notices).toEqual([expect.objectContaining({ type: "quota", action: "pause", message: "Insufficient API credits" })]);
  });

  it("control: a NEW session's first record (written after the monitor began) is still read from the top (#2834)", async () => {
    const w = wired();
    await new Promise(r => setTimeout(r, 30));
    const fresh = join(tmp(), "fresh.jsonl");
    writeFileSync(fresh, line({ type: "user", timestamp: iso(Date.now()), message: { role: "user", content: "message 1" } }) + line(credit(Date.now())));
    w.follow(fresh); await w.poll();
    expect(w.notices).toEqual([expect.objectContaining({ action: "pause", message: "Insufficient API credits" })]);
  });

  it("records this monitor already read, carried into a replacement, are not told twice; one newer than all of them is", async () => {
    const w = wired();
    const first = join(tmp(), "a.jsonl");
    writeFileSync(first, line(said("start", Date.now())));
    w.follow(first); await w.poll();
    const t1 = Date.now() + 10;
    appendFileSync(first, line(credit(t1)));                                            // read live: one pause
    await w.poll();
    expect(w.notices).toHaveLength(1);
    const second = join(tmp(), "b.jsonl");
    copyFileSync(first, second);
    appendFileSync(second, line(credit(t1 + 50)));                                      // new in the replacement
    w.follow(second); await w.poll();
    expect(w.notices).toHaveLength(2);                                                  // the copied one not again; the new one told
  });

  it("a re-baseline that reads a path from the top (setTranscriptPath) treats what is there as history too", async () => {
    const w = wired();
    const p = join(tmp(), "c.jsonl");
    // A credit error too: the daemon's stale-reset check cannot mask it, only the monitor's history rule can.
    writeFileSync(p, LEADER_HISTORY.map(line).join("") + line(credit(new Date(2026, 9, 20).getTime())));
    w.monitor.setTranscriptPath(p); w.follow(p); await w.poll();
    expect(w.notices).toEqual([]);
  });

  it("the skew (#2835): a new session's first record stamped 2 s before the monitor attached is still this run's own", async () => {
    expect(HISTORY_SKEW_MS).toBeGreaterThan(2_000);
    const w = wired();
    await new Promise(r => setTimeout(r, 30));
    const p = join(tmp(), "skew.jsonl");                                                // created after attach: read from the top
    writeFileSync(p, line(credit(w.monitor.attachBoundary - 2_000)));                    // the CLI wrote it a moment before
    w.follow(p); await w.poll();
    expect(w.notices).toEqual([expect.objectContaining({ action: "pause", message: "Insufficient API credits" })]);
  });

  it("a record without a timestamp is judged as before (told): a CLI that stops stamping must not lose its live alarms", async () => {
    const w = wired();
    const p = join(tmp(), "d.jsonl");
    writeFileSync(p, line(said("x", Date.now())));
    w.follow(p); await w.poll();
    const q = join(tmp(), "e.jsonl");
    copyFileSync(p, q); w.follow(q); await w.poll();                                    // historyBefore is set now
    const { timestamp: _drop, ...unstamped } = credit(Date.now());
    appendFileSync(q, line(unstamped));
    await w.poll();
    expect(w.notices).toHaveLength(1);
  });
});

describe("the usage-pause notice: never a past reset, one per pause", () => {
  function daemonAt() {
    const dir = tmp();
    const daemon = new Daemon("worker", { working_directory: dir, log_level: "silent" } as any, dir, false, undefined, undefined, logger) as any;
    const notices: any[] = [];
    daemon.on("pty_error", (e: any) => notices.push(e));
    let mono = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    return { tell: (text: string, at: number | null) => daemon.noteClaudeInformational(text, at), notices, advance: (ms: number) => { mono += ms; } };
  }
  const content = (n: any) => n.content as string;

  it("a note whose reset time is already past (judged from when Claude wrote it) is not told", () => {
    const d = daemonAt();
    for (const n of LEADER_HISTORY) d.tell(content(n), Date.parse((n as any).timestamp));
    expect(d.notices).toEqual([]);
  });

  it("a live note is told; its 'reached again' repeats are not, nor another reset time inside the window; after Claude's reset, a new pause is", () => {
    const d = daemonAt();
    const now = Date.now();
    d.tell("Usage limit reached · continuing automatically in 2h · esc to cancel", now);
    d.tell("Usage limit reached again · continuing automatically in 2h · esc to cancel", now + 60_000);
    d.advance(10 * 60_000);
    d.tell("Usage limit reached again · continuing automatically in 5h · esc to cancel", now + 600_000);
    expect(d.notices).toHaveLength(1);
    d.tell("Usage limit reset · continuing automatically", now + 700_000);
    d.tell("Usage limit reached · continuing automatically in 4h · esc to cancel", now + 800_000);
    expect(d.notices).toHaveLength(2);
  });

  it("past the window, a note naming the same reset (not yet come) is still the same pause; a different one is a new notice", () => {
    const d = daemonAt();
    const now = Date.now();
    d.tell("Usage limit reached · continuing automatically in 3h · esc to cancel", now);
    d.advance(Daemon.USAGE_PAUSE_NOTICE_WINDOW_MS + 1);
    d.tell("Usage limit reached again · continuing automatically in 3h · esc to cancel", now);   // same words, same reset instant
    expect(d.notices).toHaveLength(1);
    d.tell("Usage limit reached again · continuing automatically in 4h · esc to cancel", now);
    expect(d.notices).toHaveLength(2);
  });

  it("#3186 review P2-2: once the told pause's reset has passed, a new pause inside the window is told (no reset note needed)", () => {
    const d = daemonAt();
    let wall = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    d.tell("Usage limit reached · continuing automatically in 10m · esc to cancel", wall);
    expect(d.notices).toHaveLength(1);
    d.advance(20 * 60_000); wall += 20 * 60_000;                                           // its reset came 10 min ago, unremarked
    d.tell("Usage limit reached · continuing automatically in 3h · esc to cancel", wall); // a new limit
    expect(d.notices).toHaveLength(2);
  });

  it("words it cannot judge (a date) are told as before — never dropped for being unreadable", () => {
    const d = daemonAt();
    d.tell("Usage limit reached · continuing automatically at Nov 9, 3pm · esc to cancel", new Date(2026, 9, 1).getTime());
    expect(d.notices).toHaveLength(1);
  });
});

describe("claudeResetInstant: Claude's reset words as a moment", () => {
  const at = (m: number, day: number, h: number, min = 0) => new Date(2026, m - 1, day, h, min).getTime();
  it("'at' a clock time: the first such local time after the note was written", () => {
    expect(claudeResetInstant("at 7:10pm", at(10, 7, 18, 43))).toBe(at(10, 7, 19, 10));
    expect(claudeResetInstant("at 7:10pm", at(10, 7, 19, 20))).toBe(at(10, 8, 19, 10));
    expect(claudeResetInstant("at 1:40am", at(10, 18, 1, 38))).toBe(at(10, 18, 1, 40));
    expect(claudeResetInstant("at 2pm", at(10, 22, 12, 55))).toBe(at(10, 22, 14));
    expect(claudeResetInstant("at 12am", at(10, 22, 23))).toBe(at(10, 23, 0));
    expect(claudeResetInstant("at 12pm", at(10, 22, 9))).toBe(at(10, 22, 12));
    expect(claudeResetInstant("at 7pm (Asia/Taipei)", at(10, 22, 17, 28))).toBe(at(10, 22, 19));
    expect(claudeResetInstant("at 19:30", at(10, 22, 17))).toBe(at(10, 22, 19, 30));
  });
  it("'in' a duration: added to when it was written", () => {
    const from = at(11, 6, 15);
    expect(claudeResetInstant("in 3h", from)).toBe(from + 3 * 3_600_000);
    expect(claudeResetInstant("in 2h 30m", from)).toBe(from + 2.5 * 3_600_000);
    expect(claudeResetInstant("in 45 minutes", from)).toBe(from + 45 * 60_000);
  });
  it("anything else: null (never judged stale)", () => {
    for (const w of ["at Nov 9, 3pm", "soon", "at 13pm", "at 7:75pm", "in a while", "in 0h", ""]) expect(claudeResetInstant(w, at(10, 1, 0)), w).toBeNull();
  });
});

/**
 * #3186 review P2-1: the dedupe sits BEFORE the lifecycle's usage-API second opinion. When that drops the first note (the
 * API lags the CLI right as the limit hits: "available"), nothing was told — so the next "reached again" must reach the
 * second opinion again, not be collapsed into a notice nobody saw.
 */
describe("the one-notice-per-pause mark follows what was actually told", () => {
  it("first note verified 'available' (dropped) → the next repeat is verified again and told", async () => {
    const verdicts: ClaudeQuotaVerdict[] = ["available", "exhausted"];
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "claude-code" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null, isPlannedRestart: () => false,
      notifyInstanceTopic, webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (name: string) => `/nonexistent/${name}`, verifyClaudeQuota: async () => verdicts.shift() ?? "exhausted",
    } as unknown as LifecycleContext;
    const dir = tmp();
    const daemon = new Daemon("worker", { working_directory: dir, log_level: "silent" } as any, dir, false, undefined, undefined, logger) as any;
    new InstanceLifecycle(ctx).attachIncidentHandlers("worker", daemon);
    const now = Date.now();
    daemon.noteClaudeInformational("Usage limit reached · continuing automatically in 3h · esc to cancel", now);
    await new Promise(r => setTimeout(r, 20));
    expect(notifyInstanceTopic).not.toHaveBeenCalled();                                   // dropped by the second opinion
    daemon.noteClaudeInformational("Usage limit reached again · continuing automatically in 3h · esc to cancel", now + 60_000);
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));         // verified again: told
  });
});
