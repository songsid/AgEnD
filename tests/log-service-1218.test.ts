/**
 * #1218 phase 1: the Log tab's server side (log-service.ts) — on demand only, off by default (the user's decision on
 * load). Off: `{ enabled: false }` and no work. On: each GET reads a bounded range of the transcript (the newest steps,
 * older ones before an offset, newer ones after the page's cursor), a watch lease is the only timer, fleet events come
 * from the event log. Plus the route, the public-link allowlist, passive reads, and `web.log_tab` in Settings.
 */
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { LOG_EVENT_TYPES, LOG_RESPONSE_MAX_BYTES, LogService, WATCH_LEASE_MS, WATCH_POLL_MS, type LogServiceDeps, type LogSource } from "../src/log-service.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { validateFleetConfig } from "../src/config-validator.js";

// The fleet's logger is a pino transport writing <AGEND_HOME>/daemon.log late (#1778): silent here.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1218-svc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const CLAUDE_FIX = join(import.meta.dirname, "fixtures", "log-steps-1218", "claude.jsonl");
const line = (o: unknown) => JSON.stringify(o) + "\n";

function service(over: Partial<LogServiceDeps> & { src?: LogSource; on?: boolean } = {}) {
  let on = over.on ?? true;
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const emitted: Array<[string, unknown]> = [];
  let clock = 0;
  const svc = new LogService({
    enabled: () => on,
    known: (n) => n === "w",
    source: () => over.src ?? { backend: "claude-code", path: null, format: "claude" },
    events: () => [],
    emit: (e, d) => emitted.push([e, d]),
    now: () => clock,
    setInterval: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearInterval: (h) => { (h as { cleared: boolean }).cleared = true; },
    ...over,
  });
  return { svc, emitted, timers, set on(v: boolean) { on = v; }, tick: (ms: number) => { clock += ms; } };
}
const claudeFile = () => { const f = join(temp(), "t.jsonl"); copyFileSync(CLAUDE_FIX, f); return f; };

describe("off by default: no work at all", () => {
  it("off: { enabled: false }, nothing read, nothing watched — and an instance that does not exist is never looked up", async () => {
    const source = vi.fn();
    const s = service({ on: false, source });
    expect(await s.svc.steps("w", { watch: true })).toEqual({ enabled: false });
    expect(await s.svc.steps("nope", {})).toEqual({ enabled: false });
    expect([source.mock.calls.length, s.timers.length]).toEqual([0, 0]);
  });
  it("on: an unknown instance is null (the route's 404)", async () => {
    expect(await service().svc.steps("nope", {})).toBeNull();
  });
  it("a backend with no readable transcript: supported false with why, events only; a codex instance not running says so", async () => {
    const a = await service({ src: { backend: "grok", path: null, format: null, reason: "unsupported" } }).svc.steps("w", {});
    expect(a).toMatchObject({ enabled: true, backend: "grok", supported: false, reason: "unsupported", steps: [], before: null, after: null });
    const b = await service({ src: { backend: "codex", path: null, format: "codex", reason: "not_running" } }).svc.steps("w", {});
    expect(b).toMatchObject({ supported: true, reason: "not_running", steps: [] });
  });
});

