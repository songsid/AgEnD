/**
 * AGEND-251: the second round of the upstream review of #3771 (Prism, REQUEST_CHANGES at 03be7f273), the parts that need a real lifecycle or file. One describe per item; every negative was run
 * against the pre-fix source to see it fail. Fixture strings only; no account, no token, no real `agy`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { antigravityCapKey, clearProviderRateLimitsForTests, getProviderRateLimit } from "../src/usage/provider-alerts.js";

// The real Daemon (constructor, setters, event emitter) with only its external launch replaced: the start is the real InstanceLifecycle.start.
vi.mock("../src/daemon.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../src/daemon.js")>();
  class NoLaunchDaemon extends mod.Daemon {
    override async start(): Promise<void> {}
    override async abortStartup(): Promise<void> {}
  }
  return { ...mod, Daemon: NoLaunchDaemon };
});

const dirs: string[] = [];
afterEach(() => { clearProviderRateLimitsForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("P2-6 (round 2): the quota cap belongs to the launch, even when Settings saves another account while the start is still awaiting", () => {
  const CAP = "Individual quota reached. Resets in 139h12m12s";
  type Fleet = { instances: Record<string, Record<string, unknown>>; defaults: Record<string, unknown> };
  const rig = (fleet: Fleet) => {
    const root = mkdtempSync(join(tmpdir(), "agend-251-")); dirs.push(root);
    const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
    // What FleetManager.credentialProfileOf does for a configured instance: the CURRENT fleet configuration's answer.
    const profileNow = (n: string, backend: string) => {
      const inst = fleet.instances[n] as any, defaults = fleet.defaults as any;
      return inst?.backend_options?.[backend]?.credential_profile ?? defaults?.backend_options?.[backend]?.credential_profile ?? null;
    };
    let admit!: () => void; const held = new Promise<void>(r => { admit = r; });
    const base: Record<string, unknown> = {
      fleetConfig: fleet, logger, eventLog: null, deliveryOutbox: null, controlClient: null, dataDir: root,
      getInstanceDir: (n: string) => join(root, "instances", n), isPlannedRestart: () => false, notifyInstanceTopic: () => true, webhookEmit: () => {}, clearCancelButton: () => {},
      instanceIpcClients: new Map(), credentialProfileOf: profileNow,
      // The start's first await after the configuration was read: held until the test says so (a reconcile / spawn / readiness wait in production).
      admitCredentialUse: async () => { await held; return null; },
    };
    const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
    return { lc: new InstanceLifecycle(ctx), root, admit };
  };
  const hit = (lc: InstanceLifecycle, name: string) => lc.daemons.get(name)!.emit("pty_error", { name, type: "quota", action: "notify", message: CAP });
  const launchConfig = (root: string, extra: Record<string, unknown>) => ({ working_directory: join(root, "work"), ...extra }) as any;

  it("launch as `work` → Settings saves `other` while the start is held → the start finishes → the cap lands on `work` (and not on `other` or the default)", async () => {
    const fleet: Fleet = { instances: { agy: { backend: "antigravity", backend_options: { antigravity: { credential_profile: "work" } } } }, defaults: {} };
    const { lc, root, admit } = rig(fleet);
    const starting = lc.start("agy", launchConfig(root, JSON.parse(JSON.stringify(fleet.instances.agy))), false);
    await new Promise(r => setTimeout(r, 20));                                  // the start is now inside its await
    (fleet.instances.agy as any).backend_options.antigravity.credential_profile = "other";   // the Settings save in the window
    admit(); await starting;
    hit(lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey("work"))).not.toBeNull();
    expect(getProviderRateLimit(antigravityCapKey("other"))).toBeNull(); expect(getProviderRateLimit(antigravityCapKey(null))).toBeNull();
  });
  it("an INHERITED default counts: launched under the fleet default account `work` (the instance names none), the default is later changed to `other` during the start → `work`", async () => {
    const fleet: Fleet = { instances: { agy: { backend: "antigravity" } }, defaults: { backend_options: { antigravity: { credential_profile: "work" } } } };
    const { lc, root, admit } = rig(fleet);
    // AGEND-252: a start is handed the configuration with the defaults ALREADY applied (config.ts), so the inherited account is in it.
    const starting = lc.start("agy", launchConfig(root, { backend: "antigravity", backend_options: JSON.parse(JSON.stringify(fleet.defaults.backend_options)) }), false);
    await new Promise(r => setTimeout(r, 20));
    (fleet.defaults as any).backend_options.antigravity.credential_profile = "other";
    admit(); await starting;
    hit(lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey("work"))).not.toBeNull(); expect(getProviderRateLimit(antigravityCapKey("other"))).toBeNull();
  });
  it("the BACKEND is bound too: launched as antigravity, the instance is saved as another backend during the start → the cap is still Antigravity's", async () => {
    const fleet: Fleet = { instances: { agy: { backend: "antigravity" } }, defaults: {} };
    const { lc, root, admit } = rig(fleet);
    const starting = lc.start("agy", launchConfig(root, { backend: "antigravity" }), false);
    await new Promise(r => setTimeout(r, 20));
    (fleet.instances.agy as any).backend = "claude-code";
    admit(); await starting;
    hit(lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey(null))).not.toBeNull();
  });
  it("positive control: with no save in the window the cap lands on the launched account", async () => {
    const fleet: Fleet = { instances: { agy: { backend: "antigravity", backend_options: { antigravity: { credential_profile: "work" } } } }, defaults: {} };
    const { lc, root, admit } = rig(fleet);
    const starting = lc.start("agy", launchConfig(root, JSON.parse(JSON.stringify(fleet.instances.agy))), false);
    admit(); await starting;
    hit(lc, "agy");
    expect(getProviderRateLimit(antigravityCapKey("work"))).not.toBeNull();
  });
});

describe("P2-8 / P3 (round 2): the skills agents read do not contradict themselves about Antigravity", () => {
  const skill = (name: string) => readFileSync(join(process.cwd(), "src/general-knowledge/skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
  const section = (text: string, heading: string) => { const at = text.indexOf(`## ${heading}`); expect(at, heading).toBeGreaterThan(-1); const rest = text.slice(at + 3 + heading.length); const next = rest.indexOf(" ## "); return next < 0 ? rest : rest.slice(0, next); };
  it("credential-profiles' mandatory 'Do not' section lists antigravity among the backends a credential_profile may be assigned to, and no longer calls it ignored", () => {
    const rules = section(skill("credential-profiles"), "Do not");
    expect(rules).toMatch(/other than `kiro-cli`, `codex`, `claude-code` or `antigravity`/);
    expect(rules).not.toMatch(/other than `kiro-cli`, `codex` or `claude-code`/);
    expect(rules).toMatch(/connecting that account is dashboard-only: do not offer `\/login` for it/);
  });
  it("the generic refusal guidance offers /login only for kiro-cli, codex and claude-code, with Antigravity named as the exception (dashboard)", () => {
    const text = skill("credential-profiles");
    expect(text).not.toContain("The refusal also names `/login <backend> <profile>`: offer that first, since it works from chat.");
    expect(text).toContain("For `kiro-cli`, `codex` and `claude-code` the refusal also names `/login <backend> <profile>`");
    expect(text).toMatch(/Antigravity is the exception: never tell the user to type `\/login` for it\./);
    expect(text).toMatch(/send the user there; a chat `\/login agy …` is refused/);
  });
  it("P3: web-dashboard no longer equates 'names no account' with the computer's default login", () => {
    const text = skill("web-dashboard");
    expect(text).not.toContain("the default connection is what an agent that names none uses");
    expect(text).toContain("an agent that names no account may inherit a named default set for the whole Fleet, so it is not necessarily the computer's own default login");
  });
});
