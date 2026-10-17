/**
 * #1629 B1 (first design §2, §4, §6, §9.3–7; r2 (a)–(c)): an agent's own theme, end to end on the host side.
 * - The one appearance limiter: 30 s apart (1 ms either side), 10 an hour; only accepted calls count. Uploads are not
 *   counted (the user's decision, 2026-10-18): what a picture may be is bounded by its slot's limits and the quota.
 * - The store: one record per instance, own keys ("__proto__" and "constructor" are names), an unreadable file refuses
 *   writes (never overwritten), pictures checked and stripped, assets the theme stops naming deleted.
 * - The service: the fleet switch, then the lock, then the limit; a person's reset keeps the lock; nothing is limited
 *   for a person.
 * - The doors: typed IPC answers for the connection's instance whatever the payload says; the agent endpoint's
 *   theme-* ops; agend-agent's forms; the daemon reads the picture and sends bytes — the fleet never sees a path.
 */
import { chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

// #1887 review: the moment between agent-file-read's lstat and its open, made deterministic — a test may answer the
// lstat with another file's stat (a regular file swapped for a FIFO after it was looked at).
const fsHook = vi.hoisted(() => ({ lstat: null as null | ((path: string) => unknown) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, lstat: (path: string, ...rest: unknown[]) => (fsHook.lstat ? Promise.resolve(fsHook.lstat(path)) : (real.lstat as (...a: unknown[]) => unknown)(path, ...rest)) };
});
import { AppearanceLimiter, APPEARANCE_LIMITS } from "../src/web-appearance-policy.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebAppearance } from "../src/web-appearance.js";
import { readAgentFile } from "../src/agent-file-read.js";
import * as schemas from "../src/outbound-schemas.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); fsHook.lstat = null; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** A PNG of w×h with a tEXt chunk (GPS) the store must strip. */
const png = (w = 4, h = 4, extra = 0) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...be32(13), ...Buffer.from("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...be32(7), ...Buffer.from("tEXtGPS:1,2"), 0, 0, 0, 0,
  ...be32(1 + extra), ...Buffer.from("IDAT"), ...new Array(1 + extra).fill(7), 0, 0, 0, 0,
  ...be32(0), ...Buffer.from("IEND"), 0, 0, 0, 0]);

