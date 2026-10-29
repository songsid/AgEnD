/**
 * #2855 part 3: a Trusted guest (web.guests.grants[account].level: trusted) — a read-only View and search of what it can
 * see; a Chat-level guest is refused both. Live, through the fleet's own gate and handlers:
 * - the level: config, Settings' patch, the page's marker (data-guest-level), guestTrusted only on an explicit grant;
 * - GET /api/pane/<n>: Trusted only, in scope; 2 reads a second and 2 agents at once per account; one capture shared by
 *   every guest viewer within 500 ms; at most 256 KB (the end kept); never cached. A guest's cookie goes through the
 *   guest gate on the local listener too, where an anonymous View read does not;
 * - GET /ui/search[/context]: Trusted only; chat and its scope only (no team, no "only mine"); each hit kept only when
 *   its history row is one the guest may see, at most 20; 6 a minute and one at a time per account, 3 in all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-2855t-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");
const { resetGuestPanes } = await import("../src/view-api.js");
const { tmuxExecHelper } = await import("../src/tmux-exec-helper.js");
const { validateFleetConfig } = await import("../src/config-validator.js");
const { guestsPatch } = await import("../src/web-settings-patch.js");
const { settingsChangeDiff } = await import("../src/settings-change.js");
const { GUEST_PANE_MAX_BYTES, GUEST_SEARCHES } = await import("../src/web-guest-access.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" }, BOB = { adapterId: "discord", userId: "222222222222222222" };
const keyOf = (o: typeof ALICE) => `${o.adapterId}:${o.userId}`;
interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string;
const get = (sid: string | null, path: string, extra: Record<string, string> = {}) =>
  raw(port, "GET", path, { ...(sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {}), ...extra });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-2855t-fleet-"));
  const inst = (n: string) => `  ${n}:\n    working_directory: ${dir}\n    backend: claude-code\n`;
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n${inst("a")}${inst("b")}${inst("c")}`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  // Each agent has a window, so a pane read reaches the (stubbed) tmux.
  for (const n of ["a", "b", "c"]) { mkdirSync(join(fm.dataDir, "instances", n), { recursive: true }); writeFileSync(join(fm.dataDir, "instances", n, "window-id"), "@1"); }
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
let tmux: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetGuestPanes();
  fm.guestSearches = new (fm.guestSearches.constructor)(undefined, { perWindow: GUEST_SEARCHES.perWindow, windowMs: GUEST_SEARCHES.windowMs });
  // Never the real tmux: capture-pane answers this screen, display-message its size.
  tmux = vi.fn(async (_file: string, args: string[]) => ({ stdout: args.includes("capture-pane") ? "\u001b[1mhello\u001b[0m pane\n" : "120x40\n", stderr: "" }));
  vi.spyOn(tmuxExecHelper, "exec").mockImplementation(tmux as never);
});
afterEach(() => { vi.restoreAllMocks(); delete fm.fleetConfig.web; delete fm.searchIndex; fm.searchIndex = null; });
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;
/** Guests on; Alice granted `a` (and more) at a level; Bob too when asked. */
function grants(level: "chat" | "trusted" | undefined, more: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  fm.fleetConfig.web = { ...extra, guests: { enabled: true, grants: { [keyOf(ALICE)]: { instances: ["a"], ...(level ? { level } : {}) }, ...more } } };
}
const captures = () => tmux.mock.calls.filter((c) => (c[1] as string[]).includes("capture-pane")).length;

