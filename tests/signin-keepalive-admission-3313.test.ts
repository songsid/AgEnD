/**
 * #3313 review (P1 reciprocal admission, P2 launched account, P2 no classicBot.yaml) — Keep sign-in alive and agent starts
 * exclude each other on the same sign-in, on the real FleetManager methods and the real InstanceLifecycle start:
 * - a keep-alive run holding a sign-in makes a start on it wait (before its CLI reads it); another sign-in starts at once;
 * - an agent starting (or running) on a sign-in makes a keep-alive run "in_use" — judged by the account it LAUNCHED on,
 *   never re-resolved against today's defaults;
 * - no classicBot.yaml is no rooms (renewal allowed); an empty one too; an unreadable one holds every sign-in.
 * Inert: scratch AGEND_HOME, no daemon process, the Daemon's launch replaced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
const order: string[] = [];
let failStart = false;
vi.mock("../src/daemon.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../src/daemon.js")>();
  class LaunchlessDaemon extends mod.Daemon {
    override async start(): Promise<void> { order.push("daemon.start"); if (failStart) throw new Error("launch failed"); }
    override async abortStartup(): Promise<void> {}
  }
  return { ...mod, Daemon: LaunchlessDaemon };
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-ka-adm-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");

let dir: string, fm: any;
const yaml = (defaultsProfile: string | null) => [
  "health_port: 0",
  ...(defaultsProfile ? ["defaults:", "  backend_options:", "    codex:", `      credential_profile: ${defaultsProfile}`] : []),
  "instances:",
  `  gpt:\n    working_directory: ${join(dir, "w")}\n    backend: codex`,
  `  cc:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: spare`,
].join("\n") + "\n";
function load(defaultsProfile: string | null = null) { writeFileSync(join(dir, "fleet.yaml"), yaml(defaultsProfile)); fm.loadConfig(join(dir, "fleet.yaml")); }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-ka-adm-"));
  mkdirSync(join(dir, "w"));
  for (const p of ["new", "spare"]) mkdirSync(join(dir, "credential-profiles", p === "new" ? "codex" : "claude-code", p), { recursive: true });
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  load();
});
afterEach(() => { rmSync(join(dir, "classicBot.yaml"), { force: true }); fm.credentialLeases.clear(); fm.daemons?.clear?.(); load(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const acquire = (backend: string, profile: string | null) => fm.acquireKeepAliveRun(backend, profile);
const startOn = (name: string) => fm.admitCredentialUse(name, fm.fleetConfig.instances[name], fm.fleetConfig.instances[name].backend, () => {});

describe("reciprocal admission (P1)", () => {
  it("a keep-alive run on a sign-in makes a start on it wait; a start on another sign-in goes at once", async () => {
    const hold = acquire("codex", null);
    expect(typeof hold).toBe("object");
    let admitted = false;
    const waiting = startOn("gpt").then((h: any) => { admitted = true; return h; });
    const other = await startOn("cc");                                     // claude-code / spare: not held
    expect(other).not.toBeNull();
    await new Promise(r => setTimeout(r, 20));
    expect(admitted).toBe(false);
    hold.release();
    const lease = await waiting;
    expect(admitted).toBe(true);
    lease.release(); other.release();
  });
  it("a start on a sign-in (not yet running) makes a keep-alive run in_use; released (the start failed) → it may run", async () => {
    const lease = await startOn("gpt");
    expect(acquire("codex", null)).toBe("in_use");
    const other = acquire("codex", "new");                                 // another sign-in of the same CLI
    expect(typeof other).toBe("object"); other.release();
    lease.release();
    const h = acquire("codex", null);
    expect(typeof h).toBe("object"); h.release();
  });
  it("a published start holds while its daemon lives; gone → dropped", async () => {
    const lease = await startOn("gpt");
    lease.published();
    fm.daemons.set("gpt", { getConfigSnapshot: () => fm.fleetConfig.instances.gpt });
    expect(acquire("codex", null)).toBe("in_use");
    fm.daemons.delete("gpt");
    const h = acquire("codex", null);
    expect(typeof h).toBe("object"); h.release();
    expect(fm.credentialLeases.has("gpt")).toBe(false);
  });
});

describe("the account a running agent LAUNCHED on (P2)", () => {
  it("launched on the default sign-in, then the fleet default changed to a named account: the default stays in use, the named one is free", async () => {
    const lease = await startOn("gpt");                                    // defaults: no profile → the default sign-in
    lease.published();
    fm.daemons.set("gpt", { getConfigSnapshot: () => fm.fleetConfig.instances.gpt });
    load("new");                                                           // today's default now names "new"
    expect(acquire("codex", null)).toBe("in_use");
    const h = acquire("codex", "new");
    expect(typeof h).toBe("object"); h.release();
  });
});

describe("ClassicBot rooms (P2)", () => {
  it("no classicBot.yaml: no rooms — an idle sign-in may be renewed; an empty file too", () => {
    for (const write of [() => {}, () => writeFileSync(join(dir, "classicBot.yaml"), "")]) {
      write();
      const a = acquire("codex", null);
      expect(typeof a).toBe("object"); a.release();
      const b = acquire("claude-code", "spare");
      expect(typeof b).toBe("object"); b.release();
    }
  });
  it("an unreadable classicBot.yaml holds every sign-in; a room bound to one holds that one", () => {
    writeFileSync(join(dir, "classicBot.yaml"), "channels: [not, a, map]\n");
    expect(acquire("codex", null)).toBe("in_use");
    writeFileSync(join(dir, "classicBot.yaml"), "channels:\n  room1:\n    channelId: '1'\n    adapterId: telegram\n    instanceName: r\n    backend: codex\n");
    expect(acquire("codex", null)).toBe("in_use");
    const h = acquire("claude-code", "spare");
    expect(typeof h).toBe("object"); h.release();
  });
});

describe("the real InstanceLifecycle start waits for the hold before its CLI starts (P1)", () => {
  function lifecycle(admit: (...a: unknown[]) => Promise<unknown>) {
    const root = mkdtempSync(join(tmpdir(), "agend-ka-lc-"));
    const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
    const base: Record<string, unknown> = {
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: { backend: "codex" } }, logger, eventLog: null, deliveryOutbox: null, controlClient: null,
      dataDir: root, getInstanceDir: (n: string) => join(root, "instances", n), isPlannedRestart: () => false, notifyInstanceTopic: () => true,
      webhookEmit: () => {}, clearCancelButton: () => {}, instanceIpcClients: new Map(), credentialProfileOf: () => null, admitCredentialUse: admit,
    };
    const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) });
    return { lc: new InstanceLifecycle(ctx as never), root };
  }
  it("held: no daemon start until admitted; published once registered", async () => {
    order.length = 0; failStart = false;
    let admit!: (v: unknown) => void;
    const calls: string[] = [];
    const hold = { published: () => calls.push(`published:${lc.daemons.has("worker")}`), release: () => calls.push("release") };
    const { lc, root } = lifecycle(() => new Promise(r => { admit = r; }));
    const started = lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false);
    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual([]);
    admit(hold);
    await started;
    expect(order).toEqual(["daemon.start"]);
    expect(calls).toEqual(["published:true"]);
  });
  it("a start that fails after admission releases its hold (never published)", async () => {
    order.length = 0; failStart = true;
    const calls: string[] = [];
    const { lc, root } = lifecycle(async () => ({ published: () => calls.push("published"), release: () => calls.push("release") }));
    await expect(lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false)).rejects.toThrow();
    expect(calls).toEqual(["release"]);
    failStart = false;
  });
});