describe("on demand: the newest steps, older ones before an offset, newer ones after the page's cursor", () => {
  it("opening the Log: the newest steps, the transcript's key, and where to continue (a record being written waits)", async () => {
    const f = claudeFile();
    const a: any = await service({ src: { backend: "claude-code", path: f, format: "claude" } }).svc.steps("w", {});
    expect(a.steps.map((x: any) => x.kind)).toEqual(["user", "assistant", "tool", "tool", "tool", "tool", "tool", "turn_end", "user", "state", "user", "tool", "error", "user"]);
    expect(a.key).toMatch(/^\d+-\d+$/);
    expect(a.after).toBe(readFileSync(f).lastIndexOf(0x0a) + 1);           // bytes, not characters
    expect(a.before).toBeNull();
  });

  it("after the cursor: only what was written since — a result for a call shown earlier comes with that call's id", async () => {
    const f = claudeFile();
    // The last complete line of the fixture is a prompt; finish the record that was being written, then add a call and its result.
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    const first: any = await s.svc.steps("w", {});
    writeFileSync(f, readFileSync(f).subarray(0, first.after));
    appendFileSync(f, line({ type: "assistant", uuid: "z1", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_new", name: "Bash", input: { command: "ls" } }] } }));
    const mid: any = await s.svc.steps("w", { after: first.after, key: first.key });
    expect(mid.steps.map((x: any) => [x.id, x.status])).toEqual([["toolu_new", "running"]]);
    appendFileSync(f, line({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_new", type: "tool_result", content: "a.txt" }] } }));
    const next: any = await s.svc.steps("w", { after: mid.after, key: mid.key });
    expect(next.steps.map((x: any) => [x.id, x.status, x.body])).toEqual([["toolu_new", "done", "a.txt"]]);
    expect(next.after).toBeGreaterThan(mid.after);
    const idle: any = await s.svc.steps("w", { after: next.after, key: next.key });
    expect([idle.steps, idle.after]).toEqual([[], next.after]);
  });

  it("older steps: before an offset, 100 at a time, ids never repeated, until nothing is older", async () => {
    const f = join(temp(), "big.jsonl");
    let body = "";
    for (let i = 0; i < 450; i++) body += line({ type: "user", uuid: `u${i}`, message: { role: "user", content: `prompt ${i}` } });
    writeFileSync(f, body);
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    const first: any = await s.svc.steps("w", {});
    expect(first.steps).toHaveLength(200);
    expect(first.steps[0].body).toBe("prompt 250");
    const seen = new Set(first.steps.map((x: any) => x.id));
    let cursor = first.before, pages = 0;
    while (cursor !== null) {
      const older: any = await s.svc.steps("w", { before: cursor, key: first.key });
      for (const x of older.steps) { expect(seen.has(x.id), x.id).toBe(false); seen.add(x.id); }
      expect(older.after).toBeNull();
      cursor = older.before; pages++;
    }
    expect([seen.size, pages]).toEqual([450, 3]);
  });

  it("a cursor for another transcript (a new session) or past its end: the newest steps again, marked reset", async () => {
    const f = claudeFile();
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    const a: any = await s.svc.steps("w", { after: 10, key: "1-2" });
    expect([a.reset, a.steps.length > 0]).toEqual([true, true]);
    const b: any = await s.svc.steps("w", { after: 10_000_000, key: a.key });
    expect(b.reset).toBe(true);
  });

  it("an answer never exceeds LOG_RESPONSE_MAX_BYTES: the newest steps that fit", async () => {
    const f = join(temp(), "fat.jsonl");
    let body = "";
    for (let i = 0; i < 200; i++) body += line({ type: "assistant", uuid: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `${i} ` + "t".repeat(4000) }] } });
    writeFileSync(f, body);
    const a: any = await service({ src: { backend: "claude-code", path: f, format: "claude" } }).svc.steps("w", {});
    expect(JSON.stringify(a.steps).length).toBeLessThanOrEqual(LOG_RESPONSE_MAX_BYTES);
    expect(a.steps.length).toBeLessThan(200);
    expect(a.steps.at(-1).body.startsWith("199 ")).toBe(true);
    expect(a.before).toBeGreaterThan(0);
  });
});

describe("#1788 review: record boundaries, whole long records, and the watch ended by turning it off", () => {
  it("a page is cut only at a record's boundary: a reply's text and its call come together, and none is lost across pages", async () => {
    const f = join(temp(), "pairs.jsonl");
    let body = "";
    for (let i = 0; i < 5; i++) body += line({ type: "assistant", uuid: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `t${i}` }, { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `c${i}` } }] } });
    writeFileSync(f, body);
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    const first: any = await s.svc.steps("w", { limit: 3 });
    expect(first.steps.map((x: any) => x.body ?? x.subject)).toEqual(["t3", "c3", "t4", "c4"]);       // 3 asked, 4 given: record 3 whole
    const ids = new Set(first.steps.map((x: any) => x.id));
    let cursor = first.before;
    while (cursor !== null) {
      const older: any = await s.svc.steps("w", { before: cursor, key: first.key, limit: 3 });
      for (const x of older.steps) ids.add(x.id);
      cursor = older.before;
    }
    expect(ids.size).toBe(10);
  });
  it("the backfill reads a long reply whole, as the live read does (never only its head)", async () => {
    const f = join(temp(), "long.jsonl");
    writeFileSync(f, JSON.stringify({ parentUuid: "p", message: { role: "assistant", content: [{ type: "text", text: "LONG " + "w".repeat(300 * 1024) }] }, type: "assistant" }) + "\n");
    const a: any = await service({ src: { backend: "claude-code", path: f, format: "claude" } }).svc.steps("w", {});
    expect(a.steps.map((x: any) => [x.kind, x.body.slice(0, 5)])).toEqual([["assistant", "LONG "]]);
  });
  it("turned off in Settings: the next look ends the watch (nobody calls unwatchAll there)", async () => {
    const f = claudeFile();
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    await s.svc.steps("w", { watch: true });
    s.on = false;
    s.timers[0]!.fn(); await new Promise(r => setTimeout(r, 20));
    expect([s.timers[0]!.cleared, s.svc.watched(), s.emitted]).toEqual([true, 0, []]);
  });
});

