/**
 * S-234: one durable update offer. Words and timing only — the card never installs by itself,
 * and `auto-when-idle` does not queue. Pre-flight is a seam: 412 only when a checker is injected.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { validateFleetConfig } from "../src/config-validator.js";
import { idleUpdateMessageId, NOT_NOW_MS, UpdateOfferCard, updateAnswerLabel, updateOfferReply, type UpdateAnswerBody, type UpdateCardDeps, type UpdateOfferInput } from "../src/update-card.js";
import { beginUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";
import { IDLE_UPDATE_MIGRATION, IDLE_UPDATE_WAIT_MS, IdleUpdateQueue, type IdleUpdate, type IdleUpdateLaunch } from "../src/update-idle.js";
import { updatesFromRaw, updatesProblems, type UpdatesSettings } from "../src/update-settings.js";

const dirs: string[] = [];
const cards: UpdateOfferCard[] = [];
const idleDbs: Database.Database[] = [];
const idleQueues: IdleUpdateQueue[] = [];
afterEach(() => {
  for (const card of cards.splice(0)) { try { card.close(); } catch { /* already closed */ } }
  for (const queue of idleQueues.splice(0)) queue.close();
  for (const db of idleDbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WEEK = NOT_NOW_MS;
const CONFIRM = "update-agend";

function harness(over: Partial<UpdateCardDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s234-"));
  dirs.push(dir);
  let now = Date.parse("2026-11-26T02:00:00Z");
  let settings: UpdatesSettings | undefined = {};
  let agentsIdle = true;
  let externalBusy = false;
  let names: string[] = [];
  const launched: string[] = [];
  const launchNow = vi.fn(async (_by: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> => ({ ok: true }));
  const launchHubNow = vi.fn(async (_id: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> => ({ ok: true }));
  const cancelHub = vi.fn();
  const launchIdle = vi.fn(async (version: string, control: IdleUpdateLaunch) => {
    if (!control.claim()) return false;
    launched.push(version);
    return true;
  });
  const deps: UpdateCardDeps = {
    dataDir: dir, now: () => now, settings: () => settings, busyNames: () => names,
    agentsIdle: () => agentsIdle, externalBusy: () => externalBusy,
    launchNow, launchHubNow, cancelHub, launchIdle, currentVersion: () => null, ...over,
  };
  let card = new UpdateOfferCard(deps);
  cards.push(card);
  return {
    dir, launched, launchNow, launchHubNow, cancelHub, launchIdle,
    get card() { return card; },
    setNow: (n: number) => { now = n; },
    now: () => now,
    setSettings: (s: UpdatesSettings | undefined) => { settings = s; },
    setIdle: (v: boolean) => { agentsIdle = v; },
    setBusy: (v: boolean) => { externalBusy = v; },
    setNames: (n: string[]) => { names = n; },
    offer(version = "2.4.0-beta.1", extra: Partial<UpdateOfferInput> = {}) {
      card.noteOffer({ version, channel: "beta", installable: true, ...extra });
    },
    reopen() {
      const i = cards.indexOf(card);
      if (i >= 0) cards.splice(i, 1);
      card.close();
      card = new UpdateOfferCard(deps);
      cards.push(card);
      return card;
    },
  };
}

type H = ReturnType<typeof harness>;
const answer = (h: H, key: string, body: UpdateAnswerBody, by = "Ada") => h.card.answer(key, by, body);
const hubRow = (id: string, version: string, state: IdleUpdate["state"], at: number): IdleUpdate =>
  ({ id, version, createdAt: at, expiresAt: at + 86_400_000, updatedAt: at, state, reason: null });

describe("S-234 one update offer", () => {
  it("keeps the newest version, survives a reopen, and drops only a quiet offer", () => {
    const h = harness();
    h.offer("2.4.0-beta.1", { notes: "first" });
    h.offer("2.4.0-beta.2");
    expect(h.card.view()).toMatchObject({ version: "2.4.0-beta.2", channel: "beta", installable: true, state: "offered" });
    expect(h.card.view()?.notes).toBeUndefined();
    expect(statSync(join(h.dir, "update-card.json")).mode & 0o777).toBe(0o600);
    h.reopen();
    expect(h.card.view()).toMatchObject({ version: "2.4.0-beta.2", state: "offered" });
    h.card.clearQuietOffer();
    expect(h.card.view()).toBeNull();
    expect(existsSync(join(h.dir, "update-card.json"))).toBe(false);
  });

  it("Not now lasts a week from the last answer, and a newer version does not clear it", async () => {
    const h = harness();
    h.offer("2.4.0-beta.1");
    const t0 = h.now();
    const first = await answer(h, "nn-1", { action: "not-now" });
    expect(first).toMatchObject({ ok: true, status: 200 });
    expect(h.card.view()).toMatchObject({ state: "not-now", version: "2.4.0-beta.1", notNowUntil: t0 + WEEK, lastAnswer: { action: "not-now", by: "Ada", at: t0 } });
    h.offer("2.4.0-beta.2");
    expect(h.card.view()).toMatchObject({ state: "not-now", version: "2.4.0-beta.2", notNowUntil: t0 + WEEK });
    h.setNow(t0 + 1_000);
    await answer(h, "nn-2", { action: "not-now" });
    expect(h.card.view()?.notNowUntil).toBe(t0 + 1_000 + WEEK);
    h.setNow(t0 + 1_000 + WEEK);
    expect(h.card.view()?.state).toBe("offered");
    expect(h.card.view()?.notNowUntil).toBeUndefined();
  });

  it("pick-time is future and at most 7 days, then waits without launching while agents are busy", async () => {
    const h = harness();
    h.setIdle(false);
    h.offer("2.4.0-beta.1");
    const now = h.now();
    expect((await answer(h, "pt-past", { action: "pick-time", at: now })).status).toBe(400);
    expect((await answer(h, "pt-far", { action: "pick-time", at: now + WEEK + 1 })).status).toBe(400);
    expect((await answer(h, "pt-bad", { action: "pick-time", at: 1.5 })).status).toBe(400);
    const picked = await answer(h, "pt-ok", { action: "pick-time", at: now + WEEK });
    expect(picked.ok).toBe(true);
    expect(h.card.view()).toMatchObject({ state: "scheduled", scheduledAt: now + WEEK, version: "2.4.0-beta.1" });
    expect(h.card.blocksAdmission()).toBe(true);
    h.offer("2.4.0-beta.2");
    expect(h.card.view()).toMatchObject({ state: "scheduled", version: "2.4.0-beta.2", scheduledAt: now + WEEK });
    h.card.clearQuietOffer();
    expect(h.card.view()?.state).toBe("scheduled");
    h.setNow(now + WEEK);
    h.card.tick();
    await vi.waitFor(() => expect(h.card.view()?.state).toBe("waiting-idle"));
    expect(h.launched).toEqual([]);
    h.setIdle(true);
    h.card.tick();
    await vi.waitFor(() => expect(h.launched).toEqual(["2.4.0-beta.2"]));
    expect(h.card.view()?.state).toBe("updating");
  });

  it("a pause keeps the idle row waiting, then the same version launches after the window", async () => {
    const inside = new Date(2026, 10, 26, 10, 15);
    const h = harness();
    h.setNow(inside.getTime());
    h.setSettings({ pause: [{ days: [inside.getDay()], from: "10:00", to: "11:00" }] });
    h.setIdle(true);
    h.offer("2.4.0-beta.3");
    expect((await answer(h, "pause", { action: "when-idle" })).ok).toBe(true);
    expect(h.card.view()?.state).toBe("waiting-idle");
    await new Promise(r => setImmediate(r));
    expect(h.launched).toEqual([]);
    h.setNow(new Date(2026, 10, 26, 11, 0).getTime());
    h.card.tick();
    await vi.waitFor(() => expect(h.launched).toEqual(["2.4.0-beta.3"]));
  });

  it("a pin hides the card and refuses an answer; removing it restores the newest version", async () => {
    const h = harness();
    h.setIdle(true);
    h.offer("2.4.0-beta.1");
    const at = h.now() + 5_000;
    expect((await answer(h, "sched", { action: "pick-time", at })).ok).toBe(true);
    h.setSettings({ pin: "2.4.0-beta.1" });
    expect(h.card.view()).toBeNull();
    expect((await answer(h, "pinned", { action: "not-now" }))).toMatchObject({ ok: false, status: 409, body: { key: "card_changed", error: "pinned" } });
    h.setNow(at);
    h.card.tick();
    await new Promise(r => setImmediate(r));
    expect(h.launched).toEqual([]);
    expect(h.card.blocksAdmission()).toBe(true);
    h.setSettings({});
    h.card.tick();
    await vi.waitFor(() => expect(h.launched).toEqual(["2.4.0-beta.1"]));
  });

  it("auto-when-idle stores the mode and does not queue, even when every agent is idle", async () => {
    const h = harness();
    h.setSettings({ mode: "auto-when-idle" });
    h.setIdle(true);
    h.offer("2.4.0-beta.1");
    h.card.tick();
    await new Promise(r => setImmediate(r));
    expect(h.launched).toEqual([]);
    expect(h.card.view()).toMatchObject({ state: "offered", version: "2.4.0-beta.1" });
    expect(h.card.blocksAdmission()).toBe(false);
  });

  it("refuses a second admission while something else owns the machine, and 412 only when pre-flight is injected", async () => {
    const busy = harness();
    busy.offer("2.4.0-beta.1");
    busy.setBusy(true);
    expect(await answer(busy, "busy-idle", { action: "when-idle" })).toMatchObject({ ok: false, status: 409, body: { key: "update_running" } });
    expect(await answer(busy, "busy-now", { action: "now", confirm: CONFIRM })).toMatchObject({ ok: false, status: 409, body: { key: "update_running" } });
    const h = harness({ preflight: action => action === "when-idle" ? { preflight: { id: "P1" } } : null });
    h.offer("2.4.0-beta.1");
    expect(await answer(h, "pre", { action: "when-idle" })).toMatchObject({ ok: false, status: 412, body: { key: "preflight", preflight: { id: "P1" } } });
    expect((await answer(h, "allowed", { action: "not-now" })).ok).toBe(true);
    const open = harness();
    open.offer("2.5.0", { channel: "stable", installable: false });
    expect(await answer(open, "ni", { action: "when-idle" })).toMatchObject({ ok: false, status: 409, body: { key: "card_changed", error: "not_installable" } });
    expect((await answer(open, "show", { action: "not-now" })).ok).toBe(true);
  });

  it("a local wait follows a newer version; Update now cancels that wait and a failed launch returns the offer", async () => {
    const h = harness();
    h.setIdle(false);
    h.setNames([" ", "Ada"]);
    h.offer("2.4.0-beta.1");
    expect((await answer(h, "wait", { action: "when-idle" })).ok).toBe(true);
    expect(h.card.view()).toMatchObject({ state: "waiting-idle", waitingFor: ["Ada"], version: "2.4.0-beta.1" });
    h.offer("2.4.0-beta.2");
    expect(h.card.view()).toMatchObject({ state: "waiting-idle", version: "2.4.0-beta.2" });
    h.launchNow.mockImplementation(async () => ({ ok: false, status: 503, error: "progress_not_recorded" }));
    expect(await answer(h, "fail", { action: "now", confirm: CONFIRM })).toMatchObject({ ok: false, status: 503, body: { error: "progress_not_recorded" } });
    expect(h.card.view()).toMatchObject({ state: "offered", version: "2.4.0-beta.2" });
    expect(h.launched).toEqual([]);
    h.launchNow.mockImplementation(async () => { h.card.beginRun("2.4.0-beta.2"); return { ok: true }; });
    expect((await answer(h, "go", { action: "now", confirm: CONFIRM })).ok).toBe(true);
    expect(h.card.view()).toMatchObject({ state: "updating", version: "2.4.0-beta.2", lastAnswer: { action: "now", by: "Ada" } });
    expect(await answer(h, "stop", { action: "cancel" })).toMatchObject({ ok: false, status: 409, body: { key: "update_running" } });
    h.setIdle(true);
    h.card.tick();
    await new Promise(r => setImmediate(r));
    expect(h.launched).toEqual([]);
  });

  it("a successful idle retarget launches the newer version, and a Hub row is not replaced by a local offer", async () => {
    const h = harness();
    h.setIdle(false);
    h.offer("2.4.0-beta.1");
    await answer(h, "wait", { action: "when-idle" });
    h.offer("2.4.0-beta.2");
    h.setIdle(true);
    h.card.tick();
    await vi.waitFor(() => expect(h.launched).toEqual(["2.4.0-beta.2"]));

    const hub = harness();
    const id = randomUUID();
    hub.card.observeHub(hubRow(id, "2.4.0-beta.9", "waiting", hub.now()));
    hub.offer("9.9.9", { channel: "stable", installable: true });
    expect(hub.card.view()).toMatchObject({ version: "2.4.0-beta.9", state: "waiting-idle" });
    expect(hub.card.blocksAdmission()).toBe(false);
    hub.card.observeHub(hubRow(randomUUID(), "2.4.0-beta.9", "cancelled", hub.now()));
    expect(hub.card.view()?.state).toBe("waiting-idle");
    hub.launchHubNow.mockResolvedValue({ ok: false, status: 409, error: "update_not_started" });
    expect(await answer(hub, "hub-now", { action: "now", confirm: CONFIRM })).toMatchObject({ ok: false, status: 409, body: { key: "update_running", error: "update_not_started" } });
    expect(hub.card.view()).toMatchObject({ version: "2.4.0-beta.9", state: "waiting-idle" });
    expect(hub.cancelHub).not.toHaveBeenCalled();
    hub.card.observeHub(hubRow(id, "2.4.0-beta.9", "done", hub.now()));
    expect(hub.card.view()?.state).toBe("done");
    hub.offer("2.4.0-beta.10");
    expect(hub.card.view()).toMatchObject({ version: "2.4.0-beta.10", state: "offered" });
  });

  it("settles a run only from a marker that belongs to it", () => {
    const h = harness();
    h.offer("2.4.0-beta.1");
    const runAt = h.now();
    h.card.beginRun("2.4.0-beta.1");
    h.card.noteMarker(null);
    h.card.noteMarker({ startedAt: runAt, stage: "complete", operation: "full-restart", version: "2.4.0-beta.1" });
    h.card.noteMarker({ startedAt: runAt - 3_000, stage: "complete", version: "2.4.0-beta.1" });
    h.card.noteMarker({ startedAt: runAt, stage: "complete", version: "2.4.0-beta.9" });
    expect(h.card.view()?.state).toBe("updating");
    h.card.noteMarker({ startedAt: runAt - 1_000, stage: "failed", version: "2.4.0-beta.1", cause: "network" });
    expect(h.card.view()).toMatchObject({ state: "failed", failed: { cause: "network", rolledBack: false } });
    h.offer("2.4.0-beta.2");
    expect(h.card.view()?.state).toBe("offered");
  });

  it("stores a bad answer under its key, and a display label is never a bare id", async () => {
    const h = harness();
    h.offer();
    const bad = await answer(h, "same", { action: "now" });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect(await answer(h, "same", { action: "not-now" })).toEqual(bad);
    const empty = harness();
    expect(await answer(empty, "none", { action: "not-now" })).toMatchObject({ ok: false, status: 409, body: { error: "nothing_offered" } });
    expect((await answer(h, "blank", { action: "not-now" }, "")).ok).toBe(true);
    expect(h.card.view()?.lastAnswer?.by).toBe("admin");
    expect((await answer(h, "who", { action: "not-now" }, "  web-user  ")).ok).toBe(true);
    expect(h.card.view()?.lastAnswer?.by).toBe("web-user");
    expect(updateAnswerLabel("")).toBe("admin");
    expect(updateAnswerLabel("a".repeat(32))).toBe("admin");
    expect(updateAnswerLabel("123456")).toBe("admin");
    expect(updateAnswerLabel("  Ada  ")).toBe("Ada");
    expect(updateAnswerLabel("x".repeat(90)).length).toBe(80);
    expect(updateOfferReply(null, "2.4.0", false)).toEqual({ key: "update.offer.none", args: ["v2.4.0"] });
    expect(updateOfferReply(null, null, true)).toEqual({ key: "update.offer.pinned", args: [] });
    expect(await answer(h, "nope", { action: "cancel" })).toMatchObject({ ok: false, status: 409, body: { key: "card_changed" } });
  });

  it("the idle queue keeps a 24h wait unless the card asks for maxIdleWait, and 0 is invalid", () => {
    const db = new Database(":memory:");
    idleDbs.push(db);
    IDLE_UPDATE_MIGRATION.up(db);
    const now = 1_000_000;
    const queue = new IdleUpdateQueue({ db, now: () => now, current: () => true, allowed: () => true, idle: () => false, launch: async () => false });
    idleQueues.push(queue);
    const twoHours = 2 * 60 * 60_000;
    const row = queue.request({ id: randomUUID(), version: "2.4.0-beta.1", waitMs: twoHours });
    expect(row.expiresAt - row.createdAt).toBe(twoHours);
    expect(queue.cancel(row.id)).toBe(true);
    const kept = queue.request({ id: randomUUID(), version: "2.4.0-beta.24" });
    expect(kept.expiresAt - kept.createdAt).toBe(IDLE_UPDATE_WAIT_MS);
    expect(() => queue.request({ id: randomUUID(), version: "2.4.0-beta.1", waitMs: 0 })).toThrow(/invalid/);
    expect(() => queue.request({ id: randomUUID(), version: "latest", waitMs: twoHours })).toThrow(/invalid/);
    expect(() => queue.request({ id: "not-a-uuid", version: "2.4.0", waitMs: twoHours })).toThrow(/invalid/);
  });

  it("an idle launch reopened with no marker settles, and a later when-idle is accepted", async () => {
    const h = harness();
    h.offer("2.4.0-beta.1");
    expect((await answer(h, "wait", { action: "when-idle" })).ok).toBe(true);
    await vi.waitFor(() => expect(h.launched).toEqual(["2.4.0-beta.1"]));
    expect(h.card.view()?.state).toBe("updating");
    h.reopen();
    expect(h.card.view()?.state).toBe("failed");
    const db = new Database(join(h.dir, "update-idle.sqlite"), { readonly: true, fileMustExist: true });
    idleDbs.push(db);
    expect((db.prepare("SELECT state FROM fleet_idle_updates").get() as { state: string }).state).toBe("failed");
    h.offer("2.4.0-beta.2");
    expect(h.card.view()).toMatchObject({ version: "2.4.0-beta.2", state: "offered" });
    expect((await answer(h, "again", { action: "when-idle" })).ok).toBe(true);
  });

  it("reopening onto the installed version is done, and a restart-stage marker is rolled back", async () => {
    const done = harness({ currentVersion: () => "2.4.0-beta.1" });
    done.offer("2.4.0-beta.1");
    expect((await answer(done, "wait", { action: "when-idle" })).ok).toBe(true);
    await vi.waitFor(() => expect(done.launched).toEqual(["2.4.0-beta.1"]));
    done.reopen();
    expect(done.card.view()?.state).toBe("done");

    const rolled = harness();
    rolled.offer("2.4.0-beta.1");
    expect((await answer(rolled, "wait", { action: "when-idle" })).ok).toBe(true);
    await vi.waitFor(() => expect(rolled.launched).toEqual(["2.4.0-beta.1"]));
    const db = new Database(join(rolled.dir, "update-idle.sqlite"), { readonly: true, fileMustExist: true });
    idleDbs.push(db);
    const id = (db.prepare("SELECT id FROM fleet_idle_updates").get() as { id: string }).id;
    beginUpdateProgress(rolled.dir, { adapterId: "web-update", chatId: "web", messageId: idleUpdateMessageId(id) });
    setUpdateProgressStage(rolled.dir, "starting", { version: "2.4.0-beta.1" });
    rolled.reopen();
    expect(rolled.card.view()).toMatchObject({ state: "failed", failed: { rolledBack: true } });
  });

  it("one idempotency key shares one answer, including a launch still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const launchNow = vi.fn(async () => { await gate; return { ok: true as const }; });
    const h = harness({ launchNow });
    h.offer();
    const body = { action: "now" as const, confirm: CONFIRM };
    const first = answer(h, "once", body);
    const second = answer(h, "once", { action: "not-now" });
    release();
    expect(await first).toEqual(await second);
    expect(launchNow).toHaveBeenCalledTimes(1);
  });

  it("the card's idle wait uses updates.maxIdleWait hours", async () => {
    const h = harness();
    h.setSettings({ maxIdleWait: 2 });
    h.setIdle(false);
    h.offer("2.4.0-beta.1");
    await answer(h, "wait", { action: "when-idle" });
    const db = new Database(join(h.dir, "update-idle.sqlite"), { readonly: true, fileMustExist: true });
    idleDbs.push(db);
    db.pragma("busy_timeout = 5000");
    const row = db.prepare("SELECT created_at, expires_at FROM fleet_idle_updates WHERE state = 'waiting'").get() as { created_at: number; expires_at: number };
    expect(row.expires_at - row.created_at).toBe(2 * 60 * 60_000);
  });

  it("fleet.yaml accepts the four update keys and reports the ones it does not", () => {
    const base = { defaults: { max_cross_instance_message_bytes: 12_288 }, instances: {} };
    expect(validateFleetConfig({ ...base, updates: { mode: "ask", maxIdleWait: 24, pin: null, pause: [{ days: [1], from: "22:00", to: "06:00" }] } }).errors).toEqual([]);
    expect(validateFleetConfig({ ...base, updates: { surprise: true } }).errors).toContainEqual(expect.objectContaining({ path: "updates.surprise" }));
    expect(validateFleetConfig({ ...base, updates: { maxIdleWait: 0 } }).errors).toContainEqual(expect.objectContaining({ path: "updates.maxIdleWait" }));
    expect(validateFleetConfig({ ...base, updates: { pause: [{ days: [1], from: "10:00", to: "10:00" }] } }).errors).toContainEqual(expect.objectContaining({ path: "updates.pause.0.to" }));
    expect(updatesProblems({ mode: "later" })[0]).toMatchObject({ path: "updates.mode" });
    expect(updatesFromRaw({ mode: "nope", maxIdleWait: 0, pin: "  2.4.0-beta.1  ", pause: [{ days: [1], from: "10:00", to: "10:00" }] })).toEqual({ pin: "2.4.0-beta.1" });
    expect(updatesFromRaw(undefined)).toBeUndefined();
  });
});