describe("the appearance limiter (r2 (c))", () => {
  it("changes: 30 s apart (1 ms either side), at most 10 an hour, the 11th refused with retry_after_s", () => {
    let now = 0;
    const l = new AppearanceLimiter(() => now);
    l.record("a", ["change"]);
    now = 29_999;
    expect(l.check("a", ["change"])).toEqual({ ok: false, error: "rate_limited", retry_after_s: 1 });
    now = 30_000;
    expect(l.check("a", ["change"]).ok).toBe(true);
    for (let k = 1; k < 10; k++) { now = k * 30_000; l.record("a", ["change"]); }
    now = 10 * 30_000;
    const eleventh = l.check("a", ["change"]);
    expect(eleventh.ok).toBe(false);
    expect(!eleventh.ok && eleventh.retry_after_s).toBe(3600 - 300);
    expect(l.check("b", ["change"]).ok, "per instance").toBe(true);
  });
  it("no upload budget: nothing counts uploads, and what is left names only changes and widget data", () => {
    let now = 0;
    const l = new AppearanceLimiter(() => now);
    expect(Object.keys(APPEARANCE_LIMITS).sort()).toEqual(["changeGapMs", "changesPerHour", "dataGapMs", "dataPerHour"]);
    expect(l.check("a", []).ok, "an upload asks no bucket").toBe(true);
    expect(l.remaining("a")).toEqual({ changes: 10, retry_after_s: 0, widget_data: 180, widget_data_retry_after_s: 0 });
    l.record("a", ["change"]);
    l.forget("a");
    expect(l.check("a", ["change"]).ok, "forget clears an instance").toBe(true);
  });
  it("monotonic: the default clock is performance.now, so a wall-clock jump changes nothing", () => {
    const l = new AppearanceLimiter();
    l.record("a", ["change"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 3600_000);
    expect(l.check("a", ["change"]).ok).toBe(false);
  });
});

describe("the theme store", () => {
  it("own keys: __proto__ and constructor are instance names, kept apart", () => {
    const s = new ThemeStore(tmp("agend-th-"));
    for (const name of ["__proto__", "constructor", "a"]) expect(s.setTheme(name, { v: 1, font: "mono" }, "agent").ok).toBe(true);
    expect([s.get("__proto__").theme, s.get("constructor").theme, Object.keys(s.themes()).sort()]).toEqual([{ v: 1, font: "mono" }, { v: 1, font: "mono" }, ["__proto__", "a", "constructor"]]);
    expect(({} as Record<string, unknown>).font).toBeUndefined();
    const again = new ThemeStore(s.path.replace(/\/web-themes\.json$/, ""));
    expect(again.get("__proto__").theme.font, "survives a reload").toBe("mono");
  });
  it("an unreadable file: the default for everyone, and writes refused — the file is never overwritten", () => {
    const dir = tmp("agend-th-");
    writeFileSync(join(dir, "web-themes.json"), "{ not json");
    const s = new ThemeStore(dir);
    expect([s.get("a").theme, s.setTheme("a", { v: 1, font: "mono" }, "agent")]).toEqual([{ v: 1 }, { ok: false, status: 503, error: "themes_unreadable" }]);
    expect(readFileSync(join(dir, "web-themes.json"), "utf8")).toBe("{ not json");
  });
  it("pictures: magic bytes, the slot's size and sides, metadata stripped, the instance's quota", () => {
    const s = new ThemeStore(tmp("agend-th-"));
    const ok = s.addAsset("a", "avatar", png());
    expect(ok.ok).toBe(true);
    const stored = s.asset("a", (ok as { id: string }).id)!;
    expect([stored.mime, stored.bytes.includes(Buffer.from("GPS"))]).toEqual(["image/png", false]);
    expect(s.addAsset("a", "avatar", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toMatchObject({ ok: false, error: "asset_type" });
    expect(s.addAsset("a", "avatar", png(4097, 4))).toMatchObject({ ok: false, error: "asset_dimensions" });
    expect(s.addAsset("a", "avatar", png(4, 4, 256 * 1024))).toMatchObject({ ok: false, error: "asset_too_large" });
    expect(s.addAsset("a", "background", png(4, 4, 256 * 1024))).toMatchObject({ ok: true });
    expect(s.addAsset("a", "wallpaper", png())).toMatchObject({ ok: false, error: "slot" });
    for (let k = s.get("a").assets.length; k < s.limits().quota.files; k++) expect(s.addAsset("a", "avatar", png(4 + k)).ok).toBe(true);
    expect(s.addAsset("a", "avatar", png(99))).toMatchObject({ ok: false, error: "asset_quota" });
  });
  it("an asset the theme stops naming is deleted; one uploaded but never named stays", () => {
    const dir = tmp("agend-th-");
    const s = new ThemeStore(dir);
    const one = (s.addAsset("a", "avatar", png(5)) as { id: string }).id, two = (s.addAsset("a", "avatar", png(6)) as { id: string }).id;
    s.setTheme("a", { v: 1, avatar: one }, "agent");
    s.setTheme("a", { v: 1, font: "mono" }, "agent");
    expect(s.get("a").assets.map(x => x.id)).toEqual([two]);
    expect(s.asset("a", one)).toBeNull();
  });
  it("a person's reset: theme, placements and pictures go, the lock stays; an agent's: its theme only", () => {
    const dir = tmp("agend-th-");
    const s = new ThemeStore(dir);
    const id = (s.addAsset("a", "avatar", png()) as { id: string }).id;
    s.setTheme("a", { v: 1, avatar: id }, "agent");
    s.setLocked("a", true);
    s.reset("a", "agent");
    expect([s.get("a").theme, s.get("a").assets.length, s.get("a").locked]).toEqual([{ v: 1 }, 1, true]);
    s.reset("a", "human");
    expect([s.get("a").assets, s.get("a").locked, s.get("a").by]).toEqual([[], true, "human"]);
    expect(readdirSync(join(dir, "web-themes")).length).toBe(0);
  });
  it("placements: the caller's synchronous check runs first; who placed it is kept", () => {
    const s = new ThemeStore(tmp("agend-th-"));
    const E = "e".repeat(32);
    expect(s.setPlacements("a", { effects: [E] }, "agent", () => "no_such_effect")).toMatchObject({ ok: false, error: "no_such_effect" });
    expect(s.get("a").placements.effects).toEqual([]);
    const w = s.setPlacements("a", { effects: [E] }, "agent", () => null);
    expect(w.ok && w.placements.effects[0]).toMatchObject({ id: E, by: "agent" });
    expect(s.setPlacements("a", { effects: [E, "f".repeat(32), "0".repeat(32)] }, "agent", () => null)).toMatchObject({ ok: false, error: "effects" });
  });
});

describe("the service: switch, then lock, then limit — only what is accepted counts", () => {
  const svc = (web: { themes?: { agent_edit?: boolean } } = {}) => {
    let now = 0;
    const s = new ThemeStore(tmp("agend-th-"));
    const changed = vi.fn();
    const a = new WebAppearance(s, () => web, changed, new AppearanceLimiter(() => now));
    return { s, a, changed, tick: (ms: number) => { now += ms; } };
  };
  it("set: all or nothing; an invalid patch costs nothing; {} is a no-op", () => {
    const { a, changed } = svc();
    expect(a.setTheme("w", { set: { font: "comic" } })).toMatchObject({ errors: [{ path: "font" }] });
    expect(a.setTheme("w", {})).toMatchObject({ theme: { v: 1 } });
    expect(a.setTheme("w", { set: { font: "mono" } })).toMatchObject({ theme: { v: 1, font: "mono" } });
    expect(a.setTheme("w", { set: { font: "system" } }), "30 s apart").toMatchObject({ error: "rate_limited", retry_after_s: 30 });
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("web.themes.agent_edit: false refuses every agent write; the stored theme stays", () => {
    const { a, s } = svc({ themes: { agent_edit: false } });
    s.setTheme("w", { v: 1, font: "mono" }, "agent");
    for (const r of [a.setTheme("w", { set: { font: "system" } }), a.resetTheme("w"), a.setAsset("w", { slot: "avatar", data_b64: png().toString("base64") })]) {
      expect(r).toMatchObject({ error: "theme_editing_off" });
    }
    expect(s.get("w").theme.font).toBe("mono");
    expect(a.getTheme("w")).toMatchObject({ agent_edit: false });
  });
  it("a person's lock refuses the agent; a person's reset and lock are never limited", () => {
    const { a } = svc();
    expect(a.humanLock("w", true)).toMatchObject({ ok: true, locked: true });
    expect(a.setTheme("w", { set: { font: "mono" } })).toMatchObject({ error: "locked", message: "Theme and effects are locked by a person." });
    for (let k = 0; k < 20; k++) expect(a.humanReset("w")).toMatchObject({ ok: true });
    expect(a.humanLock("w", false)).toMatchObject({ ok: true, locked: false });
    expect(a.setTheme("w", { set: { font: "mono" } })).toMatchObject({ theme: { font: "mono" } });
  });
  it("uploads are not counted: a fourth and fifth picture in an hour are stored; the switch, the lock and the checks still refuse", () => {
    const { a } = svc();
    expect(a.setAsset("w", { slot: "avatar", data_b64: Buffer.from("not a picture").toString("base64") })).toMatchObject({ error: "asset_type" });
    for (let k = 0; k < 5; k++) expect(a.setAsset("w", { slot: "avatar", data_b64: png(10 + k).toString("base64") }), `picture ${k + 1}`).toHaveProperty("id");
    expect((a.getTheme("w") as { limits: { changes: number } }).limits.changes, "an upload is not a change").toBe(10);
    expect(a.humanLock("w", true)).toMatchObject({ ok: true, locked: true });
    expect(a.setAsset("w", { slot: "avatar", data_b64: png(30).toString("base64") })).toMatchObject({ error: "locked" });
  });
  it("get_web_theme says what an agent needs: theme, defaults, assets, limits, lock", () => {
    const { a } = svc();
    expect(a.getTheme("w")).toMatchObject({ theme: { v: 1 }, locked: false, agent_edit: true, defaults: { dark: { bg: "#212121" } }, assets: [], limits: { changes: 10 } });
    expect(a.getTheme("w").limits, "no upload count (the user's decision)").not.toHaveProperty("uploads");
  });
});

describe("no target: the tools' schemas name no instance", () => {
  it.each(["GetWebThemeArgs", "SetWebThemeArgs", "SetWebThemeAssetArgs", "ResetWebThemeArgs"] as const)("%s", (name) => {
    const props = Object.keys((z.toJSONSchema((schemas as unknown as Record<string, z.ZodType>)[name]!) as { properties?: object }).properties ?? {});
    expect(props.filter(p => /instance|name|target|chat|thread/.test(p))).toEqual([]);
  });
});

describe("the doors", () => {
  async function fleet() {
    const dir = tmp("agend-th-fm-");
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any;
    fm.logger = pino({ level: "silent" });
    fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: dir }, other: { working_directory: dir } } };
    vi.spyOn(fm, "getUiStatus").mockReturnValue({});
    return { fm, dir };
  }
  it("typed IPC: the connection's instance, whatever the payload says", async () => {
    const { fm } = await fleet();
    const send = vi.fn();
    fm.instanceIpcClients.set("worker", { send });
    fm.dispatchTypedIpc("worker", { type: "fleet_set_web_theme", fleetRequestId: "t1", payload: { set: { font: "mono" } } });
    fm.dispatchTypedIpc("worker", { type: "fleet_get_web_theme", fleetRequestId: "t2", payload: { instance: "other" } });
    expect(send.mock.calls.map(c => [c[0].type, c[0].fleetRequestId])).toEqual([["fleet_web_theme_response", "t1"], ["fleet_web_theme_response", "t2"]]);
    expect(send.mock.calls[1]![0].result.theme).toEqual({ v: 1, font: "mono" });
    expect([fm.themeStore.get("worker").theme.font, fm.themeStore.get("other").theme.font]).toEqual(["mono", undefined]);
  });
  it("the agent endpoint: theme-get / theme-set / theme-clear / theme-reset for the token's instance", async () => {
    const { fm, dir } = await fleet();
    const { dispatchAgentOperation } = await import("../src/agent-endpoint.js");
    const ctx = Object.assign(Object.create(fm), { dataDir: dir, logger: pino({ level: "silent" }) });
    ctx.fleetConfig = fm.fleetConfig;
    expect(await dispatchAgentOperation(ctx, "worker", "theme-set", { set: { bubble: { radius: 8 } } })).toMatchObject({ theme: { bubble: { radius: 8 } } });
    expect(await dispatchAgentOperation(ctx, "worker", "theme-get", {})).toMatchObject({ theme: { v: 1, bubble: { radius: 8 } } });
    expect(await dispatchAgentOperation(ctx, "worker", "theme-clear", { clear: ["bubble"] })).toMatchObject({ error: "rate_limited" });
    expect(fm.themeStore.get("other").theme).toEqual({ v: 1 });
  });
  it.each([false, true])("the daemon reads the picture, never the path (state workspace=%s)", async classic => {
    const home = tmp("agend-th-home-"), ws = classic ? join(home, "workspaces/worker") : tmp("agend-th-ws-");
    mkdirSync(ws, { recursive: true }); vi.stubEnv("AGEND_HOME", home);
    writeFileSync(join(ws, "me.png"), png());
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon("worker", { working_directory: ws, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } } as never, join(ws, ".instance"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
    const broadcast = vi.fn(), send = vi.fn((_socket: unknown, _msg: unknown) => true);
    daemon.ipcServer = { send, broadcast };
    const socket = {} as never;
    daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "avatar", file: "me.png" }, requestId: 7 }, socket);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
    const msg = broadcast.mock.calls[0]![0];
    expect([msg.type, msg.meta.instance_name, Object.keys(msg.payload).sort(), Buffer.from(msg.payload.data_b64, "base64").equals(png())])
      .toEqual(["fleet_set_web_theme_asset", "worker", ["data_b64", "slot"], true]);
    daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "avatar", file: "/etc/hostname" }, requestId: 8 }, socket);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.at(-1)![1] as Record<string, unknown>).toMatchObject({ requestId: 8, error: expect.stringContaining("outside your working directory") });
    expect(broadcast).toHaveBeenCalledOnce();
  });
  it("a malformed file argument (raw JSON args) is answered once, with an error — never a throw left unanswered", async () => {
    const ws = tmp("agend-th-ws-");
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon("worker", { working_directory: ws, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } } as never, join(ws, ".instance"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
    const broadcast = vi.fn(), send = vi.fn((_socket: unknown, _msg: unknown) => true);
    daemon.ipcServer = { send, broadcast };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const malformed: unknown[] = [{ toString: null }, Object.create(null), ["a.png"], 12];
      malformed.forEach((file, i) => daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "avatar", file }, requestId: i + 1 }, {} as never));
      daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "avatar", file: "missing.png" }, requestId: 5 }, {} as never);   // control
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
      await new Promise(r => setTimeout(r, 50));
      const answers = send.mock.calls.map(c => c[1] as { requestId: number; error?: string });
      expect(answers.map(a => a.requestId).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(answers.every(a => typeof a.error === "string" && a.error.includes("a file path in your working directory") || a.requestId === 5)).toBe(true);
      expect(answers.find(a => a.requestId === 5)!.error).toContain("missing.png — cannot be read");
      expect([unhandled, broadcast.mock.calls.length, send.mock.calls.length]).toEqual([[], 0, 5]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });
});