describe("live only under a watch lease", () => {
  it("a watching request holds a lease: one timer looks at the transcript's size and ticks when it grows; the lease ends it", async () => {
    const f = claudeFile();
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    await s.svc.steps("w", {});
    expect(s.timers).toHaveLength(0);                                          // no watch asked: no timer
    await s.svc.steps("w", { watch: true });
    await s.svc.steps("w", { watch: true });
    expect([s.timers.length, s.svc.watched()]).toEqual([1, 1]);               // renewed, not doubled
    s.timers[0]!.fn(); await new Promise(r => setTimeout(r, 20));
    expect(s.emitted).toEqual([]);                                             // unchanged: no tick
    appendFileSync(f, line({ type: "user", message: { role: "user", content: "more" } }));
    s.timers[0]!.fn(); await new Promise(r => setTimeout(r, 20));
    expect(s.emitted).toEqual([["steps_tick", { instance: "w" }]]);
    s.tick(WATCH_LEASE_MS + 1);
    s.timers[0]!.fn(); await new Promise(r => setTimeout(r, 20));
    expect([s.timers[0]!.cleared, s.svc.watched()]).toEqual([true, 0]);
    expect(WATCH_POLL_MS).toBeLessThanOrEqual(2000);
  });
  it("each watching request renews the lease: a page that keeps asking keeps its watch past the first lease", async () => {
    const f = claudeFile();
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    await s.svc.steps("w", { watch: true });
    s.tick(WATCH_LEASE_MS - 1000);
    await s.svc.steps("w", { watch: true });                                  // renewed here
    s.tick(2000);                                                              // past the first lease, inside the second
    s.timers[0]!.fn(); await new Promise(r => setTimeout(r, 20));
    expect([s.timers[0]!.cleared, s.svc.watched()]).toEqual([false, 1]);
  });

  it("turning the Log off ends every watch at once", async () => {
    const f = claudeFile();
    const s = service({ src: { backend: "claude-code", path: f, format: "claude" } });
    await s.svc.steps("w", { watch: true });
    s.on = false;
    expect(await s.svc.steps("w", {})).toEqual({ enabled: false });
    expect([s.timers[0]!.cleared, s.svc.watched()]).toEqual([true, 0]);
  });
});

