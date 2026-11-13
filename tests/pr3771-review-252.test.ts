/**
 * AGEND-252: the third round of the upstream review of #3771 (Prism, REQUEST_CHANGES at 9694ecf8d), P2-6 narrowed: the quota cap belongs to the account the daemon was ACTUALLY started with.
 *
 * The configuration here is what config.ts hands a start (`loadFleetConfigSource`: fleet defaults already applied), not a hand-written object, and the daemon is the real `Daemon` — only its external
 * launch is replaced. "The account it started with" is read from the real daemon's own adopted configuration (`credentialProfileStore`, the path it hands its transcript reader / login), not from
 * what the incident handlers believe. Fixture strings only; no account, no token, no real `agy`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetConfigSource } from "../src/config.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { antigravityCapKey, clearProviderRateLimitsForTests, getProviderRateLimit } from "../src/usage/provider-alerts.js";

vi.mock("../src/daemon.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../src/daemon.js")>();
  class NoLaunchDaemon extends mod.Daemon {
    override async start(): Promise<void> {}
    override async abortStartup(): Promise<void> {}
  }
  return { ...mod, Daemon: NoLaunchDaemon };
});

const dirs: string[] = [];
let savedHome: string | undefined;
beforeEach(() => { savedHome = process.env.AGEND_HOME; });
afterEach(() => {
  clearProviderRateLimitsForTests();
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CAP = "Individual quota reached. Resets in 139h12m12s";
const yamlOf = (root: string, defaultsProfile: string | null, instanceProfile: string | null) => {
  const opts = (indent: string, p: string | null) => (p ? `\n${indent}backend_options:\n${indent}  antigravity:\n${indent}    credential_profile: ${p}` : "");
  return `defaults:\n  backend: antigravity${opts("  ", defaultsProfile)}\ninstances:\n  agy:\n    working_directory: ${join(root, "work")}${opts("    ", instanceProfile)}\n`;
};

function rig(defaultsProfile: string | null, instanceProfile: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "agend-252-")); dirs.push(root);
  process.env.AGEND_HOME = root;
  const fleet = loadFleetConfigSource(yamlOf(root, defaultsProfile, instanceProfile));
  const config = fleet.instances.agy!;                                  // handed to the start BEFORE the wait: defaults already applied
  const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
  let admit!: () => void; const held = new Promise<void>(r => { admit = r; });
  const base: Record<string, unknown> = {
    fleetConfig: fleet, logger, eventLog: null, deliveryOutbox: null, controlClient: null, dataDir: root,
    getInstanceDir: (n: string) => join(root, "instances", n), isPlannedRestart: () => false, notifyInstanceTopic: () => true, webhookEmit: () => {}, clearCancelButton: () => {},
    instanceIpcClients: new Map(),
    // What FleetManager.credentialProfileOf answers: the CURRENT fleet configuration (the wrong source for a running launch).
    credentialProfileOf: (n: string, backend: string) => {
      const o = (fleet.instances[n] as any)?.backend_options?.[backend]?.credential_profile ?? (fleet.defaults as any)?.backend_options?.[backend]?.credential_profile;
      return o ?? null;
    },
    admitCredentialUse: async () => { await held; return null; },       // the manager's pre-launch wait (binary resolution, admission) in production
  };
  const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
  return { lc: new InstanceLifecycle(ctx), fleet, config, root, admit };
}
const hit = (lc: InstanceLifecycle, name: string) => lc.daemons.get(name)!.emit("pty_error", { name, type: "quota", action: "notify", message: CAP });
/** The account the REAL daemon runs as: the store its own adopted config selects (undefined = the default login). */
const actualStore = (lc: InstanceLifecycle, name: string) => (lc.daemons.get(name) as any).credentialProfileStore() as string | undefined;
/** FleetManager.startInstance: the configuration is captured, the manager then awaits (resolveBackendBinary), a Settings save lands, and only then does InstanceLifecycle.start run with the captured configuration. */
const startAfterSavingDuringManagerWait = async (r: ReturnType<typeof rig>, save: () => void) => {
  save();
  const starting = r.lc.start("agy", r.config, false);
  r.admit(); await starting;
};

describe("P2-6 (round 3): the cap follows the account the daemon actually started with, not the fleet defaults as they are by the time the start finishes", () => {
  it("default login launched → a NAMED fleet default `work` is saved during the manager's wait before the start → the daemon runs the default login and the cap is the DEFAULT account's (not `work`)", async () => {
    const r = rig(null);
    await startAfterSavingDuringManagerWait(r, () => { (r.fleet.defaults as any).backend_options = { antigravity: { credential_profile: "work" } }; });
    expect(actualStore(r.lc, "agy")).toBeUndefined();                    // the daemon's own account: the default login
    hit(r.lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey(null))).not.toBeNull();
    expect(getProviderRateLimit(antigravityCapKey("work"))).toBeNull();
  });
  it("positive control: launched as the named fleet default `work` (inherited at load) → the daemon runs `work` and the cap is `work`'s, even if the default is changed to `other` during the manager's wait", async () => {
    const r = rig("work");
    await startAfterSavingDuringManagerWait(r, () => { (r.fleet.defaults as any).backend_options = { antigravity: { credential_profile: "other" } }; });   // a save replaces the defaults it re-resolves
    expect(actualStore(r.lc, "agy")).toMatch(/work/);
    hit(r.lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey("work"))).not.toBeNull();
    expect(getProviderRateLimit(antigravityCapKey("other"))).toBeNull(); expect(getProviderRateLimit(antigravityCapKey(null))).toBeNull();
  });
  it("positive control: an instance's own named account `work` with no save in the window → the daemon runs `work` and the cap is `work`'s", async () => {
    const r = rig(null, "work");
    await startAfterSavingDuringManagerWait(r, () => {});
    expect(actualStore(r.lc, "agy")).toMatch(/work/);
    hit(r.lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey("work"))).not.toBeNull(); expect(getProviderRateLimit(antigravityCapKey(null))).toBeNull();
  });
});
