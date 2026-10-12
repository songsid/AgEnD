/**
 * #1724 (design: the comment on #1724): Fleet → Schedules reads like a person would say it — a one-shot's time and every
 * row's next run in the fleet's zone (worked out by the server: scheduleView), a cron in words in the page's language, a
 * disabled row that looks disabled — and a schedule can be edited: the same form, filled in, saved with PATCH, which the
 * host validates and applies exactly as the update_schedule tool does (UpdateScheduleArgs, scheduler.update — cron and
 * at clear each other). Create takes the create_schedule tool's schema (cron or at). None of it over the public link.
 * A real Scheduler on a scratch database; the real panel in a mini DOM.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler, DEFAULT_SCHEDULER_CONFIG } from "../src/scheduler/index.js";
import type { Schedule } from "../src/scheduler/types.js";
import { scheduleView } from "../src/web-schedules.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { fire, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const TZ = "Asia/Taipei";
const base = (o: Partial<Schedule> = {}): Schedule => ({
  id: "s1", cron: null, at: null, message: "check the build", source: "web", target: "alpha", reply_chat_id: "", reply_thread_id: null,
  reply_adapter_id: null, label: null, enabled: true, timezone: TZ, silent: false, created_at: "2026-10-12T00:00:00Z", last_triggered_at: null, last_status: null, ...o,
});

describe("scheduleView: what the row reads, worked out on the server", () => {
  const now = Date.parse("2026-10-13T00:00:00Z");   // 08:00 in Taipei
  it("a one-shot: its time (and next run) in the fleet's zone", () => {
    const v = scheduleView(base({ at: "2026-10-13T14:00:00+08:00" }), null, now, TZ);
    expect([v.at_text, v.next_run_ms, v.next_run_text, v.retrying]).toEqual(["2026-10-13 14:00 (UTC+8)", Date.parse("2026-10-13T06:00:00Z"), "2026-10-13 14:00 (UTC+8)", false]);
  });
  it("a cron: its next occurrence in the schedule's own timezone, shown in the fleet's", () => {
    const v = scheduleView(base({ cron: "0 18 * * 1-5" }), null, now, TZ);       // Tue 2026-10-13
    expect([v.next_run_text, v.at_text]).toEqual(["2026-10-13 18:00 (UTC+8)", null]);
    const ny = scheduleView(base({ cron: "0 9 * * *", timezone: "America/New_York" }), null, now, TZ);
    expect(ny.next_run_text, "09:00 New York is 21:00 Taipei").toBe("2026-10-13 21:00 (UTC+8)");
  });
  it("disabled: no next run; a past one-shot: retrying when a retry is pending, else nothing; a bad cron: nothing, no throw", () => {
    const off = scheduleView(base({ cron: "0 18 * * *", enabled: false }), null, now, TZ);
    const retry = { schedule_id: "s1", run_id: "r", deferred_at_ms: 0, deferred_pct: 95, resets_at_ms: null, due_at_ms: now + 60_000, deadline_ms: now + 3_600_000, deadline_kind: "cap" as const };
    const pastRetrying = scheduleView(base({ at: "2026-10-12T14:00:00+08:00" }), retry, now, TZ);
    const pastDone = scheduleView(base({ at: "2026-10-12T14:00:00+08:00" }), null, now, TZ);
    const bad = scheduleView(base({ cron: "not a cron" }), null, now, TZ);
    expect([off.next_run_ms, [pastRetrying.retrying, pastRetrying.next_run_ms], [pastDone.retrying, pastDone.next_run_ms], bad.next_run_ms])
      .toEqual([null, [true, now + 60_000], [false, null], null]);
  });
});

// ── The routes, on a real scheduler ──

const token = "t".repeat(48);
let dir = "", scheduler: Scheduler;
beforeEach(() => {
  // The fleet's zone is the host's (formatFleetTime, #1586): pinned, so the list reads the same on any machine (CI is UTC).
  vi.stubEnv("TZ", TZ);
  dir = mkdtempSync(join(tmpdir(), "agend-1724-"));
  scheduler = new Scheduler(join(dir, "scheduler.db"), () => {}, { ...DEFAULT_SCHEDULER_CONFIG }, (n) => n === "alpha" || n === "beta");
});
afterEach(() => { scheduler.shutdown(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function call(method: string, path: string, body?: unknown, opts: { publicLink?: boolean; revoke?: boolean } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com";
  const s = opts.publicLink || opts.revoke ? sessions.create({ tier: "admin", surface: opts.publicLink ? "gateway" : "local", exposureId: opts.publicLink ? exposureId : undefined, label: "t", tokenEpoch: tokenEpoch(token) } as never) : null;
  const headers: Record<string, string> = opts.publicLink
    ? { host: "sample.trycloudflare.com", cookie: `__Host-agend_session=${s!.sessionId}`, origin: pub, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s!.sessionId), "content-type": "application/json" }
    : opts.revoke ? { host: "127.0.0.1:19280", cookie: `agend_session=${s!.sessionId}`, origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s!.sessionId), "content-type": "application/json" }
      : { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" };
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (opts.publicLink) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
    handleWebRequest(req as never, res as never, new URL(path, opts.publicLink ? pub : "http://127.0.0.1:19280"),
      { webToken: token, webSessions: sessions, scheduler, fleetConfig: { instances: { alpha: {}, beta: {} }, defaults: { scheduler: { default_timezone: TZ } } }, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
    if (opts.revoke) sessions.revokeById(s!.sessionId);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); } else { req.emit("end"); }
  });
}
const AT = "2030-01-02T09:30:00+08:00";

describe("create (the create_schedule schema: cron or at)", () => {
  it("a repeating one, and a one-time one (at) — both stored; the list shows them with their times and the default timezone", async () => {
    const a = await call("POST", "/ui/schedules", { cron: "0 18 * * 1-5", message: "standup", target: "alpha", label: "Standup" });
    const b = await call("POST", "/ui/schedules", { at: AT, message: "deploy", target: "beta" });
    const list = await call("GET", "/ui/schedules");
    const rows = list.body.schedules.map((s: any) => [s.label, s.cron, s.at, s.target, s.source, !!s.next_run_text, s.at_text]);
    expect([a.status, b.status, list.body.default_timezone]).toEqual([200, 200, TZ]);
    expect(rows).toEqual(expect.arrayContaining([["Standup", "0 18 * * 1-5", null, "alpha", "web", true, null], [null, null, AT, "beta", "web", true, expect.stringMatching(/^2030-01-02 09:30 \(UTC\+8\)$/)]]));
  });
  it("refused: both cron and at, neither, an at without an offset, no target", async () => {
    const outcomes = [];
    for (const body of [{ cron: "0 9 * * *", at: AT, message: "m", target: "alpha" }, { message: "m", target: "alpha" }, { at: "2030-01-02T09:30:00", message: "m", target: "alpha" }, { cron: "0 9 * * *", message: "m" }]) {
      const r = await call("POST", "/ui/schedules", body);
      outcomes.push(r.status);
      if (!("target" in body)) expect(r.body.error, "the web names the target").toBe("target: an instance is required");
    }
    expect([outcomes, scheduler.list().length]).toEqual([[400, 400, 400, 400], 0]);
  });
});

describe("edit (PATCH): the update_schedule tool's validation and update", () => {
  it("message, label, target, enabled — changed; silent kept", async () => {
    const s = scheduler.create({ cron: "0 9 * * *", message: "old", source: "agent", target: "alpha", reply_chat_id: "", reply_thread_id: null, silent: true });
    const r = await call("PATCH", `/ui/schedules/${s.id}`, { message: "new", label: "Morning", target: "beta", enabled: false });
    const got = scheduler.get(s.id)!;
    expect([r.status, got.message, got.label, got.target, got.enabled, got.silent, got.cron]).toEqual([200, "new", "Morning", "beta", false, true, "0 9 * * *"]);
  });
  it("switching: a cron one made one-time clears the cron; back to a cron clears at", async () => {
    const s = scheduler.create({ cron: "0 9 * * *", message: "m", source: "agent", target: "alpha", reply_chat_id: "", reply_thread_id: null });
    await call("PATCH", `/ui/schedules/${s.id}`, { at: AT });
    const once = scheduler.get(s.id)!;
    await call("PATCH", `/ui/schedules/${s.id}`, { cron: "*/15 * * * *" });
    const again = scheduler.get(s.id)!;
    expect([[once.cron, once.at], [again.cron, again.at]]).toEqual([[null, AT], ["*/15 * * * *", null]]);
  });
  it("refused like the tool: both cron and at, an at without an offset, a wrong type, an unknown target, an id in the body, a missing schedule — nothing changes", async () => {
    const s = scheduler.create({ cron: "0 9 * * *", message: "m", source: "agent", target: "alpha", reply_chat_id: "", reply_thread_id: null });
    const outcomes = [];
    for (const body of [{ cron: "0 8 * * *", at: AT }, { at: "2030-01-02T09:30:00" }, { enabled: "yes" }, { target: "ghost" }, { id: "other", message: "x" }]) {
      outcomes.push((await call("PATCH", `/ui/schedules/${s.id}`, body)).status);
    }
    const missing = await call("PATCH", "/ui/schedules/nope", { message: "x" });
    const after = scheduler.get(s.id)!;
    expect([outcomes, missing.status, after.cron, after.at, after.message, after.target, after.enabled]).toEqual([[400, 400, 400, 400, 400], 400, "0 9 * * *", null, "m", "alpha", true]);
  });
  it("re-authorized once the body is in: a session revoked meanwhile edits nothing (401)", async () => {
    const s = scheduler.create({ cron: "0 9 * * *", message: "m", source: "agent", target: "alpha", reply_chat_id: "", reply_thread_id: null });
    const r = await call("PATCH", `/ui/schedules/${s.id}`, { message: "changed" }, { revoke: true });
    const c = await call("POST", "/ui/schedules", { cron: "0 9 * * *", message: "x", target: "alpha" }, { revoke: true });
    expect([r.status, scheduler.get(s.id)!.message, c.status, scheduler.list().length]).toEqual([401, "m", 401, 1]);
  });
});

