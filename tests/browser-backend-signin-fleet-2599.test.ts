/** Real unstarted FleetManager/session store; every native/auth/recovery effect is stubbed. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { writePendingBackendSignIns, readPendingBackendSignIns } from "../src/backend-signin-pending.js";
import { deriveNeedsYou, itemsForWorld } from "../src/needs-you.js";
const rigs: { fm: any; dir: string }[] = [];
afterEach(async () => { for (const h of rigs.splice(0)) { await h.fm.browserBackendSignInsInstance?.close(); await h.fm.stopNeedsYou(); rmSync(h.dir, { recursive: true, force: true }); } vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
function rig() {
  vi.useFakeTimers(); const dir = mkdtempSync(join(tmpdir(), "agend-signin-fm-"));
  writePendingBackendSignIns(dir, { version: 1, selected: ["codex"], pending: ["codex"] });
  const fm = new FleetManager(dir) as any; fm.fleetConfig = { defaults: {}, instances: {} }; rigs.push({ fm, dir });
  const sessions = new WebSessionStore({}); fm.webSessions = sessions; Object.defineProperty(fm, "webToken", { get: () => "scratch-token" });
  const owner = sessions.create({ tier: "admin", surface: "local", label: "Scratch browser", tokenEpoch: tokenEpoch("scratch-token") }).record;
  vi.spyOn(fm, "isCliInstalled").mockReturnValue(true); const notice = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
  const recovery = vi.spyOn(fm, "recoverBackendInstances").mockResolvedValue({ woken: [], restarted: [], pending: [] });
  const availability = vi.spyOn(fm.backendAvailability, "refresh").mockResolvedValue(undefined);
  const state = { auth: "invalid" as "valid" | "invalid", alive: true };
  const transport = { start: vi.fn(async () => {}), capture: vi.fn(async () => "https://auth.openai.com/codex/device\nTEST-CODE"), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const service = fm.browserBackendSignIns; service.deps.checkAuth = vi.fn(async () => state.auth); service.deps.transport = () => transport;
  return { fm, dir, sessions, owner, state, service, transport, notice, recovery, availability };
}
it("pending selected backends without an agent are web-only Needs you items", () => {
  const h = rig(); const inputs = h.fm.needsYouBackendSignIns();
  expect(inputs).toEqual([{ backend: "codex", since: expect.any(Number), browser: true }]);
  const needs = deriveNeedsYou({ instances: [], prompts: [], deliveries: [], backendSignIns: inputs, ownerOf: () => "discord" });
  expect(needs).toMatchObject([{ type: "backend", instance: "", reason: "backend_signin", detail: "codex", signIn: { backend: "codex" } }]);
  h.fm.startNeedsYou(); expect(h.fm.needsYouItems()).toMatchObject([{ type: "backend", signIn: { backend: "codex" } }]);
  expect(needs[0]!.owner).toBeUndefined(); expect(itemsForWorld(needs, "discord")).toEqual([]);
  writePendingBackendSignIns(h.dir, { version: 1, selected: ["codex"], pending: [] }); expect(h.fm.needsYouBackendSignIns()).toEqual([]);
});
it("owner identity is the current store record, not a caller-supplied handle", () => {
  const h = rig(); expect(h.fm.browserSignInOwnerCurrent(h.owner)).toBe(true);
  expect(h.fm.browserSignInOwnerCurrent({ ...h.owner })).toBe(false);
  h.sessions.revokeByHandle(h.owner.handle); expect(h.fm.browserSignInOwnerCurrent(h.owner)).toBe(false);
  expect(h.transport.start).not.toHaveBeenCalled();
});
it("verified completion alone clears pending, refreshes availability and invokes stubbed default-account recovery", async () => {
  const h = rig(); await h.service.begin(h.owner, "codex"); expect(h.notice).toHaveBeenCalledOnce(); expect(h.recovery).not.toHaveBeenCalled();
  expect(h.service.deps.lock).toBe(h.fm.loginWindow); h.state.auth = "valid"; h.state.alive = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(h.recovery).toHaveBeenCalledWith("codex", undefined, null); expect(h.availability).toHaveBeenCalledWith(["codex"], { force: true });
  expect(readPendingBackendSignIns(h.dir).pending).toEqual([]); expect(h.fm.needsYouBackendSignIns()).toEqual([]); expect(h.transport.close).toHaveBeenCalledOnce();
});
it("chat cancel waits for the structured writer cleanup before releasing the slot", async () => {
  const h = rig(); await h.service.begin(h.owner, "codex"); let release!: () => void;
  h.transport.close.mockReturnValue(new Promise<void>(r => { release = r; })); let finished = false;
  const cancel = h.fm.cancelLoginSession().then(() => { finished = true; }); await Promise.resolve();
  expect(finished).toBe(false); expect(h.fm.loginWindow.isHeld).toBe(true);
  release(); await cancel; expect(h.fm.loginWindow.isHeld).toBe(false); expect(h.fm.browserBackendSignInsInstance).toBeNull();
});
it("fleet shutdown awaits reap; failed cleanup keeps sign-in admission closed", async () => {
  const h = rig(); await h.service.begin(h.owner, "codex"); h.transport.close.mockRejectedValue(new Error("private vendor data")); h.fm.shuttingDown = true;
  await h.fm.shutdownLoginWindows(); expect(h.fm.loginWindow.isClosed).toBe(true); expect(h.fm.structuredLoginCleanupFailed).toBe(true);
  expect(h.fm.browserBackendSignInsInstance).toBe(h.service); expect(h.recovery).not.toHaveBeenCalled();
});

it("reusing already valid credentials clears the hint without restarting running agents", async () => {
  const h = rig(); h.state.auth = "valid"; await h.service.begin(h.owner, "codex");
  expect(readPendingBackendSignIns(h.dir).pending).toEqual([]); expect(h.transport.start).not.toHaveBeenCalled(); expect(h.recovery).not.toHaveBeenCalled();
});

it("an existing install reservation blocks the FleetManager structured entry too", async () => {
  const h = rig(); const claim = h.fm.loginWindow.tryClaim("install", "codex");
  const busy = await h.service.begin(h.owner, "codex"); expect(busy.login?.reason).toBe("busy"); expect(h.transport.start).not.toHaveBeenCalled(); h.fm.loginWindow.release(claim);
});
