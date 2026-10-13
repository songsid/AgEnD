/**
 * #1699 follow-up: an instance on a credential profile has a login of its own. Its auth error is judged by probing THAT
 * login (the profile's environment), cached and alerted per backend+profile, and the remedy names the profile's own
 * sign-in — for every backend with profiles (claude-code, kiro-cli, codex).
 *
 * The real InstanceLifecycle and the real FleetManager.credentialProfileOf over a plain fleet config; the probe is the
 * test seam (setAuthCheckRunnerForTests) answering per environment, except one real-process check of the env merge.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { checkAuthStatus, setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { FleetManager } from "../src/fleet-manager.js";
import { claudeConfigDirFor } from "../src/backend/claude-code.js";

let agendHome: string;
const savedHome = process.env.AGEND_HOME;
// The fleet's own claude config dir comes from this process's CLAUDE_CONFIG_DIR — set when the test run itself is a
// profile instance. Every test starts without it; one sets it on purpose.
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  agendHome = mkdtempSync(join(tmpdir(), "agend-auth-1699-")); process.env.AGEND_HOME = agendHome;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  setAuthCheckRunnerForTests(null);
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  rmSync(agendHome, { recursive: true, force: true });
});

/** Each backend with profiles: its variable, its sign-in line, and what its probe prints for a good / a bad login. */
const BACKENDS = [
  { backend: "claude-code", env: "CLAUDE_CONFIG_DIR", login: "claude auth login", ok: { code: 0, output: '{"loggedIn": true}' }, bad: { code: 0, output: '{"loggedIn": false}' } },
  { backend: "kiro-cli", env: "XDG_DATA_HOME", login: "kiro-cli login", ok: { code: 0, output: '{"email":"x"}' }, bad: { code: 1, output: "not logged in" } },
  { backend: "codex", env: "CODEX_HOME", login: "codex login", ok: { code: 0, output: "Logged in" }, bad: { code: 1, output: "Not logged in" } },
] as const;
type Backend = (typeof BACKENDS)[number];

/** instances: name → profile (null = the default login). `expired`: which logins the probe reports as bad. */
function rig(b: Backend, instances: Record<string, string | null>, expired: { profile?: string[]; defaultLogin?: boolean }) {
  const probes: Array<Record<string, string> | undefined> = [];
  setAuthCheckRunnerForTests(async (_argv, _ms, env) => {
    probes.push(env);
    const dir = env?.[b.env];
    const bad = dir === undefined ? !!expired.defaultLogin
      : (expired.profile ?? []).some(p => dir === credentialProfileHome(agendHome, b.backend, p));
    return bad ? b.bad : b.ok;
  });
  const notifyInstanceTopic = vi.fn();
  const offerBackendLogin = vi.fn(async () => {});
  const ctx = {
    fleetConfig: {
      instances: Object.fromEntries(Object.entries(instances).map(([n, p]) =>
        [n, { backend: b.backend, ...(p ? { backend_options: { [b.backend]: { credential_profile: p } } } : {}) }])),
      defaults: {},
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: null,
    isPlannedRestart: () => false,
    notifyInstanceTopic, offerBackendLogin,
    webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {},
    restartSingleInstance: async () => {},
    getInstanceDir: (n: string) => `/nonexistent/${n}`,
    // The real resolution, over this ctx's fleetConfig (every name is a fleet.yaml instance here).
    credentialProfileOf: (FleetManager.prototype as any).credentialProfileOf,
  } as unknown as LifecycleContext;
  const lc = new InstanceLifecycle(ctx);
  const daemons = Object.fromEntries(Object.keys(instances).map(name => {
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), clearSuspectedAuthFailure: vi.fn(() => true) });
    lc.attachIncidentHandlers(name, daemon as any);
    lc.daemons.set(name, daemon as any);
    return [name, daemon];
  }));
  const authError = (name: string) => daemons[name]!.emit("pty_error", { name, type: "auth_error", action: "pause", message: "401 Unauthorized" });
  return { lc, daemons, probes, notifyInstanceTopic, offerBackendLogin, authError };
}