describe("the public link: lists, never writes", () => {
  it("off its manifest: create, edit, delete; the list stays", () => {
    expect([isPublicWebRoute("POST", "/ui/schedules"), isPublicWebRoute("PATCH", "/ui/schedules/s1"), isPublicWebRoute("DELETE", "/ui/schedules/s1"), isPublicWebRoute("GET", "/ui/schedules")])
      .toEqual([false, false, false, true]);
  });
  it("and refused by the handlers (403) — nothing created, edited or deleted", async () => {
    const s = scheduler.create({ cron: "0 9 * * *", message: "m", source: "agent", target: "alpha", reply_chat_id: "", reply_thread_id: null });
    const c = await call("POST", "/ui/schedules", { cron: "0 9 * * *", message: "x", target: "alpha" }, { publicLink: true });
    const e = await call("PATCH", `/ui/schedules/${s.id}`, { message: "changed" }, { publicLink: true });
    const d = await call("DELETE", `/ui/schedules/${s.id}`, undefined, { publicLink: true });
    expect([[c.status, c.body.error], [e.status, e.body.error], [d.status, d.body.error], scheduler.list().length, scheduler.get(s.id)!.message])
      .toEqual([[403, "schedule_not_over_public_link"], [403, "schedule_not_over_public_link"], [403, "schedule_not_over_public_link"], 1, "m"]);
  });
});

