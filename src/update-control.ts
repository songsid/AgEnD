/**
 * M-3770 slice 2.5, wiring part 2 (design update-wiring-m3770.md §4, §10.2; Fable's mailbox rules): the control mailbox
 * between the update's driver (the updater, or the recovery runner) and a fleet — the old one (barrier arm) and, in
 * later parts, the trial (its proof) and the new one (commit steps).
 *
 * It is files in the attempt's own 0700 directory, `control/`: the directory is the scope and its mode the authentication
 * (a same-uid writer, the trust a Unix socket would have had), the driver stays synchronous, and there is no path-length
 * limit. A request outlives its writer, so every request is bound:
 *   1. to its attempt and the stage its op is valid in — the fleet re-reads the journal before acting and refuses (with
 *      an answer) when they no longer match;
 *   2. to a live sender — its pid and service-lock token, still the lock's live holder and the attempt's own updater or
 *      recorded runner; otherwise the answer is `stale` and nothing runs;
 *   3. to its target fleet generation, by nonce — another fleet ignores it, and each answer carries the responder's
 *      `{ nonce, pid }`, which the driver checks;
 *   4. answered exactly once — the response is published under an O_EXCL name (an existing one is the answer); a timed-out
 *      wait never means success: the driver reconciles from the journal and asks again with a new seq.
 * Bodies are bounded; unknown ops are refused. Requests and responses stay with the attempt (for `--resolve`).
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { attemptDir, defaultJournalIo, readCurrent, type AttemptRecord, type JournalIo, type Stage } from "./update-journal.js";

export const CONTROL_DIR = "control";
export const MAX_CONTROL_BYTES = 4096;
export const controlDir = (home: string, attemptId: string) => join(attemptDir(home, attemptId), CONTROL_DIR);

/** Each op and the stages it is valid in (Fable rule 1). */
export const CONTROL_OPS: Readonly<Record<string, readonly Stage[]>> = {
  "status": ["opened", "barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing", "abandoning", "rolling-back"],
  "barrier.arm": ["opened"],
  "trial.prove": ["proving"],
  "commit.leaveTrial": ["committing"],
  "commit.startAgents": ["committing"],
  "commit.deliverInbox": ["committing"],
  "commit.runDeferred": ["committing"],
};

export interface ControlRequest {
  seq: number;
  op: string;
  attemptId: string;
  stage: Stage;
  /** The fleet generation it is addressed to, by its handoff nonce (fleet.lock's). */
  to: { nonce: string };
  /** The driver: its pid and its service-lock token. */
  from: { pid: number; token: string };
  args?: Record<string, unknown>;
}
export type ControlResult = { status: "ok"; value: unknown } | { status: "refused" | "stale"; why: string };
export interface ControlResponse { seq: number; op: string; attemptId: string; by: { nonce: string; pid: number }; result: ControlResult }

const pad = (n: number) => String(n).padStart(8, "0");
const requestName = (seq: number, op: string) => `${pad(seq)}-${op}.req.json`;
const responseName = (seq: number) => `${pad(seq)}.res.json`;
const fsyncDir = (dir: string) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

/** Publish `data` at `path` only if nothing is there: tmp, fsync, link (never replacing), tmp removed, directory fsynced. */
function publishOnce(path: string, data: string): "published" | "exists" {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists"; throw err; }
  finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  fsyncDir(join(path, ".."));
  return "published";
}

const isRequest = (v: unknown): v is ControlRequest => {
  const r = v as Partial<ControlRequest> | null;
  return !!r && Number.isSafeInteger(r.seq) && (r.seq as number) > 0 && typeof r.op === "string" && typeof r.attemptId === "string"
    && typeof r.stage === "string" && !!r.to && typeof r.to.nonce === "string" && !!r.from && Number.isSafeInteger(r.from.pid) && typeof r.from.token === "string";
};

// ── The driver's side (synchronous) ────────────────────────────────────────────────────────────────────────────────

export interface AskDeps { timeoutMs: number; pollMs?: number; sleep(ms: number): void; now(): number }
export type AskResult = { ok: true; response: ControlResponse } | { ok: false; reason: string };

/**
 * Write the request and wait (bounded, synchronously) for its answer. The answer must match the request's seq, op,
 * attempt and addressed nonce. A timeout is not success: the caller reconciles from the journal and asks again with a
 * new seq.
 */