describe("reading the agent's file (the daemon's and the CLI's side)", () => {
  it("in the working directory only; no symlink; a regular file; within the size; not in the state directory", async () => {
    const ws = tmp("agend-th-ws-"), state = join(ws, ".agend");
    mkdirSync(state);
    writeFileSync(join(ws, "ok.png"), "x");
    writeFileSync(join(state, "web.token"), "secret");
    symlinkSync(join(ws, "ok.png"), join(ws, "link.png"));
    mkdirSync(join(ws, "dir"));
    writeFileSync(join(ws, "big.png"), Buffer.alloc(11));
    const read = (f: string) => readAgentFile(f, { workspace: ws, stateDir: state, maxBytes: 10 });
    expect(await read("ok.png")).toMatchObject({ ok: true });
    expect(await read("link.png")).toEqual({ ok: false, reason: "a symlink" });
    expect(await read("dir")).toEqual({ ok: false, reason: "not a regular file" });
    expect(await read("big.png")).toEqual({ ok: false, reason: "over the size limit (0 KiB)" });
    expect(await read(".agend/web.token")).toEqual({ ok: false, reason: "inside the AgEnD state directory" });
    expect(await read("../../etc/hostname")).toMatchObject({ ok: false });
    expect(await read("missing.png")).toEqual({ ok: false, reason: "cannot be read" });
    expect(await readAgentFile("x", { workspace: undefined, stateDir: state, maxBytes: 10 })).toEqual({ ok: false, reason: "this instance has no working directory" });
    chmodSync(join(ws, "ok.png"), 0o644);
  });
  it("a regular file swapped for a FIFO after the lstat: refused at once, never waiting for a writer (#1887 review)", async () => {
    const ws = tmp("agend-th-ws-"), state = join(ws, ".agend");
    writeFileSync(join(ws, "ok.png"), "x");
    const fifo = join(ws, "swapped.png");
    execFileSync("mkfifo", [fifo]);
    // The lstat saw a regular file (ok.png's stat); by the open, the name is a FIFO with no writer.
    fsHook.lstat = (path: string) => (path === fifo ? lstatSync(join(ws, "ok.png")) : lstatSync(path));
    const opts = { workspace: ws, stateDir: state, maxBytes: 10 };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"still waiting">(r => { timer = setTimeout(() => r("still waiting"), 2_000); });
    try {
      const got = await Promise.race([readAgentFile("swapped.png", opts), late]);
      expect(got).toEqual({ ok: false, reason: "not a regular file" });
    } finally {
      clearTimeout(timer);
      // Had the open blocked, a writer releases its worker (opening for write succeeds while a reader waits).
      try { closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); } catch { /* no reader waiting: nothing blocked */ }
    }
    fsHook.lstat = null;
    expect(await readAgentFile("ok.png", opts)).toMatchObject({ ok: true });   // control: the ordinary file still reads
  });
});

