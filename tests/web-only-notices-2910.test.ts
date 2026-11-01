/**
 * #2910 D2: a web-only fleet's Notices — what General would have said. On a fleet with no Discord or Telegram
 * connection, fleet errors, an agent's topic notices, a schedule that could not run, the daily summary and an available
 * update are kept in a bounded persisted feed (web-notices.json) and pushed to the dashboard (SSE `notice`), instead of
 * being dropped with a log line. The pointers to General's controls (exit, interactive input) are not kept: those
 * controls are in Needs you there. A fleet with a chat connection is unchanged: nothing is kept, General says them.
 * The store; the fleet's hooks; the routes over a real web server; guests never get one; the page's route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `npm view` for the update check (checkForUpdates), answered from `registry`; the package.json next to the code says `installed`.
const registry = vi.hoisted(() => ({ tags: {} as Record<string, string> }));
const installed = vi.hoisted(() => ({ version: "2.3.3" }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real,
    execFile: ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      const version = cmd === "npm" && args[0] === "view" ? registry.tags[args[1]!] : undefined;
      if (version === undefined) cb(new Error("no such tag")); else cb(null, { stdout: `${version}\n`, stderr: "" });
    }) as never };
});
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readFileSync: ((path: unknown, ...rest: unknown[]) => String(path).endsWith("/package.json")
    ? JSON.stringify({ name: "@songsid/agend", version: installed.version })
    : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync };
});

import { FleetManager } from "../src/fleet-manager.js";
import { WebNotices, NOTICES_MAX, NOTICE_TEXT_MAX, WEB_NOTICES_FILE } from "../src/web-notices.js";
import { placeRef } from "../src/topic-link.js";
import { guestFrameData } from "../src/web-guest-access.js";
import { shellRoute } from "../src/web-shell-routes.js";
import { csrfTokenFor } from "../src/web-session.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
afterEach(() => {
  for (const fm of fleets.splice(0)) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks(); registry.tags = {};
});
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const log = () => ({ warn: vi.fn() });

describe("#2910 D2 the store", () => {
  it("keeps notices with increasing ids, newest first, the newest NOTICES_MAX, text cut; 0600 and read back after a restart", () => {
    const dir = temp("agend-2910-notices-"), path = join(dir, WEB_NOTICES_FILE);
    let now = 1_800_000_000_000;
    const store = new WebNotices(path, log(), () => now++);
    store.add({ kind: "fleet", text: "x".repeat(NOTICE_TEXT_MAX + 10) });
    for (let i = 0; i < NOTICES_MAX + 4; i++) store.add({ kind: "instance", text: `n${i}`, instance: "agent-1" });
    const view = store.view();
    expect([view.items.length, view.items[0]!.text, view.items[0]!.id, view.items.at(-1)!.text, view.unread, (statSync(path).mode & 0o777).toString(8)])
      .toEqual([NOTICES_MAX, `n${NOTICES_MAX + 3}`, NOTICES_MAX + 5, "n4", NOTICES_MAX, "600"]);
    const again = new WebNotices(path, log());
    expect([again.view().items.length, again.add({ kind: "fleet", text: "after" }).id]).toEqual([NOTICES_MAX, NOTICES_MAX + 6]);
    const first = new WebNotices(join(dir, "other.json"), log());
    expect(first.add({ kind: "fleet", text: "y".repeat(NOTICE_TEXT_MAX + 1) }).text.length).toBe(NOTICE_TEXT_MAX);
  });
  it("read: up to an id (never back, never past the newest); unread counts what is newer; latest of a kind", () => {
    const store = new WebNotices(join(temp("agend-2910-seen-"), WEB_NOTICES_FILE), log());
    for (const kind of ["fleet", "update", "instance", "update"] as const) store.add({ kind, text: kind });
    expect([store.markSeen(2), store.unread(), store.markSeen(1), store.markSeen(99), store.unread(), store.latest("update")?.id, store.latest("summary")])
      .toEqual([2, 2, 2, 4, 0, 4, null]);
  });
  it("a file that is not its own is not believed: bad rows and ids that do not increase are dropped; garbage reads as none", () => {
    const dir = temp("agend-2910-tamper-"), path = join(dir, WEB_NOTICES_FILE);
    writeFileSync(path, JSON.stringify({ v: 1, next: 1, seen: 50, items: [
      { id: 3, at: 1, kind: "fleet", text: "a" }, { id: 2, at: 1, kind: "fleet", text: "older id" }, { id: 4, at: 1, kind: "bogus", text: "b" },
      { id: 5, at: 1, kind: "instance", text: "c", instance: "" }, { id: 6, at: 1, kind: "update", text: "d" }] }));
    const store = new WebNotices(path, log());
    expect([store.view().items.map(n => n.id), store.view().seen, store.add({ kind: "fleet", text: "e" }).id]).toEqual([[6, 3], 6, 7]);
    writeFileSync(path, "{nope");
    const l = log();
    expect([new WebNotices(path, l).view().items, l.warn.mock.calls.length]).toEqual([[], 1]);
  });
});

function fleet(config: Record<string, unknown> = {}) {
  const dir = temp("agend-2910-dnotice-");
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir); fleets.push(fm);
  fm.fleetConfig = { defaults: {}, instances: { "agent-1": { working_directory: dir } }, ...config } as never;
  const sse: Array<[string, any]> = [];
  vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { sse.push([event, data]); });
  return { fm, any: fm as any, dir, sse, notices: () => (fm as any).webNoticeStore().view().items as Array<Record<string, unknown>> };
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };

describe("#2910 D2 the fleet: what would have gone to General is a Notice", () => {
  it("a fleet error: kept and pushed; it spends the throttle like a post (the same one again is not kept twice)", () => {
    const f = fleet();
    expect([f.fm.notifyFleetError("Something broke"), f.fm.notifyFleetError("Something broke")]).toEqual([true, false]);
    expect(f.notices().map(n => [n.kind, n.text, "instance" in n])).toEqual([["fleet", "Something broke", false]]);
    expect(f.sse).toEqual([["notice", { notice: expect.objectContaining({ id: 1, kind: "fleet", text: "Something broke" }), unread: 1 }]]);
  });
  it("an agent's topic notice: kept about that agent, place tokens as plain names; an unknown name is not linked", () => {
    const f = fleet();
    expect(f.fm.notifyInstanceTopic("agent-1", `crashed, see ${placeRef({ kind: "instance", name: "agent-1" }, "agent-1")}`)).toBe(true);
    f.fm.notifyInstanceTopic("ghost", "about nobody");
    expect(f.notices().map(n => [n.kind, n.instance, n.text])).toEqual([["instance", undefined, "about nobody"], ["instance", "agent-1", "crashed, see agent-1"]]);
  });
  it("a schedule that could not run (about its target) and the daily summary", () => {
    const f = fleet();
    f.any.notifyScheduleFailure({ id: "s1", label: "nightly", target: "agent-1", reply_chat_id: "web", source: "web" });
    f.any.postDailySummary("📊 today");
    expect(f.notices().map(n => [n.kind, n.instance, n.text])).toEqual([["summary", undefined, "📊 today"],
      ["schedule", "agent-1", '⏰ Schedule "nightly" trigger failed: instance agent-1 is offline.']]);
  });
  it("the pointers to General's controls are not kept (exit, interactive input): the controls are in Needs you", async () => {
    const f = fleet();
    vi.spyOn(f.any, "postNonceButtonPrompt").mockResolvedValue(undefined);
    await f.fm.notifyInteractivePrompt("agent-1", "trust");
    await f.any.notifyNormalExit?.("agent-1");
    expect(f.notices().filter(n => /General/.test(String(n.text)))).toEqual([]);
  });
  it("an available update: once per version, worded for this computer (agend update), not /update", async () => {
    setLocale("en");
    const f = fleet();
    registry.tags = { "@songsid/agend": "2.3.4" };
    await f.any.checkForUpdates(); await f.any.checkForUpdates();
    registry.tags = { "@songsid/agend": "2.3.5" };
    await f.any.checkForUpdates();
    expect(f.notices().map(n => [n.kind, n.text])).toEqual([
      ["update", "🆕 AgEnD v2.3.5 available (current: v2.3.3). Install it on this computer: agend update"],
      ["update", "🆕 AgEnD v2.3.4 available (current: v2.3.3). Install it on this computer: agend update"]]);
  });
  it("a fleet with a chat connection: unchanged — nothing kept or pushed, no feed (General says them)", async () => {
    const f = fleet(CHAT);
    f.fm.notifyFleetError("Something broke"); f.fm.notifyInstanceTopic("agent-1", "x"); f.any.postDailySummary("📊");
    registry.tags = { "@songsid/agend": "2.3.4" };
    await f.any.checkForUpdates();
    expect([f.notices(), f.sse.filter(([e]) => e === "notice"), f.fm.webNoticesFeed()]).toEqual([[], [], null]);
  });
});

describe("#2910 D2 guests never get a notice", () => {
  it("the stream's guest filter drops it (default deny)", () => {
    const notice = { notice: { id: 1, at: 1, kind: "instance", instance: "agent-1", text: "x" }, unread: 1 };
    expect([guestFrameData("notice", notice, new Set(["agent-1"])), guestFrameData("notice", { ...notice, instance: "agent-1" }, new Set(["agent-1"]),
      { owner: { adapterId: "dc", userId: "1" }, history: () => ({}) } as never)]).toEqual([undefined, undefined]);
  });
});

// ── The routes, over a real web server ──
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
async function served(config: Record<string, unknown> = {}) {
  setLocale("en");
  const f = fleet(config);
  f.fm.logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => f.fm.logger } as never;
  f.any.initializeWebAuthTokens(); f.any.startHealthServer(0);
  await vi.waitFor(() => expect(f.fm.getDashboardAccess().ready).toBe(true));
  const port = ((f.any.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const code = f.fm.issueDashboardLogin()!.display;
  const login = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code }));
  const set = login.headers["set-cookie"]; const cookie = (Array.isArray(set) ? set[0] : set).split(";")[0] as string;
  const S = { cookie, origin, "content-type": "application/json", "x-agend-csrf": csrfTokenFor(cookie.split("=")[1]!) };
  const stop = () => new Promise<void>(r => { const s = f.any.healthServer as Server; f.any.healthServer = null; s.close(() => r()); });
  return { ...f, port, S, stop };
}

describe("#2910 D2 the routes", () => {
  it("web-only: the list (newest first, unread); marking read; no session: refused; the page is the app shell", async () => {
    const h = await served();
    try {
      h.fm.notifyFleetError("one"); h.fm.notifyFleetError("two");
      const list = JSON.parse((await raw(h.port, "GET", "/ui/notices/list", { cookie: h.S.cookie })).body);
      // The sign-in itself was the first notice (web.login_notice: a sign-in General would have been told of).
      expect([list.enabled, list.items.map((n: any) => n.text).slice(0, 2), /^🔐 New web sign-in: .* If this was not you, run agend web-token rotate on this computer/.test(list.items[2].text), list.unread]).toEqual([true, ["two", "one"], true, 3]);
      const seen = await raw(h.port, "POST", "/ui/notices/seen", h.S, JSON.stringify({ id: list.items[1].id }));
      expect([seen.status, JSON.parse(seen.body)]).toEqual([200, { seen: 2, unread: 1 }]);
      expect((await raw(h.port, "POST", "/ui/notices/seen", h.S, JSON.stringify({ id: "2" }))).status).toBe(400);
      expect((await raw(h.port, "GET", "/ui/notices/list")).status).toBe(401);
      expect((await raw(h.port, "POST", "/ui/notices/seen", { cookie: h.S.cookie, origin: h.S.origin, "content-type": "application/json" }, JSON.stringify({ id: 1 }))).status).toBe(403);
      expect(shellRoute("GET", "/ui/notices")).toEqual({ kind: "shell", route: { panel: "notices" } });
    } finally { await h.stop(); }
  }, 20_000);
  it("a chat fleet: no feed (enabled false), and marking read is not found", async () => {
    const h = await served(CHAT);
    try {
      expect(JSON.parse((await raw(h.port, "GET", "/ui/notices/list", { cookie: h.S.cookie })).body)).toEqual({ enabled: false, items: [], seen: 0, unread: 0 });
      expect((await raw(h.port, "POST", "/ui/notices/seen", h.S, JSON.stringify({ id: 1 }))).status).toBe(404);
    } finally { await h.stop(); }
  }, 20_000);
});

describe("#2910 D2 the page", () => {
  it("its route both ways; its sidebar entry only on a web-only fleet with the feed on; the stream hears `notice`", async () => {
    const r = await import("../src/ui/shared/app-route.js" as string);
    expect([r.parseRoute("/ui/notices"), r.routePath({ panel: "notices" }), r.routeKey({ panel: "notices" })]).toEqual([{ panel: "notices" }, "/ui/notices", "notices:"]);
    const shell = readFileSync(join(process.cwd(), "src/ui/shared/app-shell.js"), "utf8");
    expect(shell).toContain('app.connections === 0 && app.notices && app.notices.enabled ? navLink("notices", NOTICES_PATH, "bell"');
    expect(readFileSync(join(process.cwd(), "src/ui/shared/app-stream.js"), "utf8")).toMatch(/const EVENTS = \[[^\]]*"notice"\]/);
  });
});