export function askFleet(home: string, req: ControlRequest, d: AskDeps): AskResult {
  const dir = controlDir(home, req.attemptId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(req);
  if (Buffer.byteLength(body) > MAX_CONTROL_BYTES) return { ok: false, reason: "the request is too large" };
  if (publishOnce(join(dir, requestName(req.seq, req.op)), body + "\n") === "exists") return { ok: false, reason: `request ${req.seq} was already sent` };
  const until = d.now() + d.timeoutMs;
  for (;;) {
    let text: string | null = null;
    try { text = readFileSync(join(dir, responseName(req.seq)), "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (text !== null) {
      let res: ControlResponse;
      try { res = JSON.parse(text) as ControlResponse; } catch { return { ok: false, reason: `the answer to request ${req.seq} isn't readable` }; }
      if (res.seq !== req.seq || res.op !== req.op || res.attemptId !== req.attemptId || res.by?.nonce !== req.to.nonce) {
        return { ok: false, reason: `the answer to request ${req.seq} isn't from the fleet it was sent to` };
      }
      return { ok: true, response: res };
    }
    if (d.now() >= until) return { ok: false, reason: `the fleet didn't answer request ${req.seq} (${req.op}) in time` };
    d.sleep(d.pollMs ?? 250);
  }
}

/** The next unused seq in the attempt's mailbox (requests are never renumbered; a retry takes a new one). */
export function nextControlSeq(home: string, attemptId: string): number {
  let names: string[];
  try { names = readdirSync(controlDir(home, attemptId)); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return 1; throw err; }
  return names.reduce((max, n) => (/^\d{8}[-.]/.test(n) ? Math.max(max, Number(n.slice(0, 8))) : max), 0) + 1;
}

/** `trial.prove`'s answer (§5, §10.6): the trial fleet's own health. Adapters are informational, never a failure. */
export interface TrialProof { nonce: string; pid: number; healthy: boolean; problems: string[]; adapters: { total: number; connected: number } }

export interface ProveDeps { from: { pid: number; token: string }; timeoutMs?: number; askMs?: number; pollMs?: number; sleep(ms: number): void; now(): number }

/**
 * The updater's `prove(trialPid)` (§5): ask the trial generation, by its nonce, until it answers healthy or the bound
 * (90 s) runs out. Each ask is a new seq; a timed-out ask proves nothing. The answer must come from the generation's own
 * nonce and pid. Unhealthy until the bound: the last problems are the reason.
 */
export function proveTrial(home: string, attempt: AttemptRecord, trial: { nonce: string; pid: number }, d: ProveDeps): { ok: true } | { ok: false; reason: string } {
  const until = d.now() + (d.timeoutMs ?? 90_000);
  let last = "the trial fleet hasn't answered";
  for (;;) {
    const left = until - d.now();
    if (left <= 0) return { ok: false, reason: last };
    const asked = askFleet(home, { seq: nextControlSeq(home, attempt.id), op: "trial.prove", attemptId: attempt.id, stage: "proving", to: { nonce: trial.nonce }, from: d.from },
      { timeoutMs: Math.min(d.askMs ?? 10_000, left), pollMs: d.pollMs, sleep: d.sleep, now: d.now });
    if (asked.ok) {
      const { response } = asked;
      if (response.by.pid !== trial.pid) return { ok: false, reason: `the trial's answer came from pid ${response.by.pid}, not ${trial.pid}` };
      if (response.result.status !== "ok") return { ok: false, reason: `the trial refused the proof (${response.result.status}): ${response.result.why}` };
      const proof = response.result.value as Partial<TrialProof> | null;
      if (proof?.healthy === true && proof.nonce === trial.nonce && proof.pid === trial.pid) return { ok: true };
      last = `the trial fleet isn't healthy: ${(Array.isArray(proof?.problems) && proof.problems.length ? proof.problems : ["no proof"]).join("; ")}`;
    } else last = asked.reason;
    d.sleep(d.pollMs ?? 250);
  }
}

/** The fleet's commit steps (part 4), by op: each answers `done` or `pending` (an async step under way). */
export const COMMIT_OPS = { leaveTrial: "commit.leaveTrial", startAgents: "commit.startAgents", deliverInbox: "commit.deliverInbox", runDeferred: "commit.runDeferred" } as const;
export type CommitStep = keyof typeof COMMIT_OPS;
/** How long the updater waits for each step: starting the agents is a fleet's whole startup. */
export const COMMIT_STEP_MS: Readonly<Record<CommitStep, number>> = { leaveTrial: 120_000, startAgents: 15 * 60_000, deliverInbox: 60_000, runDeferred: 60_000 };

export interface CommitAskDeps { from: { pid: number; token: string }; askMs?: number; pollMs?: number; boundsMs?: Partial<Record<CommitStep, number>>; sleep(ms: number): void; now(): number; log?(line: string): void }

/**
 * The updater's commit hands (`runUpdate`'s `commit`, §5): each asks the new fleet — the trial generation, by its nonce
 * and pid — to do its step, and asks again (a new seq each time) while it answers `pending`, up to the step's bound.
 * False (refused, stale, mismatched, or out of time) leaves the attempt in committing; a fleet start resumes it.
 */
export function commitHandsOverMailbox(home: string, attemptId: string, fleet: { nonce: string; pid: number }, d: CommitAskDeps): Record<CommitStep, () => boolean> {
  const step = (name: CommitStep) => (): boolean => {
    const until = d.now() + (d.boundsMs?.[name] ?? COMMIT_STEP_MS[name]);
    for (;;) {
      const left = until - d.now();
      if (left <= 0) { d.log?.(`commit step ${name}: the fleet didn't finish it in time`); return false; }
      const asked = askFleet(home, { seq: nextControlSeq(home, attemptId), op: COMMIT_OPS[name], attemptId, stage: "committing", to: { nonce: fleet.nonce }, from: d.from },
        { timeoutMs: Math.min(d.askMs ?? 10_000, left), pollMs: d.pollMs, sleep: d.sleep, now: d.now });
      if (asked.ok) {
        const { response } = asked;
        if (response.by.pid !== fleet.pid) { d.log?.(`commit step ${name}: answered by pid ${response.by.pid}, not ${fleet.pid}`); return false; }
        if (response.result.status !== "ok") { d.log?.(`commit step ${name}: ${response.result.status}: ${response.result.why}`); return false; }
        if (response.result.value === "done") return true;
      }
      d.sleep(d.pollMs ?? 250);
    }
  };
  return { leaveTrial: step("leaveTrial"), startAgents: step("startAgents"), deliverInbox: step("deliverInbox"), runDeferred: step("runDeferred") };
}

// ── The fleet's side ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ServeDeps {
  /** This fleet: its fleet.lock nonce and pid. */
  self: { nonce: string; pid: number };
  /** Rule 2: the sender is still the lock's live holder and the attempt's own updater or runner. */
  senderLive(sender: { pid: number; token: string }): boolean;
  handlers: Readonly<Record<string, (req: ControlRequest, attempt: AttemptRecord) => ControlResult>>;
  io?: JournalIo;
}

/**
 * One pass over the open attempt's mailbox: every request addressed to this fleet and not yet answered is checked
 * against the journal (read again for each), its sender and its op, then answered exactly once. Reads nothing while no
 * attempt is open, and nothing in the attempt's directory but `control/`. Returns how many it answered.
 */
export function serveControl(home: string, d: ServeDeps): number {
  const io = d.io ?? defaultJournalIo;
  const read = readCurrent(home, io);
  if (read.state !== "open") return 0;
  const dir = controlDir(home, read.attempt.id);
  let names: string[];
  try { names = readdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; throw err; }
  const answered = new Set(names.filter(n => n.endsWith(".res.json")).map(n => n.slice(0, 8)));
  let count = 0;
  for (const name of names.filter(n => /^\d{8}-[a-z.]+\.req\.json$/i.test(n)).sort()) {
    if (answered.has(name.slice(0, 8))) continue;
    const path = join(dir, name);
    let req: ControlRequest;
    try {
      if (statSync(path).size > MAX_CONTROL_BYTES) continue;                                       // never read; never answered
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRequest(parsed)) continue;
      req = parsed;
    } catch { continue; }
    if (req.to.nonce !== d.self.nonce) continue;                                                    // rule 3: not for this fleet
    if (name !== requestName(req.seq, req.op)) continue;
    const result = judge(home, req, d, io);
    const res: ControlResponse = { seq: req.seq, op: req.op, attemptId: req.attemptId, by: { nonce: d.self.nonce, pid: d.self.pid }, result };
    if (publishOnce(join(dir, responseName(req.seq)), JSON.stringify(res) + "\n") === "published") count += 1;
  }
  return count;
}

function judge(home: string, req: ControlRequest, d: ServeDeps, io: JournalIo): ControlResult {
  const stages = CONTROL_OPS[req.op];
  const handler = d.handlers[req.op];
  if (!stages || !handler) return { status: "refused", why: `unknown op ${req.op}` };
  // Rule 1: the journal, read again right before acting.
  const now = readCurrent(home, io);
  if (now.state !== "open" || now.attempt.id !== req.attemptId) return { status: "refused", why: `attempt ${req.attemptId} isn't open` };
  if (now.attempt.stage !== req.stage || !stages.includes(now.attempt.stage)) {
    return { status: "refused", why: `${req.op} isn't valid in ${now.attempt.stage} (the request was for ${req.stage})` };
  }
  if (!d.senderLive(req.from)) return { status: "stale", why: `the sender (pid ${req.from.pid}) no longer holds the update's service lock` };
  try { return handler(req, now.attempt); }
  catch (err) { return { status: "refused", why: `${req.op} failed: ${(err as Error).message}` }; }
}
