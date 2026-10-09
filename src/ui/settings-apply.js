// #1408 §5: Settings' Apply belongs to the app from the moment it is confirmed. The panel hands over an operation —
// the staged changes as data (method, URL, body, label; never a DOM closure) — before the first write, and this
// runner performs the writes one by one, the POST /api/settings/apply (one key, made now, reused by every retry), and
// the one watcher of its job. It publishes progress to the app store (appStore.settingsOp) and never touches a panel's
// DOM: Settings renders from the store and re-attaches when it mounts again, the shell shows a line in any other panel.
//
// A write an admin must confirm (#1423) waits here, in the operation, until it is decided (settings-confirm.js).
// Secrets (a bot token being rotated) live only inside the operation and are dropped as their write finishes, or when
// the operation stops.
import { appStore } from "/assets/app-store.js";
import { t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import "./settings-strings.js";
import { api, confirmedWrite, newKey } from "./settings-confirm.js";

const WATCH_LIMIT_MS = 10 * 60_000;
const POST_RETRIES = [1000, 2000, 4000];
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = new Set(["writing", "posting", "watching"]);

let op = null;                                   // the operation in hand (the store holds its public view)
let seq = 0;

function view() {
  if (!op) return null;
  return {
    id: op.id, phase: op.phase, error: op.error, job: op.job, lostJob: op.lostJob, restart: op.restart,
    steps: op.steps.map(({ label, impact, status, error, pendingId }) => ({ label, impact, status, error: error || null, pendingId: pendingId || null })),
    leftover: op.leftover,
  };
}
function publish() { appStore.set({ settingsOp: view() }); }

/**
 * An operation is in hand and not finished — its writes, its apply job, or a restart of AgEnD it asked for (from the
 * press until that restart's watch ends, #1453 review): Apply stays off, and no other operation can take its place.
 */
export function operationActive() { return !!op && (ACTIVE.has(op.phase) || op.restart === "busy"); }

/**
 * Take over an Apply. `changes`: [{ label, impact, request: { method, url, body, sensitive? }, key? } | { label, impact,
 * connectionSecret: { id, secret } }], in order. Returns false (and does nothing) while another operation is active.
 * A change that brings its `key` is the retry of a write whose outcome was never learned: the same key rejoins the
 * request the server may already hold. A `sensitive` request body (the wizard's token) is dropped when its write
 * completes (answered, refused or failed), and such a change is never staged again.
 */
export function startOperation(changes) {
  if (operationActive()) return false;
  op = {
    id: ++seq,
    phase: "writing", error: null, job: null, lostJob: false, restart: "idle", leftover: [],
    applyKey: newKey("apply"),                       // made now, before the first write; every POST retry reuses it
    steps: changes.map((c) => ({ ...c, request: c.request ? { ...c.request } : undefined, key: c.key || newKey("write"), status: "queued" })),
  };
  publish();
  run(op);
  return true;
}

/** Forget a finished operation (its card's ×). */
export function dismissOperation() {
  if (op && !ACTIVE.has(op.phase) && op.restart !== "busy") { op = null; publish(); }
}

/** Unrun changes of a failed operation, as data, for the panel to stage again (secrets excluded); taken once. */
export function takeLeftover() {
  if (!op || !op.leftover.length) return [];
  const out = op.leftover;
  op.leftover = [];
  publish();
  return out;
}

const mine = (o) => o === op;

async function run(o) {
  for (const step of o.steps) {
    if (!mine(o)) return;
    step.status = "running"; publish();
    let res;
    // A transport failure leaves the outcome unknown: the server may have taken the write (or made it a pending
    // request). That is not a refusal — the step keeps its key, so trying again rejoins it (#1453 review).
    try { res = await perform(step, o); }
    catch (err) { res = { ok: false, ambiguous: true, body: { error: err && err.message ? err.message : "network" } }; }
    finally {
      if (step.connectionSecret) step.connectionSecret.secret = "";
      if (step.request && step.request.sensitive) step.request.body = null;
    }
    if (!mine(o)) return;
    step.pendingId = null;
    // The wizard's commit says when ~/.agend/.env is readable by others.
    if (res && res.ok && res.body && res.body.secret_mode_ok === false) toast(t("settings.wizardEnvPerms"), false);
    if (!res || !res.ok) {
      step.status = "failed";
      step.ambiguous = !!(res && res.ambiguous);
      step.error = (res && res.body && (res.body.error || res.body.result)) || "failed";
      stop(o, step);
      return;
    }
    step.status = "done"; publish();
  }
  if (!mine(o)) return;
  o.phase = "posting"; publish();
  const started = await postApply(o);
  if (!mine(o)) return;
  if (!started) return;
  o.job = started; o.phase = "watching"; publish();
  await watch(o, started.id);
}

/** The step's write; a connection's token rotation is verify → apply → its own short job. */
async function perform(step, o) {
  if (step.request) {
    const { method, url, body } = step.request;
    return confirmedWrite(url, { method, body, key: step.key, label: step.label,
      onPending: (id) => { if (mine(o)) { step.pendingId = id; step.status = "waiting"; publish(); } } });
  }
  if (step.connectionSecret) return rotateConnectionSecret(step, o);
  return { ok: false, body: { error: "unknown change" } };
}

async function rotateConnectionSecret(step, o) {
  const { id } = step.connectionSecret;
  const base = `/api/settings/connections/${encodeURIComponent(id)}/secret`;
  const verified = await api(`${base}/verify`, { method: "POST", headers: { "Idempotency-Key": step.key },
    body: JSON.stringify({ secret: step.connectionSecret.secret, idempotency_key: step.key }) });
  step.connectionSecret.secret = "";                // the server holds it from here (by verification id)
  if (!verified.ok) return verified;
  const applied = await confirmedWrite(`${base}/apply`, { method: "POST", key: step.key, label: step.label,
    body: { verification_id: verified.body && verified.body.verification_id, idempotency_key: step.key },
    onPending: (pid) => { if (mine(o)) { step.pendingId = pid; step.status = "waiting"; publish(); } } });
  if (!applied.ok && applied.status !== 409) return applied;
  let result = applied.body || {};
  for (let n = 0; result.job_id && result.result === "applying" && n < 60; n++) {
    await sleep(250);
    const status = await api(`${base}/apply/${encodeURIComponent(result.job_id)}`).catch(() => null);
    if (status && status.ok) result = status.body || result;
  }
  const ok = result.result === "applied" || result.result === "restart_required";
  return { ok, status: ok ? 200 : 409, body: ok ? result : { error: result.error || result.result || "apply failed" } };
}

function stop(o, failed) {
  o.phase = "failed";
  o.error = failed ? failed.error : o.error;
  let after = false;
  for (const step of o.steps) {
    if (step === failed) after = true;
    else if (after && step.status === "queued") step.status = "skipped";
    if (step.connectionSecret) step.connectionSecret.secret = "";
  }
  // What did not land can be staged again, except a secret, which has to be entered again. A write whose outcome is
  // unknown goes back with its key; one the server refused, or that never ran, gets a new key when it is applied.
  o.leftover = o.steps.filter((s) => (s.status === "failed" || s.status === "skipped") && s.request && !s.request.sensitive)
    .map(({ label, impact, request, stageKey, key, ambiguous }) => ({ label, impact, request, stageKey, ...(ambiguous ? { key } : {}) }));
  publish();
}

async function postApply(o) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await api("/api/settings/apply", { method: "POST", headers: { "Idempotency-Key": o.applyKey },
        body: JSON.stringify({ idempotency_key: o.applyKey }) });
    } catch {
      // The answer was lost (a phone between networks): the same key rejoins the same job, never a second one.
      if (!mine(o)) return null;
      if (attempt < POST_RETRIES.length) { await sleep(POST_RETRIES[attempt]); if (!mine(o)) return null; continue; }
      res = { ok: false, status: 0, body: { error: "network" } };
    }
    if (!mine(o)) return null;
    if (res.status === 409) { o.phase = "failed"; o.error = "busy"; publish(); return null; }
    if (!res.ok || !res.body || !res.body.id) { o.phase = "failed"; o.error = (res.body && res.body.error) || "failed"; publish(); return null; }
    return res.body;
  }
}

