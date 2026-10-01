import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

/**
 * #1074 (review of #1077): the startup scan raises the sign-in incident INSIDE
 * Daemon.start — before InstanceLifecycle has attached its pty_error handler and
 * before it has registered the daemon. The incident used to be emitted into the
 * void while the daemon's dedupe flag stayed set forever, so the instance sat at
 * the login menu with no auth handling and no pause.
 *
 * Production wiring under test: the REAL InstanceLifecycle.start, the REAL Daemon
 * (only its external tmux launch is replaced — start() runs the real startup
 * dialog scan against a fake pane), the real backend factory.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (n: string) => readFileSync(join(fixtures, `claude-2.1.286-${n}.pane.txt`), "utf8");

const state: { pane: string; keys: string[] } = { pane: "", keys: [] };
const startOrder: string[] = [];

vi.mock("../src/daemon.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../src/daemon.js")>();
  class ScanOnlyDaemon extends mod.Daemon {
    // Replaces ONLY the external tmux launch; the startup dialog scan is the real one.
    override async start(): Promise<void> {
      const self = this as any;
      startOrder.push("daemon.start");
      self.tmux = {
        capturePane: async () => state.pane,
        isWindowAlive: async () => true,
        sendSpecialKey: async (k: string) => { state.keys.push(k); return true; },
        sendKeys: async () => true,
        getWindowId: () => "@9",
      };
      self.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
      await self.dismissDialogsUntilReady(2_000, 0);
    }
    override async abortStartup(): Promise<void> {}
  }
  return { ...mod, Daemon: ScanOnlyDaemon };
});

const dirs: string[] = [];
afterEach(() => {
  setAuthCheckRunnerForTests(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeLifecycle() {
  const root = mkdtempSync(join(tmpdir(), "agend-1074-wiring-")); dirs.push(root);
  const logged: { errors: unknown[][] } = { errors: [] };
  const logger: any = { info() {}, warn() {}, error: (...a: unknown[]) => { logged.errors.push(a); }, debug() {}, child() { return logger; } };
  const notified: string[] = [];
  const base: Record<string, unknown> = {
    fleetConfig: { instances: { worker: { backend: "claude-code" } }, defaults: { backend: "claude-code" } },
    logger,
    eventLog: null,
    deliveryOutbox: null,
    controlClient: null,
    dataDir: root,
    getInstanceDir: (n: string) => join(root, "instances", n),
    isPlannedRestart: () => false,
    notifyInstanceTopic: (_n: string, text: string) => { notified.push(String(text)); return true; },
    webhookEmit: () => {},
    clearCancelButton: () => {},
    instanceIpcClients: new Map(),
  };
  // Every other context member is a no-op: this test is about the incident path.
  const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
  const lc = new InstanceLifecycle(ctx);
  return { lc, root, notified, logged };
}

const config = (root: string) => ({ working_directory: join(root, "work"), backend: "claude-code" }) as any;

describe("startup incidents reach the lifecycle (production wiring)", () => {
  it("the login menu seen by the startup scan is delivered once the daemon is registered: auth is verified, then the instance is paused", async () => {
    state.pane = pane("onboarding-login-method"); state.keys = []; startOrder.length = 0;
    const probe = vi.fn(async () => ({ code: 1, output: '{"loggedIn": false}' }));
    setAuthCheckRunnerForTests(probe);
    const { lc, root, logged } = makeLifecycle();
    const pausedWhile: Array<{ registered: boolean }> = [];
    (lc as any).pause = vi.fn(async (n: string) => { pausedWhile.push({ registered: lc.daemons.has(n) }); });

    await lc.start("worker", config(root), false);
    await vi.waitFor(() => expect((lc as any).pause).toHaveBeenCalledTimes(1));

    expect(probe).toHaveBeenCalled();                                  // verifyAuthError ran on the held incident
    expect((lc as any).pause.mock.calls[0][0]).toBe("worker");
    expect(pausedWhile).toEqual([{ registered: true }]);               // pause could find the daemon
    expect(state.keys).toEqual([]);                                    // the login menu is never answered
    expect(logged.errors).toEqual([]);                                 // no "Unhandled error in async handler"
  });

  it("a normal ready pane raises no incident", async () => {
    state.pane = pane("ready"); state.keys = [];
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "" }));
    const { lc, root } = makeLifecycle();
    (lc as any).pause = vi.fn(async () => {});
    await lc.start("worker", config(root), false);
    await new Promise(r => setTimeout(r, 50));
    expect((lc as any).pause).not.toHaveBeenCalled();
  });
});

describe("Daemon incident hold/release (unit)", () => {
  it("holds pty_error until released, in order, and only then", async () => {
    const { Daemon } = await vi.importActual<typeof import("../src/daemon.js")>("../src/daemon.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-1074-hold-")); dirs.push(dir);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const d = new Daemon("hold", { working_directory: "/tmp", backend: "claude-code", log_level: "silent" } as any, dir, false, undefined, undefined, { child: () => logger } as any);
    const got: string[] = [];
    d.holdStartupIncidents();
    d.emit("pty_error", { type: "auth_error" });
    d.emit("pty_error", { type: "quota" });
    d.on("pty_error", (e: any) => got.push(e.type));
    expect(got).toEqual([]);
    d.releaseStartupIncidents();
    expect(got).toEqual(["auth_error", "quota"]);
    d.emit("pty_error", { type: "network" });                           // no longer held
    expect(got).toEqual(["auth_error", "quota", "network"]);
  });
});