describe.each(BACKENDS)("#1699 follow-up — $backend: an instance on a profile is judged by its own login", b => {
  it("the profile's token expired while the default login is fine: the alert fires, for that profile, with its own sign-in", async () => {
    const r = rig(b, { w1: "work", w2: "work", plain: null }, { profile: ["work"] });
    r.authError("w1");
    await vi.waitFor(() => expect(r.notifyInstanceTopic).toHaveBeenCalledTimes(1));
    const home = credentialProfileHome(agendHome, b.backend, "work");
    expect(r.probes).toEqual([{ [b.env]: home }]);
    const text = String(r.notifyInstanceTopic.mock.calls[0][1]);
    expect(text).toContain(`2 instances on \`${b.backend}\` profile \`work\`: w1, w2`);
    expect(text).not.toContain("plain");
    await vi.waitFor(() => expect(r.daemons.w1!.requestPauseWhenIdle).toHaveBeenCalled());
    expect(r.daemons.w1!.clearSuspectedAuthFailure).not.toHaveBeenCalled();
    await new Promise(res => setTimeout(res, 20));
    if (b.backend === "claude-code") {
      // #1699 part 2: a claude-code profile signs in from chat — the remedy names it, the button carries it.
      expect(text).toContain(`Use \`/login claude-code work\` to sign that profile in remotely (or run \`${b.env}=${JSON.stringify(home)} ${b.login}\` on the host)`);
      expect(r.offerBackendLogin).toHaveBeenCalledWith("w1", "claude-code", "work");
    } else {
      expect(text).toContain(`Run \`${b.env}=${JSON.stringify(home)} ${b.login}\` on the host`);
      expect(text).not.toContain(`/login ${b.backend}`);
      expect(r.offerBackendLogin, "the plain /login button signs the DEFAULT login in").not.toHaveBeenCalled();
    }
  });

  it("the reverse: the default login expired while the profile's is fine — the profile's instance is cleared, the default one alerted", async () => {
    const r = rig(b, { w1: "work", plain: null }, { defaultLogin: true });
    r.authError("w1");
    await vi.waitFor(() => expect(r.daemons.w1!.clearSuspectedAuthFailure).toHaveBeenCalled());
    expect(r.notifyInstanceTopic).not.toHaveBeenCalled();
    r.authError("plain");
    await vi.waitFor(() => expect(r.notifyInstanceTopic).toHaveBeenCalledTimes(1));
    const text = String(r.notifyInstanceTopic.mock.calls[0][1]);
    expect(text).toContain(`\`plain\` (${b.backend})`);
    expect(text).toContain(`/login ${b.backend}`);
    expect(text).toContain("Credentials are shared per backend");
    await vi.waitFor(() => expect(r.offerBackendLogin).toHaveBeenCalledWith("plain", b.backend));
    expect(r.probes).toEqual([{ [b.env]: credentialProfileHome(agendHome, b.backend, "work") }, undefined]);
  });

  it("one alert per login: a second profile instance is suppressed, the default login and another profile still alert", async () => {
    const r = rig(b, { w1: "work", w2: "work", p1: "personal", plain: null }, { profile: ["work", "personal"], defaultLogin: true });
    r.authError("w1");
    await vi.waitFor(() => expect(r.notifyInstanceTopic).toHaveBeenCalledTimes(1));
    r.authError("w2");
    await new Promise(res => setTimeout(res, 20));
    expect(r.notifyInstanceTopic, "same login, already alerted").toHaveBeenCalledTimes(1);
    r.authError("p1");
    await vi.waitFor(() => expect(r.notifyInstanceTopic).toHaveBeenCalledTimes(2));
    r.authError("plain");
    await vi.waitFor(() => expect(r.notifyInstanceTopic).toHaveBeenCalledTimes(3));
    expect(String(r.notifyInstanceTopic.mock.calls[1][1])).toContain("profile `personal`");
  });
});

