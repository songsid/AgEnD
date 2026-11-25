/**
 * M-3770 slice 1.5 (design #4480 §3.1): the update card in General's chat — one per fleet, following the fleet's card
 * (S-234's UpdateOfferCard): posted with Update when idle / Tonight / Not now when an offer newly qualifies; a fleet
 * admin's press answers the one card (anyone else is told privately; the buttons stay); every later state edits that same
 * message; a newer version replaces it; never on a web-only fleet; never for an offer that can't be installed here.
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
const ADVICE = null as any;

async function fleet(advice: typeof ADVICE | null = ADVICE) {
  const dir = mkdtempSync(join(tmpdir(), "agend-update-chat-card-")); dirs.push(dir);
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
  const stop = async () => { try { (fm as any).updateCard?.close(); } catch { /* already closed */ } fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, dir, start, stop, setAdvice: (a: typeof ADVICE | null) => { current = a; } };
}
const settle = () => new Promise(r => setTimeout(r, 30));

async function general(f: Awaited<ReturnType<typeof fleet>>, webOnly = false) {
  const posted: any[] = [], edits: string[] = [], alerts: any[] = [];
  const adapter = { notifyAlert: vi.fn(async (_chat: string, alert: any) => { alerts.push(alert); return { chatId: "-100", threadId: "7", messageId: `m${alerts.length}` }; }),
    editMessage: vi.fn(async (_c: string, _m: string, text: string) => { edits.push(text); }) };
  vi.spyOn(f.fm, "webOnlyPromptPlace").mockReturnValue(webOnly);
  vi.spyOn(f.fm, "findGeneralInstance").mockReturnValue("general");
  vi.spyOn(f.fm, "getInstanceAdapterId").mockReturnValue("tg");
  vi.spyOn(f.fm, "getAdapterForInstance").mockReturnValue(adapter);
  vi.spyOn(f.fm, "getGroupIdForInstance").mockReturnValue("-100");
  vi.spyOn(f.fm, "fleetAdminGate").mockImplementation((...a: unknown[]) => (a[0] === "1" ? "ok" : "denied"));
  const retired: string[] = [];
  vi.spyOn(f.fm, "retireNonceButtons").mockImplementation(async (...a: unknown[]) => { retired.push(String(a[2])); });
  // Agents at work: an answer waits, nothing launches.
  vi.spyOn(f.fm, "hubUpdateIdle").mockReturnValue(false);
  vi.spyOn(f.fm, "launchInstalledUpdate").mockImplementation(async () => { throw new Error("must not launch in this test"); });
  f.fm.updatePreflight = { class: "self", checkedAt: 1, pressHere: true, checks: [{ id: "P3", ok: true }] };
  return { posted, alerts, edits, retired, adapter };
}
const offer = (f: any, version = "2.3.5-beta.3") => f.fm.recordUpdateCheck("2.3.5-beta.2", { target: version, fromChannel: true });
const press = (f: any, g: any, action: string, userId = "1") => {
  const id = g.alerts.at(-1).choices.find((c: any) => c.id.endsWith(`:${action}`)).id as string;
  const ack = vi.fn();
  return { ack, run: f.fm.handleUpdateCardCallback({ callbackData: id, userId, username: userId === "1" ? "Example owner" : "someone", chatId: "-100", threadId: "7", messageId: g.alerts.length ? `m${g.alerts.length}` : "m1", ack }, "tg", g.adapter) };
};