// ── The tab ──

describe("the Schedules tab", () => {
  const mounted: AppPage[] = [];
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  afterEach(async () => {
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    (globalThis as { fetch?: unknown }).fetch = realFetch;
    (await import("/assets/app-i18n.js")).setLang("en");
  });
  const ROWS = [
    { ...base({ id: "a", cron: "0 18 * * 1-5", label: "Standup" }), next_run_text: "2026-10-13 18:00 (UTC+8)", at_text: null, retrying: false },
    { ...base({ id: "b", at: "2026-10-13T14:00:00+08:00", message: "deploy the release to staging and tell the channel when it is done, with the version" }), next_run_text: "2026-10-13 14:00 (UTC+8)", at_text: "2026-10-13 14:00 (UTC+8)", retrying: false },
    // A disabled row's next run (as an older server might still send it) is not shown.
    { ...base({ id: "c", cron: "*/15 * * * *", enabled: false, label: "Poll", target: "beta" }), next_run_text: "2026-10-13 08:15 (UTC+8)", at_text: null, retrying: false },
    { ...base({ id: "d", cron: "0 21 * * *", label: "Nightly", silent: true }), next_run_text: "2026-10-13 21:00 (UTC+8)", at_text: null, retrying: false },
  ];
  async function tab(opts: { publicLink?: boolean; lang?: string } = {}) {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/schedules", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    if (opts.publicLink) pg.document.body.setAttribute("data-public-link", "1");
    if (opts.lang) (await import("/assets/app-i18n.js")).setLang(opts.lang);
    const writes: Array<{ path: string; method: string; body: any }> = [];
    (globalThis as { fetch?: unknown }).fetch = async (path: string, init: any = {}) => {
      if ((init.method ?? "GET") !== "GET") { writes.push({ path, method: init.method, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ schedules: ROWS, default_timezone: TZ }) };
    };
    const { startRouter } = await import("/assets/app-nav.js");
    const { applyStatus } = await import("/assets/app-store.js");
    // @ts-expect-error — a JS module of the app, with no types
    const { FleetPanel } = await import("../src/ui/panel-fleet.js");
    startRouter(pg.window);
    applyStatus({ instances: [{ name: "alpha", status: "running", display_name: "Alice" }, { name: "beta", status: "running" }] });
    await pg.mount(h(FleetPanel, { route: { panel: "fleet", tab: "schedules" }, navKey: `fleet:schedules|${opts.publicLink ? 1 : 0}|${opts.lang || "en"}` }));
    await settle(6);
    return { pg, writes };
  }
  const row = (pg: AppPage, i: number) => pg.root.querySelectorAll(".row-item.sched")[i] as any;
  const text = (el: any, sel: string) => el.querySelector(sel)?.textContent ?? null;

  it("each row: its name, the schedule in words, the next run, the target's display name; the raw cron in the tooltip", async () => {
    const { pg } = await tab();
    const got = [0, 1, 2, 3].map((i) => [text(row(pg, i), ".sched-title"), text(row(pg, i), ".sched-when"), text(row(pg, i), ".sched-next"), text(row(pg, i), ".sched-sub a")]);
    expect(got).toEqual([
      ["Standup", "Weekdays 18:00", "next 2026-10-13 18:00 (UTC+8)", "Alice"],
      ["deploy the release to staging and tell the channel when it i…", "Once · 2026-10-13 14:00 (UTC+8)", "next 2026-10-13 14:00 (UTC+8)", "Alice"],
      ["Poll", "Every 15 minutes", null, "beta"],
      ["Nightly", "Daily 21:00", "next 2026-10-13 21:00 (UTC+8)", "Alice"],
    ]);
    expect([row(pg, 0).getAttribute("title"), row(pg, 1).getAttribute("title"), row(pg, 3).getAttribute("title")])
      .toEqual(["0 18 * * 1-5 · Timezone: Asia/Taipei", "2026-10-13T14:00:00+08:00 · Timezone: Asia/Taipei", "0 21 * * * · Timezone: Asia/Taipei · silent"]);
    // A one-shot's cron is null: never shown as "" or "null" anywhere in its row.
    expect(row(pg, 1).textContent).not.toMatch(/null/);
    expect(text(row(pg, 1), ".sched-when")).not.toBe("");
  });

  it("a disabled schedule looks disabled: its own badge, a dimmed row, no next run", async () => {
    const { pg } = await tab();
    const off = row(pg, 2), on = row(pg, 0);
    expect([off.className.includes("is-off"), text(off, ".pill"), off.querySelector(".pill").className, on.className.includes("is-off"), text(on, ".pill"), on.querySelector(".pill").className])
      .toEqual([true, "disabled", "pill off", false, "on", "pill open"]);
  });

  it("zh-TW: the words, 一次, 已停用", async () => {
    const { pg } = await tab({ lang: "zh-TW" });
    expect([text(row(pg, 0), ".sched-when"), text(row(pg, 1), ".sched-when"), text(row(pg, 2), ".sched-when"), text(row(pg, 3), ".sched-when"), text(row(pg, 2), ".pill")])
      .toEqual(["每週一到五 18:00", "一次 · 2026-10-13 14:00 (UTC+8)", "每 15 分鐘", "每天 21:00", "已停用"]);
  });

  it("Edit opens the form filled in; Save sends PATCH with the fields; Once sends at in the timezone, and no cron", async () => {
    const { pg, writes } = await tab();
    fire(row(pg, 0).querySelector("button.sched-edit"), "click"); await settle(4);
    const dialog = pg.document.querySelector(".dialog, [role=dialog]") as any ?? pg.root;
    const inputs = [...dialog.querySelectorAll("input")] as any[];
    const val = (v: string) => inputs.some((i) => i.value === v);
    const enabled = inputs.find((i) => i.type === "checkbox");
    expect([val("0 18 * * 1-5"), val("check the build"), val("Standup"), val(TZ), enabled?.checked, dialog.querySelector("select").value]).toEqual([true, true, true, true, true, "alpha"]);
    const save = () => ([...pg.root.querySelectorAll("button")] as any[]).find((b) => b.textContent.trim() === "Save changes");
    const cron = inputs.find((i) => i.value === "0 18 * * 1-5");
    cron.value = "30 7 * * *"; fire(cron, "input"); await settle();
    fire(save(), "click"); await settle(6);
    // Once: the toggle, a date and time.
    fire(row(pg, 0).querySelector("button.sched-edit"), "click"); await settle(4);
    const d2 = pg.document.querySelector(".dialog, [role=dialog]") as any ?? pg.root;
    fire(([...d2.querySelectorAll(".sched-mode button")] as any[]).find((b) => b.textContent === "Once"), "click"); await settle();
    const when = d2.querySelector('input[type="datetime-local"]');
    when.value = "2026-12-24T20:00"; fire(when, "input"); await settle();
    fire(save(), "click"); await settle(6);
    expect(writes).toEqual([
      { path: "/ui/schedules/a", method: "PATCH", body: { message: "check the build", target: "alpha", cron: "30 7 * * *", label: "Standup", enabled: true, timezone: TZ } },
      { path: "/ui/schedules/a", method: "PATCH", body: { message: "check the build", target: "alpha", at: "2026-12-24T20:00:00+08:00", label: "Standup", enabled: true, timezone: TZ } },
    ]);
  });

  it("a one-shot edits as Once, its time shown in its timezone; New schedule can create a one-time one", async () => {
    const { pg, writes } = await tab();
    fire(row(pg, 1).querySelector("button.sched-edit"), "click"); await settle(4);
    const d = pg.document.querySelector(".dialog, [role=dialog]") as any ?? pg.root;
    expect([d.querySelector('input[type="datetime-local"]')?.value, ([...d.querySelectorAll(".sched-mode button")] as any[]).map((b) => b.getAttribute("aria-pressed"))]).toEqual(["2026-10-13T14:00", ["false", "true"]]);
    fire(([...pg.root.querySelectorAll("button")] as any[]).find((b) => b.textContent.trim() === "Cancel"), "click"); await settle(4);
    fire(pg.root.querySelector(".list-head button"), "click"); await settle(4);
    const n = pg.document.querySelector(".dialog, [role=dialog]") as any ?? pg.root;
    fire(([...n.querySelectorAll(".sched-mode button")] as any[]).find((b) => b.textContent === "Once"), "click"); await settle();
    const when = n.querySelector('input[type="datetime-local"]'); when.value = "2026-11-01T08:15"; fire(when, "input");
    const msg = ([...n.querySelectorAll("input")] as any[]).find((i) => i.type !== "datetime-local" && i.type !== "checkbox" && i.value === "");
    msg.value = "renew the cert"; fire(msg, "input"); await settle();
    fire(([...pg.root.querySelectorAll("button")] as any[]).find((b) => b.textContent.trim() === "Create"), "click"); await settle(6);
    expect(writes).toEqual([{ path: "/ui/schedules", method: "POST", body: { message: "renew the cert", target: "alpha", at: "2026-11-01T08:15:00+08:00", timezone: TZ } }]);   // the zone the time was read in
  });

  it("the public link lists the schedules but offers no New, Edit or Delete", async () => {
    const { pg } = await tab({ publicLink: true });
    expect([pg.root.querySelectorAll(".row-item.sched").length, pg.root.querySelector("button.sched-edit"), pg.root.querySelector(".list-head button"), pg.root.querySelector(".row-item button.danger")])
      .toEqual([4, null, null, null]);
  });
});

describe("wall time ↔ ISO in a timezone", () => {
  afterAll(() => {});
  it("Taipei, New York in winter and summer; bad input or zone → null / empty", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const { wallToIso, isoToWall } = await import("../src/ui/panel-fleet.js");
    expect([wallToIso("2026-12-24T20:00", "Asia/Taipei"), wallToIso("2026-01-15T09:00", "America/New_York"), wallToIso("2026-07-15T09:00", "America/New_York"), wallToIso("2026-07-15T09:00", "Asia/Kolkata")])
      .toEqual(["2026-12-24T20:00:00+08:00", "2026-01-15T09:00:00-05:00", "2026-07-15T09:00:00-04:00", "2026-07-15T09:00:00+05:30"]);
    // Just after the spring-forward jump (02:00 → 03:00 on 2026-03-08): the offset at that instant is EDT, not EST.
    expect(wallToIso("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T03:30:00-04:00");
    expect([isoToWall("2026-12-24T12:00:00Z", "Asia/Taipei"), wallToIso("nope", TZ), wallToIso("2026-12-24T20:00", "Not/AZone"), isoToWall("x", TZ)]).toEqual(["2026-12-24T20:00", null, null, ""]);
  });
});