describe("fleet events from the event log", () => {
  it("only the instance's own changes (not bookkeeping), oldest first, masked; ev= gives only newer ones", async () => {
    const secret = "ghp_" + "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8".repeat(2);
    const rows = [
      { id: 7, event_type: "tip_dismissed", payload: null, created_at: "2026-10-13 08:00:07" },
      { id: 6, event_type: "crash_respawn", payload: {}, created_at: "2026-10-13 08:00:06" },
      { id: 5, event_type: "backend_unreachable", payload: { message: `token ${secret}` }, created_at: "2026-10-13 08:00:05" },
    ];
    const s = service({ src: { backend: "grok", path: null, format: null }, events: () => rows });
    const a: any = await s.svc.steps("w", {});
    expect(a.events.map((e: any) => [e.id, e.type])).toEqual([[5, "backend_unreachable"], [6, "crash_respawn"]]);
    expect(a.events[0].ts).toBe(Date.parse("2026-10-13T08:00:05Z"));
    expect(JSON.stringify(a.events)).not.toContain(secret);
    expect(a.ev).toBe(7);
    expect(((await s.svc.steps("w", { ev: 5 })) as any).events.map((e: any) => e.id)).toEqual([6]);
    expect(LOG_EVENT_TYPES.has("tip_dismissed")).toBe(false);
  });

  it("a {message} payload shows its text, not raw JSON (#1785-fix)", async () => {
    const rows = [
      { id: 2, event_type: "crash_respawn", payload: { code: 1, detail: "OOM" }, created_at: "2026-10-13 08:48:01" },
      { id: 1, event_type: "backend_launch_warning", payload: { message: "kiro-cli 2.30.0 is newer…" }, created_at: "2026-10-13 08:48:00" },
    ];
    const s = service({ src: { backend: "kiro-cli", path: null, format: null, reason: "unsupported" }, events: () => rows });
    const a: any = await s.svc.steps("w", {});
    // message-only payload: detail is the message text, not JSON
    const launchWarning = a.events.find((e: any) => e.type === "backend_launch_warning");
    const crashRespawn = a.events.find((e: any) => e.type === "crash_respawn");
    expect(launchWarning.detail).toBe("kiro-cli 2.30.0 is newer…");
    expect(launchWarning.detail).not.toMatch(/^\{/);
    // other-shape payload: JSON is still used
    expect(crashRespawn.detail).toContain("OOM");
  });
});

describe("the route, the public link, passive reads and the setting", () => {
  it("GET /ui/steps is on the public link's allowlist (the user's decision) and is a passive read", () => {
    expect([isPublicWebRoute("GET", "/ui/steps"), isPublicWebRoute("POST", "/ui/steps")]).toEqual([true, false]);
    expect([isPassiveWebRead("GET", "/ui/steps"), isPassiveWebRead("POST", "/ui/steps")]).toEqual([true, false]);
  });
  it("web.log_tab: a boolean, written by Settings → Web; turning it on is confirmed (access), turning it off applies at once", () => {
    expect(parseWebSettingsBody({ log_tab: true })).toMatchObject({ logTab: true });
    expect(parseWebSettingsBody({ log_tab: "yes" })).toEqual({ error: "log_tab must be a boolean" });
    expect(validateFleetConfig({ instances: {}, web: { log_tab: "on" } } as any).errors.map(e => e.path)).toContain("web.log_tab");
    const on = settingsChangeDiff({ fleet: { web: {} } }, { fleet: { web: { log_tab: true } } }, { operation: "PUT /api/settings/fleet/web" });
    expect(on?.section).toBe("access");
    expect(settingsChangeDiff({ fleet: { web: { log_tab: true } } }, { fleet: { web: { log_tab: false } } }, { operation: "PUT x" })).toBeNull();
  });
});

describe("GET /ui/steps: parameters are checked; the fleet answers", () => {
  function get(query: string, logSteps?: (n: string, q: unknown) => Promise<unknown>): Promise<{ status: number; body: any; q?: unknown }> {
    return new Promise((resolve) => {
      let status = 0, seen: unknown;
      const res = {
        setHeader() {}, writeHead(c: number) { status = c; return res; },
        end(b?: string) { resolve({ status, body: JSON.parse(String(b ?? "null")), q: seen }); },
      } as unknown as ServerResponse;
      const TOKEN = "u".repeat(48);
      const req = Object.assign(new EventEmitter(), { method: "GET", url: `/ui/steps?${query}`, headers: { "x-agend-token": TOKEN }, destroy() {}, resume() {} }) as unknown as IncomingMessage;
      const ctx = { webToken: TOKEN, sseClients: new Set(), fleetConfig: { instances: {} }, logger: { info() {}, debug() {}, error() {} }, getUiStatus: () => ({}),
        ...(logSteps ? { logSteps: (n: string, q: unknown) => { seen = q; return logSteps(n, q); } } : {}) } as never;
      handleWebRequest(req, res, new URL(`http://127.0.0.1:19280/ui/steps?${query}`), ctx);
    });
  }
  it.each(["", "instance=", "instance=w&after=-1", "instance=w&after=1.5", "instance=w&limit=0", "instance=w&limit=201", "instance=w&key=x", "instance=w&before=abc"])("400: %s", async (q) => {
    expect((await get(q, async () => ({}))).status).toBe(400);
  });
  it("the query reaches the fleet as numbers and flags; null is 404; the answer is the body", async () => {
    const r = await get("instance=w&after=12&key=3-4&skip=1&watch=1&ev=9&limit=50", async () => ({ enabled: true, steps: [] }));
    expect([r.status, r.body, r.q]).toEqual([200, { enabled: true, steps: [] }, { after: 12, key: "3-4", skip: true, watch: true, ev: 9, limit: 50 }]);
    expect((await get("instance=x", async () => null)).status).toBe(404);
  });
});

describe("the fleet resolves where an instance's steps are read from — only when its Log asks", () => {
  async function fleet(instances: Record<string, unknown>, extra: (h: string, fm: any) => void = () => {}) {
    const h = temp();
    vi.stubEnv("AGEND_HOME", h);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(h) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.fleetConfig = { defaults: {}, instances, web: { log_tab: true } };
    extra(h, fm);
    return fm;
  }
  afterEach(() => { vi.unstubAllEnvs(); });
  it("claude-code: the transcript its monitor follows, else the one its statusline last named (a stopped instance)", async () => {
    const fm = await fleet({ c: { working_directory: "/w/c", backend: "claude-code" } });
    expect(fm.logSource("c")).toEqual({ backend: "claude-code", path: null, format: "claude", reason: "no_transcript" });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fm.getInstanceDir("c"), { recursive: true });
    writeFileSync(join(fm.getInstanceDir("c"), "statusline.json"), JSON.stringify({ transcript_path: "/x/t.jsonl" }));
    expect(fm.logSource("c")).toEqual({ backend: "claude-code", path: "/x/t.jsonl", format: "claude" });
    fm.lifecycle.daemons.set("c", { logTranscriptPath: () => "/live/t.jsonl" });
    expect(fm.logSource("c").path).toBe("/live/t.jsonl");
  });
  it("codex: only while it runs; kiro: fleet events only, with the reason; others: none; a ClassicBot room by its backend", async () => {
    const fm = await fleet({ x: { working_directory: "/w/x", backend: "codex" }, k: { working_directory: "/w/k", backend: "kiro-cli" }, g: { working_directory: "/w/g", backend: "grok" } });
    expect(fm.logSource("x")).toEqual({ backend: "codex", path: null, format: "codex", reason: "not_running" });
    fm.lifecycle.daemons.set("x", { logTranscriptPath: () => "/r/rollout.jsonl" });
    expect(fm.logSource("x")).toEqual({ backend: "codex", path: "/r/rollout.jsonl", format: "codex" });
    // kiro (#1218 PR4): nothing is read; the reason is its launch's (kiro-log-gate.ts) — even the best-proven launch.
    expect(fm.logSource("k")).toEqual({ backend: "kiro-cli", path: null, format: null, reason: "kiro_not_running" });
    fm.lifecycle.daemons.set("k", { logTranscriptPath: () => "/never/read.jsonl", logLaunch: () => ({ engine: "v2", mode: "resume", credentialProfile: null }) });
    expect(fm.logSource("k")).toEqual({ backend: "kiro-cli", path: null, format: null, reason: "kiro_v2_root" });
    fm.lifecycle.daemons.set("k", { logTranscriptPath: () => "/never/read.jsonl", logLaunch: () => ({ engine: "v1", mode: "resume", credentialProfile: "work" }) });
    expect(fm.logSource("k")).toEqual({ backend: "kiro-cli", path: null, format: null, reason: "kiro_session_unobservable" });
    fm.lifecycle.daemons.set("k", { logTranscriptPath: () => null, logLaunch: () => ({ engine: "v1", mode: "legacy", credentialProfile: null }) });
    expect(fm.logSource("k").reason).toBe("kiro_legacy");
    expect(await fm.logSteps("k", { watch: true })).toMatchObject({ enabled: true, backend: "kiro-cli", supported: false, reason: "kiro_legacy", steps: [] });
    expect(fm.log.watched()).toBe(0);                                       // nothing to watch: no lease, no timer
    expect(fm.logSource("g")).toMatchObject({ backend: "grok", format: null, reason: "unsupported" });
    fm.classicRoomFor = (n: string) => (n === "room" ? { name: "room", backend: "codex" } : null);
    expect(fm.logSource("room").backend).toBe("codex");
  });
  it("logSteps goes through the service: off by default, on when web.log_tab is true; an unknown name is null", async () => {
    const fm = await fleet({ g: { working_directory: "/w/g", backend: "grok" } });
    expect(await fm.logSteps("g", {})).toMatchObject({ enabled: true, supported: false });
    expect(await fm.logSteps("nope", {})).toBeNull();
    fm.fleetConfig.web = {};
    expect(await fm.logSteps("g", {})).toEqual({ enabled: false });
  });
});
