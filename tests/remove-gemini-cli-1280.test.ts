/**
 * #1280: gemini-cli is removed. A config that still names it fails validation with a message naming the instance
 * and the replacement (antigravity); at start that one instance refuses, says why, and the rest of the fleet comes
 * up. It is never swapped silently for another backend.
 *
 * Daemon is stubbed (no tmux, no CLI); scratch data directories only; no real fleet (bd0c88aa).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => [] as Array<{ name: string; backend: string }>);
vi.mock("../src/daemon.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../src/daemon.js")>();
  const { EventEmitter } = await import("node:events");
  class StubDaemon extends EventEmitter {
    bootId = "stub-boot";
    constructor(public name: string, _config: unknown, _dir: string, _topic: boolean, public backend: { binaryName?: string; constructor: { name: string } }) {
      super();
      // Anything else the lifecycle asks of a daemon is a no-op.
      return new Proxy(this, { get: (t, k) => (k in t ? (t as any)[k] : () => undefined) });
    }
    async start(): Promise<void> { started.push({ name: this.name, backend: this.backend.constructor.name }); }
    async stop(): Promise<void> {}
  }
  return { ...mod, Daemon: StubDaemon };
});

import { validateClassicBotConfig, validateFleetConfig } from "../src/config-validator.js";
import { createBackend } from "../src/backend/factory.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1280-")); dirs.push(d); return d; };
afterEach(() => { started.length = 0; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const REMOVED = /backend gemini-cli was removed in AgEnD 2\.1\.12 — set `backend: antigravity`/;

describe("validation names the instance and the replacement", () => {
  const fleet = (instances: Record<string, unknown>, defaults: Record<string, unknown> = {}) =>
    validateFleetConfig({ channel: { type: "telegram", group_id: 1, bot_token_env: "T" }, defaults, instances } as never);

  it("an instance's backend", () => {
    const result = fleet({ legacy: { working_directory: "/tmp/a", backend: "gemini-cli" }, ok: { working_directory: "/tmp/b", backend: "claude-code" } });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ path: "instances.legacy.backend" })]);
    expect(result.errors[0]!.message).toMatch(REMOVED);
    expect(result.errors[0]!.message).toContain('instance "legacy"');
  });

  it("the fleet default, and ClassicBot's default and channels", () => {
    expect(fleet({ a: { working_directory: "/tmp/a" } }, { backend: "gemini-cli" }).errors[0]).toMatchObject({ path: "defaults.backend", message: expect.stringMatching(REMOVED) });
    expect(validateClassicBotConfig({ defaults: { backend: "gemini-cli" } }).errors[0]).toMatchObject({ path: "defaults.backend", message: expect.stringMatching(REMOVED) });
    const classic = validateClassicBotConfig({ channels: { "1234567890": { name: "chat", instanceName: "chat-7890", backend: "gemini-cli" } } });
    expect(classic.errors).toEqual([expect.objectContaining({ path: "channels.1234567890.backend", message: expect.stringMatching(REMOVED) })]);
    expect(classic.errors[0]!.message).toContain('instance "chat-7890"');
  });

  it("other unknown backends keep their own message; valid ones pass", () => {
    expect(fleet({ a: { working_directory: "/tmp/a", backend: "nope" } }).errors[0]!.message).toMatch(/unknown backend "nope"/);
    expect(validateClassicBotConfig({ channels: { "1": { backend: "nope" } } }).errors[0]!.message).toMatch(/unknown backend "nope"/);
    expect(fleet({ a: { working_directory: "/tmp/a", backend: "antigravity" } }).valid).toBe(true);
    expect(validateClassicBotConfig({ channels: { "1": { backend: "muse" } } }).valid).toBe(true);
  });
});

describe("no backend is ever substituted", () => {
  it("the factory refuses gemini-cli with the replacement, rather than returning some other backend", () => {
    expect(() => createBackend("gemini-cli", scratch())).toThrow(REMOVED);
  });
});

function lifecycle(instances: Record<string, { backend?: string }>) {
  const root = scratch();
  const notified: Array<{ name: string; text: string }> = [];
  const errors: unknown[][] = [];
  const logger: any = { info() {}, warn() {}, debug() {}, error: (...a: unknown[]) => { errors.push(a); }, child() { return logger; } };
  const base: Record<string, unknown> = {
    fleetConfig: { defaults: {}, instances },
    logger, eventLog: null, deliveryOutbox: null, controlClient: null, dataDir: root,
    getInstanceDir: (n: string) => join(root, "instances", n),
    isPlannedRestart: () => false,
    notifyInstanceTopic: (name: string, text: string) => { notified.push({ name, text: String(text) }); return true; },
    webhookEmit: () => {}, clearCancelButton: () => {}, instanceIpcClients: new Map(),
    spawnGate: { run: (_task: unknown, operation: () => Promise<unknown>) => operation() },
    stormWindow: null, backendOutage: null,
  };
  const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
  return { lc: new InstanceLifecycle(ctx), root, notified, errors };
}

describe("start: the gemini-cli instance refuses, the others come up", () => {
  it("the removed one is not started (no daemon, no other backend) and says why in its topic", async () => {
    const { lc, root, notified, errors } = lifecycle({ legacy: { backend: "gemini-cli" } });
    await lc.start("legacy", { working_directory: join(root, "w1"), backend: "gemini-cli" } as never, false);
    expect(started).toEqual([]);
    expect(lc.daemons.has("legacy")).toBe(false);
    expect(notified).toEqual([expect.objectContaining({ name: "legacy", text: expect.stringContaining("backend: antigravity") })]);
    expect(notified[0]!.text).toContain('"legacy"');
    expect(errors.some(a => REMOVED.test(String(a[1])) && String(a[1]).includes('instance "legacy"'))).toBe(true);
  });

  it("a fleet default of gemini-cli is refused the same way for an instance that inherits it", async () => {
    const { lc, root, notified } = lifecycle({ legacy: {} });
    (lc as any).ctx.fleetConfig.defaults.backend = "gemini-cli";
    await lc.start("legacy", { working_directory: join(root, "w1") } as never, false);
    expect(started).toEqual([]);
    expect(notified[0]?.text).toContain("backend: antigravity");
  });
});

describe("fleet startup with a gemini-cli instance (after `agend update`)", () => {
  it("the other instances are started and ready; the gemini-cli one is neither started nor queued for a retry", async () => {
    const fm = new FleetManager(scratch());
    const any = fm as any;
    try {
      const w = scratch();
      any.fleetConfig = { defaults: {}, instances: {
        legacy: { working_directory: join(w, "legacy"), backend: "gemini-cli" },
        a: { working_directory: join(w, "a"), backend: "claude-code" },
        b: { working_directory: join(w, "b"), backend: "codex" },
      } };
      const retries = vi.spyOn(any, "scheduleStartupRetry").mockImplementation(() => {});
      const notices: Array<[string, string]> = [];
      vi.spyOn(any, "notifyInstanceTopic").mockImplementation((...a: unknown[]) => { notices.push([String(a[0]), String(a[1])]); return true; });
      const ready: string[] = [];
      await any.startInstancesWithConcurrency(Object.entries(any.fleetConfig.instances), false, (name: string) => ready.push(name));
      expect(ready.sort()).toEqual(["a", "b"]);
      expect(started.map(s => s.name).sort()).toEqual(["a", "b"]);
      expect(retries).not.toHaveBeenCalled();
      expect(notices.filter(([name]) => name === "legacy")).toEqual([["legacy", expect.stringContaining("backend: antigravity")]]);
    } finally {
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
    }
  });
});
