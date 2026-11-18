/**
 * M-3302 (#4146): an instance whose backend CLI is not installed (`claude` gone after a half-finished npm install) is not
 * just another start failure.
 * - The start that found the binary definitely missing (resolveBackendBinary → null) and then failed is told apart
 *   (InstanceLifecycle.missingBinaryAt).
 * - The fleet holds the instance instead of the 1 → 5 → 15 min backoff that gives up: one notice per binary naming the
 *   binary and its install command, and a Needs you item with both.
 * - Every MISSING_BINARY_WATCH_MS it looks again and starts each held instance as soon as the binary is back. In #4146 the
 *   backoff gave up at the very second of the manual fix.
 * - A person's start/stop drops the hold.
 * Rig: tests/kiro-startup-resilience.test.ts's (FleetManager with startInstance stubbed, fake timers).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as availability from "../src/backend-availability.js";
import { FleetManager } from "../src/fleet-manager.js";
import { BackendBinaryMissingError, BACKEND_INSTALLATION_INFO, InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { Daemon } from "../src/daemon.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { noteResolvedBinary } from "../src/backend/types.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const INSTALL = BACKEND_INSTALLATION_INFO["claude-code"]!.install;

function makeFleet() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-3302-")); dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  fm.fleetConfig = { defaults: { backend: "claude-code", startup: { concurrency: 4, stagger_delay_ms: 0 } }, instances: { a: { working_directory: "/tmp/a" }, b: { working_directory: "/tmp/b" } } } as any;
  const notifyFleetError = vi.fn();
  Object.assign(fm, { notifyFleetError });
  // What lifecycle.start throws when the binary is gone: its pre-check found it missing, then the spawn failed.
  const startInstance = vi.spyOn(fm, "startInstance").mockRejectedValue(new BackendBinaryMissingError("x", "claude-code", "claude"));
  const resolve = vi.spyOn(availability, "resolveBackendBinary").mockResolvedValue(null);
  const cleanup = () => {
    fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    for (const p of (fm as any).startupRetries.values()) clearTimeout(p.timer);
    for (const p of (fm as any).startupRetryNotices.values()) clearTimeout(p.timer);
    for (const p of (fm as any).missingBinaryNotices.values()) clearTimeout(p.timer);
    if ((fm as any).missingBinaryWatch) clearInterval((fm as any).missingBinaryWatch);
  };
  return { fm, notifyFleetError, startInstance, resolve, cleanup };
}
const entries = () => [["a", { working_directory: "/tmp/a" }], ["b", { working_directory: "/tmp/b" }]] as any;

describe("M-3302: a missing backend binary", () => {
  it("is held, not put on the giving-up backoff; one notice names the binary and the install command", async () => {
    const { fm, notifyFleetError, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      expect(fm.pendingStartupRetry("a")).toBeNull();
      expect(fm.pendingStartupRetry("b")).toBeNull();
      expect(fm.missingBinaryHold("a")).toMatchObject({ backend: "claude-code", binary: "claude", fix: INSTALL });
      await vi.advanceTimersByTimeAsync(FleetManager.STARTUP_RETRY_NOTICE_AGGREGATE_MS);
      expect(notifyFleetError).toHaveBeenCalledTimes(1);
      expect(notifyFleetError).toHaveBeenCalledWith(t("fleet.backend_binary_missing", 2, "a, b", "claude", INSTALL));
      expect(String(notifyFleetError.mock.calls[0]![0])).not.toMatch(/Automatic retry in/);
    } finally { cleanup(); }
  });

  it("keeps watching past the old 21-minute give-up, and starts each held instance the moment the binary is back", async () => {
    const { fm, startInstance, resolve, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      expect(startInstance).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30 * 60_000);                       // longer than 1 + 5 + 15 min
      expect(startInstance).toHaveBeenCalledTimes(2);                        // nothing started while it is missing
      expect(fm.missingBinaryHold("a")).not.toBeNull();
      startInstance.mockResolvedValue(undefined as never);
      resolve.mockResolvedValue("/usr/bin/claude");                          // the person reinstalled it
      await vi.advanceTimersByTimeAsync(FleetManager.MISSING_BINARY_WATCH_MS);
      expect(startInstance).toHaveBeenCalledTimes(4);
      expect(startInstance.mock.calls.slice(2).map(c => c[0]).sort()).toEqual(["a", "b"]);
      expect(fm.missingBinaryHold("a")).toBeNull();
      expect((fm as any).missingBinaryWatch).toBeNull();                     // nothing held: the watch stops
    } finally { cleanup(); }
  });

  it("a start that fails while its pre-check found the binary missing is told apart (missingBinaryAt); another failure is not", () => {
    const { fm, cleanup } = makeFleet();
    try {
      (fm.lifecycle as any).missingBinaries.set("a", { backend: "claude-code", binary: "claude" });
      expect(fm.lifecycle.missingBinaryAt("a", new Error("tmux: no such command"))).toMatchObject({ backend: "claude-code", binary: "claude", instance: "a" });
      expect(fm.lifecycle.missingBinaryAt("b", new Error("boom"))).toBeNull();
    } finally { cleanup(); }
  });

  it("control: any other start failure keeps the normal backoff", async () => {
    const { fm, startInstance, cleanup } = makeFleet();
    startInstance.mockRejectedValue(new Error("CLI failed to start after retry"));
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 0 });
      expect(fm.missingBinaryHold("a")).toBeNull();
    } finally { cleanup(); }
  });

  it("a person's stop drops the hold; it is not started when the binary returns", async () => {
    const { fm, startInstance, resolve, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      vi.spyOn(fm.lifecycle, "stop").mockResolvedValue(undefined);
      await fm.stopInstance("a");
      expect(fm.missingBinaryHold("a")).toBeNull();
      startInstance.mockResolvedValue(undefined as never);
      resolve.mockResolvedValue("/usr/bin/claude");
      await vi.advanceTimersByTimeAsync(FleetManager.MISSING_BINARY_WATCH_MS);
      expect(startInstance.mock.calls.slice(2).map(c => c[0])).toEqual(["b"]);
    } finally { cleanup(); }
  });

  it("Needs you: one item per held instance with the binary and its install command; zh-TW notice", () => {
    const items = deriveNeedsYou({ instances: [{ name: "a", backendMissing: { backend: "claude-code", binary: "claude", since: 5, fix: INSTALL } }], prompts: [], deliveries: [], ownerOf: () => undefined } as any);
    expect(items).toEqual([expect.objectContaining({ id: "backend-missing:a:5", type: "instance", instance: "a", reason: "backend_missing", detail: `claude — ${INSTALL}` })]);
    setLocale("zh-TW");
    expect(t("fleet.backend_binary_missing", 1, "a", "claude", INSTALL)).toContain("找不到 `claude`");
    expect(t("needs.reason.backend_missing")).toBe("AI CLI 沒有安裝");
  });
});

describe("M-3302: InstanceLifecycle remembers what its pre-check found (#1490's harness)", () => {
  function lifecycle() {
    vi.useRealTimers();
    noteResolvedBinary("codex", null);
    const root = mkdtempSync(join(tmpdir(), "agend-3302-lc-")); dirs.push(root);
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("tmux: codex: command not found"));
    vi.spyOn(Daemon.prototype, "stop").mockResolvedValue();
    vi.spyOn(Daemon.prototype, "abortStartup").mockResolvedValue();
    vi.spyOn(IpcServer.prototype, "listen").mockResolvedValue();
    const logger: any = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
    const base: Record<string, unknown> = {
      fleetConfig: { defaults: {}, instances: { worker: { backend: "codex" } } },
      logger, eventLog: null, deliveryOutbox: null, controlClient: null, dataDir: root,
      getInstanceDir: (n: string) => join(root, "instances", n), isPlannedRestart: () => false, notifyInstanceTopic: () => true,
      webhookEmit: () => {}, clearCancelButton: () => {}, instanceIpcClients: new Map(),
      spawnGate: { run: (_task: unknown, operation: () => Promise<unknown>) => operation() },
      stormWindow: null, backendOutage: null, agentCredentials: undefined,
    };
    const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
    return { lc: new InstanceLifecycle(ctx), root };
  }
  afterEach(() => noteResolvedBinary("codex", null));

  it("binary definitely missing, then the start fails: that failure is the missing binary", async () => {
    vi.spyOn(availability, "resolveBackendBinary").mockResolvedValue(null);
    const { lc, root } = lifecycle();
    const err = await lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false).then(() => null, e => e);
    expect(err).toBeInstanceOf(Error);
    expect(lc.missingBinaryAt("worker", err)).toMatchObject({ backend: "codex", binary: BACKEND_INSTALLATION_INFO.codex!.binary });
  });

  it.each([["found", "/usr/local/bin/codex"], ["unknown (the probe could not tell)", undefined]] as const)("binary %s: a failure stays a plain failure", async (_label, path) => {
    vi.spyOn(availability, "resolveBackendBinary").mockResolvedValue(path as string | undefined);
    const { lc, root } = lifecycle();
    const err = await lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false).then(() => null, e => e);
    expect(err).toBeInstanceOf(Error);
    expect(lc.missingBinaryAt("worker", err)).toBeNull();
  });
});