describe("the level", () => {
  it("fleet.yaml: chat or trusted; anything else is refused", () => {
    const cfg = (level: unknown) => ({ instances: { a: { working_directory: "/tmp", backend: "claude-code" } }, web: { guests: { enabled: true, grants: { "discord:1": { instances: ["a"], level } } } } });
    const errs = (level: unknown) => validateFleetConfig(cfg(level)).errors.filter((e: { path: string }) => e.path.includes("grants"));
    expect([errs("chat"), errs("trusted"), errs(undefined)]).toEqual([[], [], []]);
    expect(errs("admin").map((e: { path: string }) => e.path)).toEqual(["web.guests.grants.discord:1.level"]);
  });
  it("Settings' patch keeps trusted, stores chat as no level, refuses anything else", () => {
    expect(guestsPatch({ grants: { "discord:1": { instances: ["a"], level: "trusted" }, "discord:2": { instances: ["a"], level: "chat" } } }))
      .toEqual({ grants: { "discord:1": { instances: ["a"], level: "trusted" }, "discord:2": { instances: ["a"] } } });
    expect(guestsPatch({ grants: { "discord:1": { instances: ["a"], level: "owner" } } })).toBe("invalid");
  });
  it("Chat → Trusted widens (a fleet admin confirms it); Trusted → Chat takes away (at once)", () => {
    const at = (level?: string) => ({ fleet: { web: { guests: { enabled: true, grants: { "dc:111": { instances: ["a"], ...(level ? { level } : {}) } } } } } });
    const up = settingsChangeDiff(at(), at("trusted"), { operation: "fleet" });
    expect(up?.section).toBe("access");
    expect(up?.summary.join("\n")).toContain("grants.dc:111");
    expect(settingsChangeDiff(at("trusted"), at(), { operation: "fleet" })).toBeNull();
  });
  it("guestTrusted: only an explicit grant at trusted, while guest sign-in is on", () => {
    expect(fm.guestTrusted(ALICE)).toBe(false);
    grants("trusted"); expect([fm.guestTrusted(ALICE), fm.guestTrusted(BOB)]).toEqual([true, false]);
    grants("chat"); expect(fm.guestTrusted(ALICE)).toBe(false);
    grants("trusted"); fm.fleetConfig.web.guests.enabled = false; expect(fm.guestTrusted(ALICE)).toBe(false);
    // An inherited key is never a grant.
    fm.fleetConfig.web = { guests: { enabled: true, grants: Object.create({ [keyOf(ALICE)]: { instances: ["a"], level: "trusted" } }) } };
    expect(fm.guestTrusted(ALICE)).toBe(false);
  });
  it("the page says so (data-guest-level) for a trusted guest only; Settings' overview carries the level", async () => {
    grants("trusted", { [keyOf(BOB)]: { instances: ["a"] } });
    const page = (sid: string) => get(sid, "/ui/chat/a", { accept: "text/html" }).then((r) => /<body[^>]*>/.exec(r.body)?.[0] ?? "");
    const [alice, bob] = [await page(session("guest", ALICE)), await page(session("guest", BOB))];
    expect(alice).toContain('data-tier="guest" data-guest-level="trusted"');
    expect(bob).toContain('data-tier="guest"');
    expect(bob).not.toContain("data-guest-level");
    const overview = fm.guestOverview();
    expect(overview.guests.map((g: any) => [g.userId, g.grant])).toEqual(expect.arrayContaining([
      [ALICE.userId, { instances: ["a"], level: "trusted" }], [BOB.userId, { instances: ["a"] }]]));
  });
});