describe("agend-agent theme …", () => {
  it.each([false, true])("get / set / clear / asset / reset (state workspace=%s)", async classic => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const posts: Array<{ op: string; args: Record<string, unknown> }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => { posts.push(JSON.parse(body)); res.end(JSON.stringify({ ok: true })); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp("agend-th-cli-"), ws = classic ? join(home, "workspaces/worker") : tmp("agend-th-cli-ws-");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "bg.png"), png());
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => {
      // Run in the agent's working directory (the CLI reads files there), with tsx's loader named by path.
      execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv], {
        cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "worker", AGEND_HOME: home }, timeout: 30_000,
      }, (err, stdout) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout }));
    });
    try {
      expect((await run("theme", "get")).code).toBe(0);
      expect((await run("theme", "set", "colors.dark.accent=#7c3aed", "bubble.radius=12", "workingLabel=Thinking hard")).code).toBe(0);
      expect((await run("theme", "set", "--json", '{"font":"mono"}')).code).toBe(0);
      expect((await run("theme", "clear", "colors.dark.bg", "workingLabel")).code).toBe(0);
      expect((await run("theme", "asset", "background", "bg.png")).code).toBe(0);
      const outside = await run("theme", "asset", "avatar", "/etc/hostname");
      expect([outside.code, outside.out]).toEqual([1, expect.stringContaining("outside your working directory")]);
      expect((await run("theme", "reset")).code).toBe(0);
      expect(posts.map(p => [p.op, p.args])).toEqual([
        ["theme-get", {}],
        ["theme-set", { set: { colors: { dark: { accent: "#7c3aed" } }, bubble: { radius: 12 }, workingLabel: "Thinking hard" } }],
        ["theme-set", { set: { font: "mono" } }],
        ["theme-clear", { clear: ["colors.dark.bg", "workingLabel"] }],
        ["theme-asset", { slot: "background", data_b64: png().toString("base64") }],
        ["theme-reset", {}],
      ]);
    } finally {
      await new Promise(r => server.close(r));
    }
  }, 120_000);
});
