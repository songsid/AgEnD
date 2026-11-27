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
      expect(JSON.stringify(a)).toContain("Your work continues; if the new version won't start, AgEnD tries to roll back to 2.3.5-beta.2.");
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
      expect(g.retired.at(-1)).toMatch(/Updating to 2\.3\.5-beta\.3 as soon as your agents are idle\. · answered by Example owner/);
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
      expect(g.retired.some((t) => /newer card replaced this one \(2\.3\.5-beta\.4\)/.test(t))).toBe(true);
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
  // ── #4485 review: lifecycle cases ──
  it("restart or expiry: an offered card with no live buttons is marked expired and a live one is posted; a stale click answers nothing", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      const oldId = g.alerts[0].choices[0].id as string;
      await vi.waitFor(() => expect(f.fm.readUpdateChatCard()?.nonce).toBeTruthy());
      f.fm.pendingNonceButtons.clear();                                    // a restart (or the week's expiry)
      await f.fm.syncUpdateChatCard();
      await vi.waitFor(() => expect(g.alerts).toHaveLength(2));
      expect(g.edits.at(-1)).toMatch(/expired/);
      // A click on the dead card: nothing is answered.
      const ack = vi.fn();
      await f.fm.handleUpdateCardCallback({ callbackData: oldId, userId: "1", username: "Example owner", chatId: "-100", threadId: "7", messageId: "m1", ack }, "tg", g.adapter);
      expect(f.fm.updateOfferView().state).toBe("offered");
      await f.fm.syncUpdateChatCard();
      expect(g.alerts).toHaveLength(2);                                     // one usable card, not a new one per sync
    } finally { await f.stop(); }
  });
  it("a click while the card is still being posted: answered, recorded, and a later state edits the real message", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      g.adapter.notifyAlert.mockImplementationOnce(async (_c: string, alert: any) => { g.alerts.push(alert); await gate; return { chatId: "-100", threadId: "7", messageId: "m-real" }; });
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      const id = g.alerts[0].choices.find((c: any) => c.id.endsWith(":when-idle")).id as string;
      await f.fm.handleUpdateCardCallback({ callbackData: id, userId: "1", username: "Example owner", chatId: "-100", threadId: "7", messageId: "m-real", ack: vi.fn() }, "tg", g.adapter);
      expect(f.fm.updateOfferView().state).toBe("waiting-idle");
      release(); await vi.waitFor(() => expect(f.fm.readUpdateChatCard()).toMatchObject({ state: "waiting-idle", messageId: "m-real", nonce: null }));
      await settle();
      expect(g.edits).toEqual([]);                                          // the "· answered by" reply stands (not re-edited)
      await f.fm.ensureUpdateCard().answer("web-cancel-x", "Example owner", { action: "cancel" });
      g.adapter.editMessage.mockClear();
      await f.fm.syncUpdateChatCard();
      expect(g.adapter.editMessage.mock.calls.some((c: any[]) => c[1] === "m-real")).toBe(true);   // the real message, never ""
    } finally { await f.stop(); }
  });
  it("a newer version while the card is being posted: the posted one is replaced after, and its button never answers the newer offer", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      g.adapter.notifyAlert.mockImplementationOnce(async (_c: string, alert: any) => { g.alerts.push(alert); await gate; return { chatId: "-100", threadId: "7", messageId: "mA" }; });
      offer(f, "2.3.5-beta.3"); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      offer(f, "2.3.5-beta.4");                                            // while A is being posted
      release();
      await vi.waitFor(() => expect(g.alerts).toHaveLength(2));
      expect(JSON.stringify(g.alerts[1])).toContain("2.3.5-beta.4");
      expect(g.retired.some((t) => /replaced this one \(2\.3\.5-beta\.4\)/.test(t))).toBe(true);
      // A stale button still live (the card moved on without a sync): pressing it answers nothing.
      const live = g.alerts[1].choices.find((c: any) => c.id.endsWith(":when-idle")).id as string;
      f.fm.ensureUpdateCard().noteOffer({ version: "2.3.5-beta.5", channel: "beta", installable: true });
      await f.fm.handleUpdateCardCallback({ callbackData: live, userId: "1", username: "Example owner", chatId: "-100", threadId: "7", messageId: "m2", ack: vi.fn() }, "tg", g.adapter);
      expect(f.fm.updateOfferView()).toMatchObject({ version: "2.3.5-beta.5", state: "offered" });
      expect(g.retired.at(-1)).toMatch(/replaced this one \(2\.3\.5-beta\.5\)/);
    } finally { await f.stop(); }
  });
  it("#4485 r2: a newer offer and an early click on the older card, both before its post returns: no answer; the current card after", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      g.adapter.notifyAlert.mockImplementationOnce(async (_c: string, alert: any) => { g.alerts.push(alert); await gate; return { chatId: "-100", threadId: "7", messageId: "mA" }; });
      offer(f, "2.3.5-beta.3"); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      offer(f, "2.3.5-beta.4");                                            // B arrives while A's post is pending
      const aId = g.alerts[0].choices.find((c: any) => c.id.endsWith(":when-idle")).id as string;
      await f.fm.handleUpdateCardCallback({ callbackData: aId, userId: "1", username: "Example owner", chatId: "-100", threadId: "7", messageId: "mA", ack: vi.fn() }, "tg", g.adapter);
      expect(f.fm.updateOfferView()).toMatchObject({ version: "2.3.5-beta.4", state: "offered" });   // B was not answered by A's button
      expect(g.retired.at(-1)).toMatch(/replaced this one \(2\.3\.5-beta\.4\)/);
      release();
      await vi.waitFor(() => expect(g.alerts.some((a: any) => JSON.stringify(a).includes("2.3.5-beta.4"))).toBe(true));
      expect(f.fm.updateOfferView()).toMatchObject({ version: "2.3.5-beta.4", state: "offered" });
    } finally { await f.stop(); }
  });
  it("a press on a card with no version binding answers nothing (fail closed)", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(f.fm.readUpdateChatCard()?.nonce).toBeTruthy());
      f.fm.updateChatCardVersion.clear();
      expect(await press(f, g, "when-idle").run).toBe(true);
      expect(f.fm.updateOfferView().state).toBe("offered");
      expect(g.retired.at(-1)).toMatch(/expired/);
    } finally { await f.stop(); }
  });
  it("a change while an edit is in flight is not lost: the sync runs again when the edit is done", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      offer(f); await vi.waitFor(() => expect(f.fm.readUpdateChatCard()?.nonce).toBeTruthy());
      expect(await press(f, g, "when-idle").run).toBe(true);
      await vi.waitFor(() => expect(f.fm.readUpdateChatCard()?.state).toBe("waiting-idle"));
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      g.adapter.editMessage.mockImplementationOnce(async (_c: string, _m: string, text: string) => { g.edits.push(text); await gate; });
      // waiting → scheduled (from the web): an edit of the message, held open.
      await f.fm.ensureUpdateCard().answer("web-pick-z", "Example owner", { action: "pick-time", at: Date.now() + 3 * 3600_000 });
      const editing = f.fm.syncUpdateChatCard();
      await vi.waitFor(() => expect(g.edits.length).toBe(1));
      // Meanwhile it is cancelled on the web: offered again. This sync is asked for while the edit runs.
      await f.fm.ensureUpdateCard().answer("web-cancel-z", "Example owner", { action: "cancel" });
      await f.fm.syncUpdateChatCard();
      const before = g.alerts.length;
      release(); await editing;
      await vi.waitFor(() => expect(g.alerts.length).toBe(before + 1));    // the fresh card, without waiting for the minute timer
    } finally { await f.stop(); }
  });
  it("the second line is Phase 1's best effort: passing P3 → tries to roll back; failing → can't restart itself; none → work continues", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      await general(f);
      const view = { version: "2.3.5-beta.3", state: "offered", installable: true, channel: "beta" };
      f.fm.updatePreflight = { checks: [{ id: "P3", ok: true }] };
      expect(f.fm.updateChatCardText(view, "2.3.5-beta.2")).toBe("🆕 AgEnD 2.3.5-beta.3 is ready.\nYour work continues; if the new version won't start, AgEnD tries to roll back to 2.3.5-beta.2.");
      f.fm.updatePreflight = { checks: [{ id: "P3", ok: false, code: "not-service" }] };
      expect(f.fm.updateChatCardText(view, "2.3.5-beta.2")).toContain("this setup can't restart AgEnD by itself");
      f.fm.updatePreflight = null;
      expect(f.fm.updateChatCardText(view, "2.3.5-beta.2")).toBe("🆕 AgEnD 2.3.5-beta.3 is ready.\nYour work continues.");
      setLocale("zh-TW");
      f.fm.updatePreflight = { checks: [{ id: "P3", ok: true }] };
      expect(f.fm.updateChatCardText(view, "2.3.5-beta.2")).toContain("新版起不來時，AgEnD 會嘗試退回 2.3.5-beta.2");
      setLocale("en");
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

describe("M-3864 R1: the chat card offers what this machine allows, and says why when it can't update", () => {
  const STOP = { class: "stop", checkedAt: 1, pressHere: false, checks: [{ id: "P3", ok: true }, { id: "P9", ok: false, code: "container" }] };
  const ADMIN_ONLY = { class: "admin-only", checkedAt: 1, pressHere: true, checks: [{ id: "P3", ok: false, code: "service-unknown" }] };
  it("can't update here (a stop): the reason, and Not now only; an admin-only machine: no Tonight", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      f.fm.updatePreflight = STOP;
      vi.spyOn(f.fm, "refreshUpdatePreflight").mockResolvedValue(undefined);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      expect(JSON.stringify(g.alerts[0])).toContain("AgEnD can't update here until this is fixed: AgEnD runs in a container; update the image.");
      expect(g.alerts[0].choices.map((c: any) => c.label)).toEqual(["Not now"]);
      await settle();
      f.fm.updatePreflight = ADMIN_ONLY;
      await f.fm.syncUpdateChatCard();
      await vi.waitFor(() => expect(g.alerts).toHaveLength(2));
      expect(g.alerts[1].choices.map((c: any) => c.label)).toEqual(["Update when idle", "Not now"]);
      expect(g.retired.at(-1)).toBe("A newer card replaced this one (2.3.5-beta.3).");
      await f.fm.syncUpdateChatCard();
      expect(g.alerts).toHaveLength(2);                                                  // same buttons: not posted again
      setLocale("zh-TW");
      f.fm.updatePreflight = STOP;
      expect(f.fm.updateChatCardText({ version: "2.3.5-beta.3", state: "offered", installable: true, channel: "beta" }, "2.3.5-beta.2")).toContain("這個問題解決前，AgEnD 無法在這裡更新：");
      setLocale("en");
    } finally { await f.stop(); }
  });
  it("a press the machine refuses says why in words, and that text is not overwritten as expired", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      vi.spyOn(f.fm, "refreshUpdatePreflight").mockResolvedValue(undefined);
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      f.fm.updatePreflight = STOP;                                                       // found since the card was posted
      expect(await press(f, g, "when-idle").run).toBe(true);
      expect(g.retired.at(-1)).toBe("This machine can't be updated from here: AgEnD runs in a container; update the image. Nothing was changed.");
      expect(f.fm.updateOfferView().state).toBe("offered");
      const before = g.retired.length;
      await f.fm.syncUpdateChatCard();
      await vi.waitFor(() => expect(g.alerts).toHaveLength(2));
      expect(g.alerts[1].choices.map((c: any) => c.label)).toEqual(["Not now"]);
      expect(g.retired.slice(before)).toEqual([]);
      expect(g.edits.join("|")).not.toMatch(/expired/);
    } finally { await f.stop(); }
  });
  it("a fresh pre-flight result brings the card in line by itself", async () => {
    setLocale("en");
    const f = await fleet();
    try {
      const g = await general(f);
      const probe = vi.spyOn(f.fm, "probeUpdatePreflight").mockResolvedValue({ class: "self", checkedAt: Date.now(), pressHere: true, checks: ["P1", "P2", "P3", "P4", "P8", "P9"].map(id => ({ id, ok: true })), target: null, install: null });
      offer(f); await vi.waitFor(() => expect(g.alerts).toHaveLength(1));
      await f.fm.refreshUpdatePreflight(); await settle();
      expect(probe).toHaveBeenCalled();
      expect(g.alerts.at(-1).choices.map((c: any) => c.label)).toEqual(["Update when idle", "Tonight", "Not now"]);
      probe.mockResolvedValue({ class: "stop", checkedAt: Date.now(), pressHere: false, checks: [{ id: "P9", ok: false, code: "container" }], target: null, install: null });
      f.fm.updatePreflight = null;
      await f.fm.refreshUpdatePreflight();
      await vi.waitFor(() => expect(g.alerts.at(-1).choices.map((c: any) => c.label)).toEqual(["Not now"]));
    } finally { await f.stop(); }
  });
});