describe("M-3770 1.5: the update card in General's chat", () => {
  it("posts once when an offer qualifies: the two sentences, Update when idle / Tonight / Not now; never twice, never web-only", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      const a = g.alerts[0];
      expect(a.message ?? a.text ?? JSON.stringify(a)).toContain("AgEnD 2.3.5-beta.3 is ready.");
      expect(JSON.stringify(a)).toContain("Your work continues; if it won't start, AgEnD rolls back to 2.3.5-beta.2.");
      expect(a.choices.map((c: any) => c.label)).toEqual(["Update when idle", "Tonight", "Not now"]);
      expect(a.choices.map((c: any) => c.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^update-card:[0-9a-f]{32}:when-idle$/)]));
      await f.fm.syncUpdateChatCard(); offer(f); await settle(); await f.fm.syncUpdateChatCard();
      expect(g.alerts).toHaveLength(1);
    } finally { await f.stop(); }
    const w = await fleet();
    try { const g = await general(w, true); offer(w); await settle(); await w.fm.syncUpdateChatCard(); expect(g.alerts).toEqual([]); } finally { await w.stop(); }
  });
  it("a non-admin's press is told privately, the buttons stay; an admin's Update when idle answers the one card and edits the message", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      const stranger = press(f, g, "when-idle", "9");
      expect(await stranger.run).toBe(true);
      expect(stranger.ack).toHaveBeenCalledWith(expect.stringMatching(/admin/i));
      expect(g.retired).toEqual([]);
      expect(f.fm.updateOfferView().state).toBe("offered");
      expect(await press(f, g, "when-idle").run).toBe(true);
      expect(f.fm.updateOfferView().state).toBe("waiting-idle");
      expect(g.retired.at(-1)).toMatch(/will update when your agents are idle\. · answered by Example owner/);
    } finally { await f.stop(); }
  });
  it("Tonight schedules 22:00 (the next one at least 30 min ahead); Not now hides it", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      expect(await press(f, g, "tonight").run).toBe(true);
      const v = f.fm.updateOfferView();
      expect(v.state).toBe("scheduled");
      const at = new Date(v.scheduledAt);
      expect([at.getHours(), at.getMinutes()]).toEqual([22, 0]);
      expect(v.scheduledAt - Date.now()).toBeGreaterThanOrEqual(30 * 60_000);
    } finally { await f.stop(); }
    const n = await fleet();
    try {
      const g = await general(n);
      offer(n); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      expect(await press(n, g, "not-now").run).toBe(true);
      expect(n.fm.updateOfferView().state).toBe("not-now");
    } finally { await n.stop(); }
  });
  it("a later state edits the same message (a cancel from the web); a newer version replaces the card", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      expect(await press(f, g, "when-idle").run).toBe(true);
      await f.fm.ensureUpdateCard().answer("web-cancel-1", "Example owner", { action: "cancel" });
      await f.fm.syncUpdateChatCard();
      // Offered again (the same version): a fresh card, the old message says it was cancelled.
      expect(g.alerts).toHaveLength(2);
      expect([...g.edits, ...g.retired].some((t) => /cancelled/.test(t))).toBe(true);
      offer(f, "2.3.5-beta.4"); await vi.waitFor(() => expect(g.alerts).toHaveLength(3));
      expect(g.retired.some((t) => /newer card replaced this one \(v2\.3\.5-beta\.4\)/.test(t))).toBe(true);
    } finally { await f.stop(); }
  });
  it("the daily check no longer posts \"Run: /update\" for an offer this install can take: the card, once", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      const topic = vi.spyOn(f.fm, "notifyInstanceTopic").mockImplementation(() => true);
      f.fm.lookUpUpdateTarget = vi.fn(async () => ({ target: "2.3.5-beta.3", fromChannel: true }));
      await f.fm.checkForUpdates(); await f.fm.checkForUpdates();
      await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      expect(topic.mock.calls.map((c) => String(c[1]))).not.toEqual(expect.arrayContaining([expect.stringContaining("Run: /update")]));
    } finally { await f.stop(); }
  });
  it("never posts an offer this install can't take (an alpha's stable)", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      f.fm.recordUpdateCheck("2.4.0-alpha.3", { target: "2.5.0", fromChannel: false });
      await settle(); await f.fm.syncUpdateChatCard();
      expect(g.alerts).toEqual([]);
    } finally { await f.stop(); }
  });
});
