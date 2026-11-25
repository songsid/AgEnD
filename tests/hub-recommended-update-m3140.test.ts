/**
 * M-3140 (hub-fleet-versions.md §3.3, the Fleet's side; on Ridge's #3951 advice): Update pinned to the Hub's recommended
 * version, from the web and from General's notice, and the notice's reminder (once, then every 7 days while behind).
 * - The page only names which advice it was shown ({ version, revision }); what installs is this Fleet's own verified advice,
 *   re-read at the start and again at the launch. Stale, cleared or not-newer advice installs nothing.
 * - The launch is chat /update's own (the installed agend, independently), with `agend update --version <v>`; the version
 *   is a positional argument, never spliced into the script.
 * - General gets one notice with Update now; again only after 7 days while still behind; a web-only fleet none (its banner).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[]; child: any }>);
// M-3770: the launch's pre-flight (#4480 §4) is proven on a real install; here the machine is one that may update itself.
vi.mock("../src/update-readiness.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-readiness.js")>();
  return { ...real, runUpdatePreflight: vi.fn(async () => real.summarize([{ id: "P1", ok: true }], Date.now())) };
});
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: ((cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 }); spawned.push({ cmd, args, child }); return child;
  }) as never };
});
const AGEND = "/home/u/.npm-global/bin/agend";
const installed = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock("../src/update-dispatch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-dispatch.js")>();
  return { ...real, resolveInstalledAgend: vi.fn(async () => { if (installed.gate) await installed.gate; return { ok: true, agend: AGEND, version: "2.3.5-beta.2" }; }) };
});
vi.mock("../src/update-launch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-launch.js")>();
  return { ...real, resolveUpdateLaunch: (agend: string, _deps: unknown, npmDir?: string, pin?: string) => real.resolveUpdateLaunch(agend, {
    ...real.defaultUpdateLaunchDeps, platform: "darwin",
  }, npmDir, pin) };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { DELAYED_UPDATE_SCRIPT, DELAYED_UPDATE_SCRIPT_PIN, DELAYED_UPDATE_SCRIPT_NPM_PIN, updateCommand } = await import("../src/update-dispatch.js");
const realLaunch = await vi.importActual<typeof import("../src/update-launch.js")>("../src/update-launch.js");
const { readUpdateProgress } = await import("../src/update-marker.js");
const { hubNoticeDue, hubNoticeKey, HUB_UPDATE_REMIND_MS } = await import("../src/hub-update-notice.js");
const { setLocale } = await import("../src/locale.js");

const dirs: string[] = [];
afterEach(() => { spawned.length = 0; installed.gate = null; vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let b: any = text; try { b = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const ADVICE = { hubId: "hub-1", hubName: "hub.example", version: "2.4.0-beta.4", revision: 3, setAt: 100, receivedAt: 200 };

async function fleet(advice: typeof ADVICE | null = ADVICE) {
  const dir = mkdtempSync(join(tmpdir(), "agend-hub-update-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { instances: { general: { working_directory: "/tmp", topic_id: 7 } }, defaults: {} };
  vi.spyOn(fm, "runningAgendVersion").mockReturnValue("2.3.5-beta.2");
  let current = advice;
  fm.hubRecommendationRead = () => current;
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const { sessionId } = fm.webSessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "discord", userId: "1" } });
  const write = (key: string) => ({ cookie: `agend_session=${sessionId}`, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json", "idempotency-key": key });
  const start = (key: string, recommended?: unknown) => raw(port, "POST", "/ui/update/start", write(key), JSON.stringify({ confirm: "update-agend", ...(recommended !== undefined ? { recommended } : {}) }));
  const stop = async () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, dir, start, stop, setAdvice: (a: typeof ADVICE | null) => { current = a; } };
}
const settle = () => new Promise(r => setTimeout(r, 30));

describe("M-3140: Update pinned to the Hub's recommended version (web)", () => {
  it("installs exactly the advised version — even with no channel offer — and the progress names it", async () => {
    const f = await fleet();
    try {
      expect(await f.start("k-pin-0001")).toEqual({ status: 409, body: { error: "nothing_to_install" } });   // control: no pin, no offer
      expect(await f.start("k-pin-0002", { version: ADVICE.version, revision: ADVICE.revision })).toEqual({ status: 202, body: { started: true } });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      expect(spawned[0]).toMatchObject({ cmd: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT_PIN, "sh", AGEND, "2.4.0-beta.4"] });
      expect(readUpdateProgress(f.dir)!.progress).toMatchObject({ stage: "preparing", version: "2.4.0-beta.4" });
    } finally { await f.stop(); }
  });
  it("advice that changed, was cleared or is not newer installs nothing; a malformed `recommended` is a 400", async () => {
    const f = await fleet();
    try {
      expect(await f.start("k-chg-0001", { version: ADVICE.version, revision: 2 })).toEqual({ status: 409, body: { error: "recommendation_changed" } });
      expect(await f.start("k-chg-0002", { version: "2.4.0-beta.5", revision: 3 })).toEqual({ status: 409, body: { error: "recommendation_changed" } });
      f.fm.runningAgendVersion.mockReturnValue("2.4.0-beta.4");
      expect((await f.start("k-chg-0003", { version: ADVICE.version, revision: 3 })).status).toBe(409);
      f.fm.runningAgendVersion.mockReturnValue("2.3.5-beta.2"); f.setAdvice(null);
      expect((await f.start("k-chg-0004", { version: ADVICE.version, revision: 3 })).status).toBe(409);
      for (const bad of [{ version: 1, revision: 3 }, { version: ADVICE.version }, { version: ADVICE.version, revision: 0 }, "2.4.0-beta.4"])
        expect((await f.start(`k-bad-${String(Math.random()).slice(2, 10)}`, bad)).status, JSON.stringify(bad)).toBe(400);
      await settle(); expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });
  it("advice that lapses between the start and the launch launches nothing", async () => {
    const f = await fleet();
    try {
      let open!: () => void; installed.gate = new Promise<void>(r => { open = r; });
      expect((await f.start("k-lapse-001", { version: ADVICE.version, revision: 3 })).status).toBe(202);
      f.setAdvice({ ...ADVICE, revision: 4 }); installed.gate = null; open();
      await vi.waitFor(() => expect(readUpdateProgress(f.dir)!.progress.stage).toBe("failed"));
      await settle(); expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });
});

describe("M-3140: the pinned command", () => {
  it("passes the version as data (a positional argument), with or without the proving npm's directory; only an exact version", async () => {
    expect(updateCommand(AGEND)).toEqual({ command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", AGEND] });
    expect(updateCommand(AGEND, undefined, "2.4.0-beta.4")).toEqual({ command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT_PIN, "sh", AGEND, "2.4.0-beta.4"] });
    expect(updateCommand(AGEND, "/opt/npm/bin", "2.4.0")).toEqual({ command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT_NPM_PIN, "sh", AGEND, "/opt/npm/bin", "2.4.0"] });
    expect(DELAYED_UPDATE_SCRIPT_PIN).toContain('update --version "$2"'); expect(DELAYED_UPDATE_SCRIPT_NPM_PIN).toContain('update --version "$3"');
    for (const bad of ["latest", "2.4", "2.4.0; rm -rf /", "$(id)", ""]) expect(() => updateCommand(AGEND, undefined, bad), bad).toThrow();
    expect(await realLaunch.resolveUpdateLaunch(AGEND, { ...realLaunch.defaultUpdateLaunchDeps, platform: "darwin" }, undefined, "next")).toMatchObject({ ok: false });
  });
});

describe("M-3140: General's notice and its 7-day reminder", () => {
  it("the rule: new advice now; the same advice again only after 7 days; nothing when not newer", () => {
    const newer = (a: string, b: string) => a > b, key = hubNoticeKey(ADVICE);
    expect(hubNoticeDue(null, ADVICE, "2.3.5", 0, newer)).toBe(true);
    expect(hubNoticeDue({ key, at: 1000 }, ADVICE, "2.3.5", 1000 + HUB_UPDATE_REMIND_MS - 1, newer)).toBe(false);
    expect(hubNoticeDue({ key, at: 1000 }, ADVICE, "2.3.5", 1000 + HUB_UPDATE_REMIND_MS, newer)).toBe(true);
    expect(hubNoticeDue({ key, at: 1000 }, { ...ADVICE, revision: 4 }, "2.3.5", 1001, newer)).toBe(true);
    expect(hubNoticeDue(null, ADVICE, "2.4.0-beta.4", 0, (a, b) => a > b)).toBe(false);
    expect(hubNoticeDue(null, null, "2.3.5", 0, newer)).toBe(false);
  });
  async function general(f: Awaited<ReturnType<typeof fleet>>, webOnly = false) {
    const posted: any[] = [];
    vi.spyOn(f.fm, "webOnlyPromptPlace").mockReturnValue(webOnly);
    vi.spyOn(f.fm, "findGeneralInstance").mockReturnValue("general");
    vi.spyOn(f.fm, "getInstanceAdapterId").mockReturnValue("tg");
    vi.spyOn(f.fm, "getAdapterForInstance").mockReturnValue({});
    vi.spyOn(f.fm, "getGroupIdForInstance").mockReturnValue("-100");
    vi.spyOn(f.fm, "postNonceButtonPromptOrThrow").mockImplementation(async (o: any) => { posted.push(o); return "a".repeat(32); });
    return posted;
  }
  it("posts once in General with Update now, again after 7 days while behind (the daily check), never on a web-only fleet", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const posted = await general(f);
      const t0 = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(t0);
      f.fm.hubRecommendationChanged(); await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ prefix: "hub-update:", instanceName: "general", threadId: "7", chatId: "-100",
        message: "🆕 hub.example recommends AgEnD v2.4.0-beta.4 (this Fleet runs v2.3.5-beta.2). Some Hub features need it.",
        choices: [{ action: "update", label: "Update now" }], timeoutMs: HUB_UPDATE_REMIND_MS });
      f.fm.hubRecommendationChanged(); await settle(); expect(posted).toHaveLength(1);
      f.fm.lookUpUpdateTarget = vi.fn(async () => ({ target: "2.3.5-beta.2", fromChannel: true }));
      vi.spyOn(Date, "now").mockReturnValue(t0 + HUB_UPDATE_REMIND_MS - 60_000); await f.fm.checkForUpdates(); expect(posted).toHaveLength(1);
      vi.spyOn(Date, "now").mockReturnValue(t0 + HUB_UPDATE_REMIND_MS + 1); await f.fm.checkForUpdates(); expect(posted).toHaveLength(2);
      // Updated past it: nothing more.
      f.fm.runningAgendVersion.mockReturnValue("2.4.0-beta.4");
      vi.spyOn(Date, "now").mockReturnValue(t0 + 3 * HUB_UPDATE_REMIND_MS); await f.fm.checkForUpdates(); expect(posted).toHaveLength(2);
    } finally { await f.stop(); }
    const w = await fleet();
    try { const posted = await general(w, true); w.fm.hubRecommendationChanged(); await settle(); expect(posted).toEqual([]); } finally { await w.stop(); }
  });
  it("Update now: a non-admin's press is told privately and leaves the button; an admin's press then launches pinned (Fable #3955)", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const alerts: any[] = [];
      const adapter = { notifyAlert: vi.fn(async (_chat: string, alert: any) => { alerts.push(alert); return { chatId: "-100", threadId: "7", messageId: "m1" }; }), editMessage: vi.fn(async () => {}) };
      vi.spyOn(f.fm, "webOnlyPromptPlace").mockReturnValue(false);
      vi.spyOn(f.fm, "findGeneralInstance").mockReturnValue("general");
      vi.spyOn(f.fm, "getInstanceAdapterId").mockReturnValue("tg");
      vi.spyOn(f.fm, "getAdapterForInstance").mockReturnValue(adapter);
      vi.spyOn(f.fm, "getGroupIdForInstance").mockReturnValue("-100");
      vi.spyOn(f.fm, "fleetAdminGate").mockImplementation((...a: unknown[]) => (a[0] === "1" ? "ok" : "denied"));
      const retired: string[] = [];
      vi.spyOn(f.fm, "retireNonceButtons").mockImplementation(async (...a: unknown[]) => { retired.push(String(a[2])); });
      vi.spyOn(f.fm, "beginUpdateProgress").mockImplementation(() => {});
      f.fm.hubRecommendationChanged(); await vi.waitFor(() => expect(alerts).toHaveLength(1));
      const id = alerts[0].choices[0].id as string;
      expect(id).toMatch(/^hub-update:[0-9a-f]{32}:update$/);
      const press = (userId: string) => { const ack = vi.fn(); return { ack, run: f.fm.handleHubUpdateCallback({ callbackData: id, userId, chatId: "-100", threadId: "7", messageId: "m1", ack }, "tg", adapter) }; };
      const stranger = press("9");
      expect(await stranger.run).toBe(true);
      expect(stranger.ack).toHaveBeenCalledWith(expect.stringMatching(/admin/i));
      expect(retired).toEqual([]); await settle(); expect(spawned).toEqual([]);
      expect(f.fm.pendingNonceButtons.has(id.slice("hub-update:".length, "hub-update:".length + 32))).toBe(true);   // the button is still live
      const admin = press("1");
      expect(await admin.run).toBe(true);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      expect(spawned[0]!.args).toEqual(["-c", DELAYED_UPDATE_SCRIPT_PIN, "sh", AGEND, "2.4.0-beta.4"]);
      expect(f.fm.pendingHubUpdates.size).toBe(0);
    } finally { await f.stop(); }
  });
  it("Update now on advice that changed since the notice launches nothing and says so", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const retired: string[] = [];
      vi.spyOn(f.fm, "retireNonceButtons").mockImplementation(async (...a: unknown[]) => { retired.push(String(a[2])); });
      vi.spyOn(f.fm, "consumeNonceCallback").mockReturnValueOnce({ entry: { messageId: "m1", adapter: {}, chatId: "-100", threadId: "7" }, action: "update" });
      f.fm.pendingHubUpdates.set("b".repeat(32), { version: ADVICE.version, revision: 2 });
      expect(await f.fm.handleHubUpdateCallback({ callbackData: `hub-update:${"b".repeat(32)}:update`, userId: "1", messageId: "m1" }, "tg", {})).toBe(true);
      expect(retired.at(-1)).toMatch(/recommendation changed/); await settle(); expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });
});
