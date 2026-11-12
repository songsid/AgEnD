/**
 * AGEND-203: connecting Grok in Settings was refused with "Your claude-code account is already being connected. Use /login cancel first." — a sign-in nobody
 * finished held the ONE login window of the whole fleet. Windows are now per backend (login-window-lock.ts); a refused start in the dashboard is answered
 * without a chat command and with the backend whose sign-in the dialog can end; a dialog that is closed ends the sign-in it started.
 * Real LoginWindowLock, FleetManager (unstarted) and BrowserBackendSignIns; every CLI/auth/recovery effect stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { writePendingBackendSignIns } from "../src/backend-signin-pending.js";
import { setLocale, t } from "../src/locale.js";

describe("LoginWindowLock: one window per backend", () => {
  it("different backends hold windows together; the same backend, once", () => {
    const lock = new LoginWindowLock();
    const claude = lock.tryClaim("web", "claude-code");
    expect(claude).not.toBeNull();
    expect(lock.tryClaim("web", "claude-code")).toBeNull();
    expect(lock.tryClaim("keepalive", "claude-code")).toBeNull();
    const grok = lock.tryClaim("web", "grok");
    expect(grok).not.toBeNull();
    expect(lock.held.map(c => c.backend).sort()).toEqual(["claude-code", "grok"]);
    expect(lock.heldFor("grok")).toBe(grok);
    expect(lock.isCurrent(claude)).toBe(true); expect(lock.isCurrent(grok)).toBe(true);
    expect(lock.release(claude)).toBe(true);
    expect(lock.isCurrent(claude)).toBe(false); expect(lock.isCurrent(grok), "releasing one leaves the other").toBe(true);
    expect(lock.release(claude), "only the exact claim frees a window").toBe(false);
    expect(lock.tryClaim("web", "claude-code")).not.toBeNull();
  });
  it("an install is exclusive among installs, and holds only its own backend's window", () => {
    const lock = new LoginWindowLock();
    const install = lock.tryClaim("install", "grok");
    expect(lock.tryClaim("install", "codex")).toBeNull();
    expect(lock.tryClaim("web", "grok")).toBeNull();
    expect(lock.tryClaim("web", "codex")).not.toBeNull();
    expect(lock.busyMessage("grok")).toBe(t("install.busy"));
    expect(lock.busyMessage("claude-code"), "an install claim refused for another backend's install says so").toBe(t("install.busy"));
    lock.release(install);
    expect(lock.tryClaim("install", "claude-code")).not.toBeNull();
  });
  it("names the holder of the backend asked about; close() ends every window, reopen() accepts claims again", () => {
    const lock = new LoginWindowLock();
    const claude = lock.tryClaim("web", "claude-code")!; const grok = lock.tryClaim("web", "grok")!;
    expect(lock.busyMessage("claude-code")).toBe(t("login.busy", "claude-code"));
    expect(lock.busyMessage("grok")).toBe(t("login.busy", "grok"));
    expect(lock.holderFor("grok")).toBe(grok);
    lock.close();
    expect(lock.isHeld).toBe(false); expect(lock.isCurrent(claude)).toBe(false); expect(lock.isCurrent(grok)).toBe(false);
    expect(lock.tryClaim("web", "codex")).toBeNull(); expect(lock.busyMessage("codex")).toBe(t("login.web_shutting_down"));
    lock.reopen();
    expect(lock.tryClaim("web", "codex")).not.toBeNull();
  });
});

const rigs: { fm: any; dir: string }[] = [];
afterEach(async () => { for (const h of rigs.splice(0)) { await h.fm.browserBackendSignInsInstance?.close(); await h.fm.loginController?.shutdown(); await h.fm.stopNeedsYou(); rmSync(h.dir, { recursive: true, force: true }); } vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); setLocale("en"); });
function rig() {
  vi.useFakeTimers(); const dir = mkdtempSync(join(tmpdir(), "agend-signin-203-"));
  writePendingBackendSignIns(dir, { version: 1, selected: ["codex", "claude-code"], pending: ["codex", "claude-code"] });
  const fm = new FleetManager(dir) as any; fm.fleetConfig = { defaults: {}, instances: {} }; rigs.push({ fm, dir });
  const sessions = new WebSessionStore({}); fm.webSessions = sessions; Object.defineProperty(fm, "webToken", { get: () => "scratch-token" });
  const owner = sessions.create({ tier: "admin", surface: "local", label: "Scratch browser", tokenEpoch: tokenEpoch("scratch-token") }).record;
  vi.spyOn(fm, "isCliInstalled").mockReturnValue(true); vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(true); vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
  vi.spyOn(fm, "recoverBackendInstances").mockResolvedValue({ woken: [], restarted: [], pending: [] });
  vi.spyOn(fm.backendAvailability, "refresh").mockResolvedValue(undefined);
  const state = { auth: "invalid" as "valid" | "invalid", alive: true };
  const transport = { start: vi.fn(async () => {}), capture: vi.fn(async () => "https://auth.openai.com/codex/device\nTEST-CODE"), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const service = fm.browserBackendSignIns; service.deps.checkAuth = vi.fn(async () => state.auth); service.deps.transport = () => transport;
  // Grok's own pre-check never reaches a real CLI.
  const web = fm.webLogin; web.deps.checkAuth = async () => "invalid";
  return { fm, dir, sessions, owner, state, service, transport, web };
}
const webChat = (handle: string, busy?: (b: string) => void) => {
  const sink = { isAdmin: () => true, confirm: vi.fn(), hint: vi.fn(), terminal: vi.fn(), ended: vi.fn(), ...(busy ? { busy } : {}) };
  const adapter = { type: "web", id: "web", sendText: vi.fn(async () => ({ chatId: "web", messageId: "1" })) } as never;
  return { chat: { adapter, adapterId: "web", chatId: "web", userId: `web:${handle}`, web: sink }, sink };
};

describe("FleetManager: an unfinished sign-in of one backend does not stop another's", () => {
  it("the Claude Code sign-in (the dashboard's structured one) is running: asking to connect Grok reaches the confirmation instead of the busy refusal", async () => {
    const h = rig();
    await h.service.begin(h.owner, "claude-code");
    expect(h.fm.loginWindow.heldFor("claude-code")).not.toBeNull();
    const { chat, sink } = webChat(h.owner.handle);
    expect(await h.web.start("grok", chat, {})).toBeNull();                        // null: the dialog's confirmation was asked, not refused
    expect(sink.confirm).toHaveBeenCalledOnce();
    // …and confirmed, it runs beside it: both windows are held at once.
    const started = webChat(h.owner.handle);
    h.web.deps.createSession = () => ({ start: async () => {}, cancel: async () => {}, state: "running", peekAccessToken: () => null, on() {}, once() {}, off() {} });
    h.web.deps.createHttp = () => ({ listen: async () => ({ port: 1, url: "http://localhost:1/t/x/" }), close: async () => {}, setExternalHost() {}, readinessMarker: "ready" });
    await h.web.start("grok", started.chat, { skipAuthCheck: true, tokenPresent: false });
    expect(h.fm.loginWindow.heldFor("grok")).not.toBeNull();
    expect(h.fm.loginWindow.heldFor("claude-code")).not.toBeNull();
  });

  it("the same backend is still refused, in words the dashboard can show (no chat command), naming the sign-in to end", async () => {
    const h = rig();
    await h.service.begin(h.owner, "claude-code");
    const busy: string[] = [];
    const { chat } = webChat(h.owner.handle, b => busy.push(b));
    const answer = await h.web.start("claude-code", chat, {});
    expect(answer).toBe(t("login.busy_web", "claude-code"));
    expect(busy).toEqual(["claude-code"]);
    expect(answer).not.toContain("/login");
    // Chat keeps its own words.
    const chatOnly = { ...chat, adapterId: "telegram", web: undefined, userId: "u1" };
    h.fm.isFleetAdmin = () => true;
    expect(await h.web.start("claude-code", chatOnly as never, {})).toBe(t("login.busy", "claude-code"));
  });

  it("cancelLoginSession(backend) ends only that backend's sign-in; no argument still ends whatever runs (/login cancel)", async () => {
    const h = rig();
    await h.service.begin(h.owner, "claude-code");
    expect(await h.fm.cancelLoginSession("grok")).toBe(t("login.no_session"));
    expect(h.fm.loginWindow.heldFor("claude-code"), "another backend's cancel leaves it running").not.toBeNull();
    expect(h.transport.close).not.toHaveBeenCalled();
    expect(await h.fm.cancelLoginSession("claude-code")).toBe(t("login.cancelled", "claude-code"));
    expect(h.transport.close).toHaveBeenCalledOnce();
    expect(h.fm.loginWindow.isHeld).toBe(false);
    const again = h.fm.browserBackendSignIns; again.deps.checkAuth = vi.fn(async () => "invalid"); again.deps.transport = () => h.transport;
    await again.begin(h.owner, "codex");
    expect(await h.fm.cancelLoginSession()).toBe(t("login.cancelled", "codex"));
    expect(h.fm.loginWindow.isHeld).toBe(false);
  });
});

describe("a sign-in nobody finishes does not stay: the dialog's close (by run id), and the ten minutes", () => {
  it("cancel with the run's id ends it and frees the backend; another run's id leaves it alone", async () => {
    const h = rig();
    const started = await h.service.begin(h.owner, "claude-code");
    const id = started.login!.id;
    await h.service.cancel(h.owner, "f".repeat(32));
    expect(h.fm.loginWindow.heldFor("claude-code"), "a stale id (another dialog's run) ends nothing").not.toBeNull();
    expect(h.transport.close).not.toHaveBeenCalled();
    await h.service.cancel(h.owner, id);
    expect(h.fm.loginWindow.heldFor("claude-code")).toBeNull();
    expect(h.transport.close).toHaveBeenCalledOnce();
    // Without an id: whatever runs, as before.
    await h.service.begin(h.owner, "claude-code");
    await h.service.cancel(h.owner);
    expect(h.fm.loginWindow.isHeld).toBe(false);
  });

  it("left alone it expires after ten minutes: the window is released and the child reaped", async () => {
    const h = rig();
    await h.service.begin(h.owner, "claude-code");
    expect(h.fm.loginWindow.heldFor("claude-code")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(h.fm.loginWindow.isHeld).toBe(false);
    expect(h.transport.close).toHaveBeenCalledOnce();
    expect((h.service.snapshot(h.owner).login)).toMatchObject({ phase: "failed", reason: "expired" });
  });

  it("a failed sign-in releases the window as well: the CLI ended and the account is still not signed in", async () => {
    const h = rig();
    await h.service.begin(h.owner, "claude-code");
    expect(h.fm.loginWindow.heldFor("claude-code")).not.toBeNull();
    h.state.alive = false;                                                         // the CLI exited without a sign-in (auth still invalid)
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.fm.loginWindow.heldFor("claude-code")).toBeNull();
    expect(h.transport.close).toHaveBeenCalledOnce();
    expect(h.service.snapshot(h.owner).login).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" });
  });
});