/** GET is the authority; a restart takes the server away under the request, which is the middle of it, not the end. */
async function watch(o, id) {
  const deadline = now() + WATCH_LIMIT_MS;
  let current = o.job;
  while (current && current.status === "running" && now() < deadline) {
    await sleep(1000);
    if (!mine(o)) return;
    let res;
    try { res = await api(`/api/settings/apply/${encodeURIComponent(id)}`); } catch { continue; }
    if (!mine(o)) return;
    // The job outlives the process that made it, so a 404 means it aged out of the store, not that it never ran.
    if (res.status === 404) { o.lostJob = true; o.phase = "done"; publish(); return; }
    if (!res.ok || !res.body || !res.body.id) continue;
    current = res.body; o.job = current; publish();
  }
  if (!mine(o)) return;
  o.phase = "done"; publish();
  // Said once, wherever the person is now: a restart reminder and a partial result are errors, a clean apply is not.
  const rows = (current && current.targets) || [];
  const failed = rows.some((r) => r.status === "failed"), restart = rows.some((r) => r.status === "restart-required");
  if (!o.lostJob) toast(t(failed ? "settings.applyPartial" : restart ? "settings.applyRestartNeeded" : "settings.changesApplied"), !(failed || restart));
}

/**
 * A full AgEnD restart for a job that needs one: its own confirmation (the caller's), its own key, one at a time. The
 * job's fleet row moves to "running" on the server; that job is watched again.
 */
export async function restartFleet() {
  const o = op;
  if (!o || !o.job || o.restart === "busy" || ACTIVE.has(o.phase)) return { ok: false };
  o.restart = "busy"; publish();
  const key = newKey("restart");
  let res;
  try {
    res = await api("/api/settings/restart-fleet", { method: "POST", headers: { "Idempotency-Key": key },
      body: JSON.stringify({ job_id: o.job.id, confirm: "restart-agend", idempotency_key: key }) });
  } catch { res = { ok: false, status: 0, body: null }; }
  if (!mine(o)) return res;
  if (!res.ok) { o.restart = "idle"; publish(); return res; }
  toast(t("settings.restartFleetStarted"));          // when it is accepted; how it ends is said when it settles
  const fresh = await api(`/api/settings/apply/${encodeURIComponent(o.job.id)}`).catch(() => null);
  if (!mine(o)) return res;
  o.job = fresh && fresh.ok && fresh.body && fresh.body.id ? fresh.body
    : { ...o.job, status: "running", targets: o.job.targets.map((row) => (row.target === "fleet" ? { ...row, status: "running" } : row)) };
  o.phase = "watching"; publish();
  try { await watch(o, o.job.id); } finally { if (mine(o)) { o.restart = "idle"; publish(); } }
  return res;
}

// Leaving while writes or the POST are still to come would lose them: the browser asks first. Once the job exists,
// a reload re-attaches nothing but loses nothing either (the job runs on the server).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (op && (op.phase === "writing" || op.phase === "posting")) { e.preventDefault(); e.returnValue = ""; }
  });
}

/** For tests. */
export function resetOperation() { op = null; publish(); }