describe("the View: GET /view/<n> and /api/pane/<n>", () => {
  it("a chat-level guest is refused the pane (nothing captured); a trusted one reads it, never cached; out of scope: 404", async () => {
    grants("chat");
    const chat = await get(session("guest", ALICE), "/api/pane/a");
    expect([chat.status, JSON.parse(chat.body).error, captures()]).toEqual([403, "guest_not_trusted", 0]);
    grants("trusted");
    const sid = session("guest", ALICE);
    const ok = await get(sid, "/api/pane/a");
    expect([ok.status, ok.body, ok.headers["cache-control"], ok.headers["x-pane-cols"], ok.headers["x-pane-rows"]])
      .toEqual([200, "\u001b[1mhello\u001b[0m pane\n", "private, no-store", "120", "40"]);
    expect((await get(sid, "/api/pane/b")).status).toBe(404);
    const shell = await get(sid, "/view/a", { accept: "text/html" });
    expect([shell.status, shell.body.includes('data-tier="guest"')]).toEqual([200, true]);
    expect((await get(sid, "/view/b", { accept: "text/html" })).status).toBe(404);
  });
  it("on the local listener a guest's cookie goes through the guest gate; an anonymous View read stays open", async () => {
    grants("chat");                                              // view_access unset: anonymous reads are open here
    expect((await get(session("guest", ALICE), "/api/pane/a")).status).toBe(403);
    expect((await get(session("guest", ALICE), "/api/pane/b")).status).toBe(404);
    expect((await get(null, "/api/pane/b")).status).toBe(200);
    expect((await get(session("admin"), "/api/pane/b")).status).toBe(200);
  });
  it("every guest viewer of an agent shares one capture within 500 ms", async () => {
    grants("trusted", { [keyOf(BOB)]: { instances: ["a"], level: "trusted" } });
    const [a, b] = [session("guest", ALICE), session("guest", BOB)];
    const reads = await Promise.all([get(a, "/api/pane/a"), get(b, "/api/pane/a")]);
    expect(reads.map((r) => r.status)).toEqual([200, 200]);
    expect(captures()).toBe(1);
    // An admin's read is its own (never the guests' copy).
    await get(session("admin"), "/api/pane/a");
    expect(captures()).toBe(2);
  });
  it("2 reads a second per account (every device of it), then 429 with Retry-After", async () => {
    grants("trusted");
    const [d1, d2] = [session("guest", ALICE), session("guest", ALICE)];
    const out = [];
    for (const sid of [d1, d2, d1]) out.push(await get(sid, "/api/pane/a"));
    expect(out.map((r) => r.status)).toEqual([200, 200, 429]);
    expect([JSON.parse(out[2]!.body).error, Number(out[2]!.headers["retry-after"]) >= 1]).toEqual(["guest_view_rate_limited", true]);
  });
  it("at most 2 agents at once per account", async () => {
    grants("trusted"); fm.fleetConfig.web.guests.grants[keyOf(ALICE)].instances = ["a", "b", "c"];
    const sid = session("guest", ALICE);
    expect((await get(sid, "/api/pane/a")).status).toBe(200);
    expect((await get(sid, "/api/pane/b")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_100));             // past the per-second read budget, inside the 5 s window
    const third = await get(sid, "/api/pane/c");
    expect([third.status, JSON.parse(third.body).error]).toEqual([429, "guest_view_too_many_agents"]);
  });
  it("a screen over 256 KB: its end, 256 KB", async () => {
    grants("trusted");
    const big = "x".repeat(GUEST_PANE_MAX_BYTES) + "THE-END";
    tmux.mockImplementation(async (_f: string, args: string[]) => ({ stdout: args.includes("capture-pane") ? big : "80x24\n", stderr: "" }));
    const r = await get(session("guest", ALICE), "/api/pane/a");
    expect([r.status, r.body.length, r.body.endsWith("THE-END")]).toEqual([200, GUEST_PANE_MAX_BYTES, true]);
  });
});
describe("search: GET /ui/search and /ui/search/context", () => {
  type Hit = { key: string; source: string; instance: string; ref: { boot: string; id: number }; snippet: string; marks: never[]; ts: number };
  const hitOf = (row: { instance: string; boot: string; id: number }, source = "chat"): Hit =>
    ({ key: `${source}:${row.instance}:${row.boot}:${row.id}`, source, instance: row.instance, ref: { boot: row.boot, id: row.id }, snippet: "s", marks: [], ts: 1 });
  function index(hits: () => Hit[], context?: (key: string) => unknown) {
    const ix = {
      status: () => "ready",
      query: vi.fn(async (_filters?: unknown) => ({ ok: true, value: { hits: hits(), limited: false }, building: false })),
      context: vi.fn(async (key: string) => ({ ok: true, value: context?.(key) ?? null, building: false })),
    };
    fm.searchIndex = ix;
    return ix;
  }
  const record = (instance: string, text: string, o: { channel?: true; from?: string } = {}) =>
    fm.webChatHistory.record({ instance, sender: "lead", text, ts: new Date().toISOString(), ...o });
  const body = (r: Raw) => JSON.parse(r.body);

  it("a chat-level guest: 403, the index never asked", async () => {
    grants("chat");
    const ix = index(() => []);
    const r = await get(session("guest", ALICE), "/ui/search?q=hello");
    expect([r.status, body(r).error, ix.query.mock.calls.length]).toEqual([403, "guest_not_trusted", 0]);
  });
  it("trusted: chat of its scope only — no team, no \"only mine\", another agent asked for is none of its", async () => {
    grants("trusted", {}, { search: { enabled: true } });
    fm.fleetConfig.teams = { t: { members: ["b", "c"] } };
    const ix = index(() => []);
    const sid = session("guest", ALICE);
    expect((await get(sid, "/ui/search?q=hello&team=t&mine=1&source=xmsg&source=task&limit=200")).status).toBe(200);
    expect(ix.query.mock.calls[0]![0]).toEqual({ q: "hello", instances: ["a"], sources: ["chat"], limit: 50 });
    const other = await get(sid, "/ui/search?q=hello&instance=b");
    expect([other.status, body(other).hits, ix.query.mock.calls.length]).toEqual([200, [], 1]);
    delete fm.fleetConfig.teams;
  });
  it("a hit is kept only when its history row is one the guest may see; at most 20", async () => {
    grants("trusted");
    const seen = record("a", "posted to the channel", { channel: true });
    const mine = record("a", "my own web message", { from: "discord:111111111111111111" });
    const other = record("a", "someone else's web message", { from: "discord:999" });
    const ix = index(() => [hitOf(seen), hitOf(mine), hitOf(other), hitOf({ instance: "a", boot: seen.boot, id: 999_999 }),
      hitOf({ ...seen, instance: "b" }), hitOf(seen, "xmsg")]);
    const sid = session("guest", ALICE);
    const r = await get(sid, "/ui/search?q=message");
    expect(r.status).toBe(200);
    expect(body(r).hits.map((h: Hit & { live: boolean }) => [h.ref.id, h.source, h.instance, h.live])).toEqual([[seen.id, "chat", "a", true], [mine.id, "chat", "a", true]]);
    const many = Array.from({ length: 25 }, (_, i) => record("a", `line ${i}`, { channel: true }));
    ix.query.mockImplementation(async () => ({ ok: true, value: { hits: many.map((m) => hitOf(m)), limited: false }, building: false }));
    const capped = await get(sid, "/ui/search?q=line");
    expect([body(capped).hits.length, body(capped).limited]).toEqual([GUEST_SEARCHES.maxResults, true]);
  });
  it("context: a doc it can't see is not found; around one it can, only rows it can see", async () => {
    grants("trusted");
    const before = record("a", "hidden before", { from: "discord:999" });
    const doc = record("a", "the hit", { channel: true });
    const after = record("a", "seen after", { channel: true });
    const hidden = record("a", "a hidden hit", { from: "discord:999" });
    const ctx = (row: typeof doc) => ({ doc: { ...hitOf(row), text: row.text }, before: [{ ...hitOf(before), text: before.text }], after: [{ ...hitOf(after), text: after.text }] });
    index(() => [], (key) => (key.endsWith(`:${hidden.id}`) ? ctx(hidden) : ctx(doc)));
    const sid = session("guest", ALICE);
    expect((await get(sid, `/ui/search/context?key=${encodeURIComponent(hitOf(hidden).key)}`)).status).toBe(404);
    const r = await get(sid, `/ui/search/context?key=${encodeURIComponent(hitOf(doc).key)}`);
    expect([r.status, body(r).doc.text, body(r).before, body(r).after.map((x: { text: string }) => x.text)]).toEqual([200, "the hit", [], ["seen after"]]);
  });
  it("6 a minute per account, then 429 with Retry-After", async () => {
    grants("trusted");
    index(() => []);
    const sid = session("guest", ALICE);
    const out: number[] = [];
    for (let i = 0; i < 7; i++) out.push((await get(sid, `/ui/search?q=x${i}`)).status);
    expect(out).toEqual([200, 200, 200, 200, 200, 200, 429]);
    const last = await get(sid, "/ui/search?q=again");
    expect([body(last).error, Number(last.headers["retry-after"]) >= 1]).toEqual(["guest_search_rate_limited", true]);
  });
  it("one at a time per account, and at most 3 guest searches running in all", async () => {
    const people = [ALICE, BOB, { adapterId: "discord", userId: "333333333333333333" }, { adapterId: "discord", userId: "444444444444444444" }];
    fm.fleetConfig.web = { guests: { enabled: true, grants: Object.fromEntries(people.map((p) => [keyOf(p), { instances: ["a"], level: "trusted" }])) } };
    const ix = index(() => []);
    const held: Array<() => void> = [];
    ix.query.mockImplementation(() => new Promise((ok) => held.push(() => ok({ ok: true, value: { hits: [], limited: false }, building: false }))));
    const sids = people.map((p) => session("guest", p));
    const running = sids.slice(0, 3).map((sid) => get(sid, "/ui/search?q=slow"));
    await vi.waitFor(() => expect(held.length).toBe(3));
    const again = await get(sids[0]!, "/ui/search?q=second");
    expect([again.status, body(again).error]).toEqual([429, "guest_search_running"]);
    const fourth = await get(sids[3]!, "/ui/search?q=fourth");
    expect([fourth.status, body(fourth).error]).toEqual([503, "search_busy"]);
    held.forEach((ok) => ok());
    expect((await Promise.all(running)).map((r) => r.status)).toEqual([200, 200, 200]);
    // Done: the next runs.
    ix.query.mockImplementation(async () => ({ ok: true, value: { hits: [], limited: false }, building: false }));
    expect((await get(sids[3]!, "/ui/search?q=now")).status).toBe(200);
  });
  it("a guest's access ended while its search ran: 401, no hits", async () => {
    grants("trusted");
    const ix = index(() => []);
    let release!: () => void;
    ix.query.mockImplementation(() => new Promise((ok) => { release = () => ok({ ok: true, value: { hits: [hitOf(record("a", "late", { channel: true }))], limited: false }, building: false }); }));
    const sid = session("guest", ALICE);
    const pending = get(sid, "/ui/search?q=late");
    await vi.waitFor(() => expect(ix.query).toHaveBeenCalled());
    fm.webSessions.revokeById(sid);
    release();
    const r = await pending;
    expect([r.status, r.body.includes("late")]).toEqual([401, false]);
  });
});