describe("#1699 follow-up: the probe cache and the pre-flight are per login", () => {
  it("a profile and the default login are two probes; the same login joins one", async () => {
    const r = rig(BACKENDS[0], {}, {});
    await Promise.all([r.lc.verifyBackendAuth("claude-code", "work"), r.lc.verifyBackendAuth("claude-code", "work"), r.lc.verifyBackendAuth("claude-code")]);
    expect(r.probes).toEqual([{ CLAUDE_CONFIG_DIR: credentialProfileHome(agendHome, "claude-code", "work") }, undefined]);
  });

  it("the pre-flight probes each distinct login once, each with its own environment", async () => {
    const r = rig(BACKENDS[0], {}, {});
    r.lc.primeAuthVerification([
      { backend: "claude-code", profile: null }, { backend: "claude-code", profile: "work" },
      { backend: "claude-code", profile: "work" }, { backend: "claude-code", profile: null },
    ]);
    await vi.waitFor(() => expect(r.probes).toHaveLength(2));
    expect(r.probes).toContainEqual({ CLAUDE_CONFIG_DIR: credentialProfileHome(agendHome, "claude-code", "work") });
    expect(r.probes).toContainEqual(undefined);
  });
});

describe("#1699 follow-up: the real probe process gets the profile's variable ON TOP of the fleet's environment", () => {
  it("valid only with the variable — and the fleet's own environment still reaches the CLI (HOME, PATH, its login)", async () => {
    process.env.AGEND_PROBE_INHERIT_1699 = "kept";
    try {
      const check = { argv: ["sh", "-c", 'printf %s "$AGEND_PROBE_1699:$AGEND_PROBE_INHERIT_1699"'], validPattern: /^\/profile\/home:kept$/ };
      expect(await checkAuthStatus(check, { AGEND_PROBE_1699: "/profile/home" })).toBe("valid");
      expect(await checkAuthStatus(check)).toBe("invalid");
    } finally { delete process.env.AGEND_PROBE_INHERIT_1699; }
  });
});

describe("#1699 follow-up: FleetManager.credentialProfileOf", () => {
  const fm = (extra: Record<string, unknown> = {}) => Object.assign(Object.create(FleetManager.prototype), {
    lifecycle: { daemons: new Map() },
    fleetConfig: { defaults: {}, instances: {
      k: { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "work" } } },
      o: { backend: "opencode", backend_options: { opencode: { credential_profile: "work" } } },
    } },
    ...extra,
  });

  it("fleet.yaml: the instance's own profile on that backend; none for a backend without profiles", () => {
    const f = fm();
    expect(f.credentialProfileOf("k", "kiro-cli")).toBe("work");
    expect(f.credentialProfileOf("k", "codex")).toBeNull();
    expect(f.credentialProfileOf("o", "opencode"), "the option is ignored there").toBeNull();
  });

  it("a ClassicBot room: only when it runs that backend — launched (running) or configured (stopped)", () => {
    const f = fm({
      classicChannels: {
        getBackendByInstance: (n: string) => (n === "room-codex" ? "codex" : "claude-code"),
        getCredentialProfileByInstance: (n: string) => ({ state: "profile", name: `${n}-configured` }),
      },
    });
    f.lifecycle.daemons.set("room-running", { getConfigSnapshot: () => ({ backend: "codex", backend_options: { codex: { credential_profile: "launched" } } }) });
    expect(f.credentialProfileOf("room-running", "codex")).toBe("launched");
    expect(f.credentialProfileOf("room-running", "claude-code"), "launched on another backend").toBeNull();
    expect(f.credentialProfileOf("room-codex", "codex")).toBe("room-codex-configured");
    expect(f.credentialProfileOf("room-codex", "claude-code"), "a codex room's profile is not claude's").toBeNull();
    // Nor its claude config dir: a codex room's claude side is the fleet's own — exactly claudeConfigDirFor(null),
    // whether the fleet runs on the shared login or (CLAUDE_CONFIG_DIR set) on a profile of its own.
    expect(f.claudeConfigDirOf("room-codex"), "nor its claude config dir").toBe(claudeConfigDirFor(null));
    expect(f.claudeConfigDirOf("room-codex")).not.toContain("room-codex-configured");
    process.env.CLAUDE_CONFIG_DIR = join(agendHome, "credential-profiles", "claude-code", "fleet-own");
    expect(f.claudeConfigDirOf("room-codex"), "the fleet's own profile, not the room's").toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(f.claudeConfigDirOf("room-claude"), "a claude room's configured profile").toBe(credentialProfileHome(agendHome, "claude-code", "room-claude-configured"));
  });
});
