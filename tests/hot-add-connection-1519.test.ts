/**
 * #1519 P6 (docs/design/ux-onboarding-walkthrough.md §5.2 "Activation without a restart"): a connection appended to a
 * running fleet starts on Apply — no restart — when nothing else at startup level changed and the first connection is
 * untouched; a token stored for a stopped, non-primary connection starts it. Everything else still asks for a restart.
 * Real FleetManager (planner, reconcile, secret rebuild) on a scratch dir with `instances: {}`; adapter starts are fakes,
 * instance starts throw — nothing is launched.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendedConnections } from "../src/fleet-level-config.js";
import { FleetManager } from "../src/fleet-manager.js";
import { APPLY_FLEET_TARGET } from "../src/apply-job.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.AGEND_TEST_P6_TOKEN; delete process.env.AGEND_TEST_P6_PRIMARY; vi.useRealTimers(); });

const primary = { id: "primary", type: "discord", mode: "topic", bot_token_env: "AGEND_TEST_P6_PRIMARY", group_id: "1", access: { mode: "locked", allowed_users: ["9"] } };
const second = { id: "discord-2", type: "discord", mode: "topic", bot_token_env: "AGEND_TEST_P6_TOKEN", group_id: "1", access: { mode: "locked", allowed_users: [] } };
const yaml = (channels: unknown[], extra = "") => `${extra}instances: {}\nchannels:\n${channels.map(c => `  - ${JSON.stringify(c)}`).join("\n")}\n`;

describe("appendedConnections", () => {
  const cfg = (channels: unknown[], defaults: Record<string, unknown> = {}) => ({ defaults, instances: {}, channels }) as never;
  it("only connections appended after the ones it started with, unchanged and in order", () => {
    expect(appendedConnections(cfg([primary]), cfg([primary, second]))).toEqual([second]);
    expect(appendedConnections({ defaults: {}, instances: {}, channel: primary } as never, cfg([primary, second])), "a legacy `channel:` fleet").toEqual([second]);
    // A runtime-read option of an existing connection (status emojis) is not a change of it.
    expect(appendedConnections(cfg([primary]), cfg([{ ...primary, options: { status_emojis: { received: "👀" } } }, second]))).toEqual([second]);
  });
  it.each([
    ["the first changed", [primary], [{ ...primary, group_id: "2" }, second]],
    ["one removed", [primary, second], [primary]],
    ["reordered", [primary, second], [second, primary]],
    ["nothing added", [primary], [primary]],
    ["a web-only fleet's first connection", [], [primary]],
    ["an added id already there", [primary], [primary, { ...second, id: "primary" }]],
  ])("%s: null", (_name, before, after) => {
    expect(appendedConnections(cfg(before), cfg(after))).toBeNull();
  });
  it("another startup-only key changed with it: null", () => {
    expect(appendedConnections(cfg([primary], { locale: "en" }), cfg([primary, second], { locale: "zh-TW" }))).toBeNull();
  });
});

function fleet(dir: string, channels: unknown[]) {
  const configPath = join(dir, "fleet.yaml");
  writeFileSync(configPath, yaml(channels));
  const fm = new FleetManager(dir) as any;
  fm.loadConfig(configPath);
  fm.startupComplete = true;
  fm.finishStartup();
  fm.startInstance = vi.fn(async () => { throw new Error("no instance may start in this test"); });
  fm.stopInstance = vi.fn(async () => { throw new Error("no instance may stop in this test"); });
  const fake = () => Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}), start: vi.fn(async () => {}) });
  fm.adapters.set("primary", fake());
  fm.startAdditionalAdapter = vi.fn(async (channel: { id: string; bot_token_env: string }) => {
    if (!process.env[channel.bot_token_env]) return;                     // what the real one does with no token
    fm.adapters.set(channel.id, fake());
  });
  return { fm, configPath };
}

describe("Apply: an appended connection starts without a restart", () => {
  it("the planner says hot; reconcile loads the token from .env, starts it, and the configuration counts as applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm, configPath } = fleet(dir, [primary]);
    writeFileSync(join(dir, ".env"), "AGEND_TEST_P6_TOKEN=fake-second-token\n");
    writeFileSync(configPath, yaml([primary, second]));
    fm.loadConfig(configPath);
    expect(fm.planConfigApply()).toEqual([{ target: APPLY_FLEET_TARGET, kind: "hot" }]);
    const observed: string[] = [];
    await fm.reconcileInstances((target: string, kind: string, status: string) => observed.push(`${target}:${kind}:${status}`));
    expect(observed.filter(o => o.startsWith(`${APPLY_FLEET_TARGET}:`))).toEqual([`${APPLY_FLEET_TARGET}:hot:running`, `${APPLY_FLEET_TARGET}:hot:done`]);
    expect([process.env.AGEND_TEST_P6_TOKEN, fm.adapters.has("discord-2"), fm.adapterState.get("discord-2")?.status]).toEqual(["fake-second-token", true, "connected"]);
    expect(fm.planConfigApply(), "applied: nothing pending").toEqual([]);
    expect(fm.startInstance).not.toHaveBeenCalled();
  });

  it("a connection that does not start (no token) leaves a restart pending, and nothing counts as applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm, configPath } = fleet(dir, [primary]);
    writeFileSync(configPath, yaml([primary, second]));
    fm.loadConfig(configPath);
    const observed: string[] = [];
    await fm.reconcileInstances((target: string, kind: string, status: string) => observed.push(`${target}:${kind}:${status}`));
    expect(observed.filter(o => o.startsWith(`${APPLY_FLEET_TARGET}:`)).at(-1)).toBe(`${APPLY_FLEET_TARGET}:restart:restart-required`);
    expect(fm.planConfigApply()).toEqual([{ target: APPLY_FLEET_TARGET, kind: "hot" }]);
  });

  it("anything else at fleet level, or a fleet with no running connection, still plans a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm, configPath } = fleet(dir, [primary]);
    writeFileSync(configPath, yaml([{ ...primary, group_id: "2" }, second]));
    fm.loadConfig(configPath);
    expect(fm.planConfigApply()).toEqual([{ target: APPLY_FLEET_TARGET, kind: "restart" }]);
    writeFileSync(configPath, yaml([primary, second]));
    fm.loadConfig(configPath);
    fm.adapters.clear();
    expect(fm.planConfigApply(), "no connection running").toEqual([{ target: APPLY_FLEET_TARGET, kind: "restart" }]);
  });

  it("one already running (a token Replace started it) is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm, configPath } = fleet(dir, [primary]);
    writeFileSync(configPath, yaml([primary, second]));
    fm.loadConfig(configPath);
    writeFileSync(join(dir, ".env"), "AGEND_TEST_P6_TOKEN=fake-second-token\n");   // startable — only "already running" stops it
    const running = Object.assign(new EventEmitter(), { stop: vi.fn() });
    fm.adapters.set("discord-2", running);
    await fm.reconcileInstances(() => {});
    expect([fm.startAdditionalAdapter.mock.calls.length, fm.adapters.get("discord-2") === running]).toEqual([0, true]);
  });
});

describe("a token stored for a stopped connection", () => {
  it("non-primary, in a fleet running connections: started now — not restart_required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm } = fleet(dir, [primary, second]);
    process.env.AGEND_TEST_P6_TOKEN = "fake-token";
    fm.startAdditionalAdapter = vi.fn(async (channel: { id: string }, _register: boolean, onStarted?: () => void) => {
      fm.adapters.set(channel.id, Object.assign(new EventEmitter(), { stop: vi.fn() })); onStarted?.();
    });
    expect(await fm.rebuildAdapterForSecret("discord-2", second)).toBe(true);
    expect(fm.adapters.has("discord-2")).toBe(true);
  });
  it("the primary, or a fleet with no running connection, added since AgEnD started: still the next start (false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm } = fleet(dir, [primary, second]);
    process.env.AGEND_TEST_P6_PRIMARY = "fake-primary";
    // S-91: one this process started with now starts (the describe below); one added since is set up by a fresh process.
    fm.startupFleetConfig = { ...fm.startupFleetConfig, channels: [] };
    // The primary stopped while another connection runs: still the next start (a fresh process sets the primary up).
    fm.adapters.delete("primary");
    fm.adapters.set("other", Object.assign(new EventEmitter(), { stop: vi.fn() }));
    fm.startSingleAdapter = vi.fn(async () => {});
    await expect(fm.rebuildAdapterForSecret("primary", primary)).resolves.toBe(false);
    expect(fm.startSingleAdapter).not.toHaveBeenCalled();
    fm.adapters.clear();
    expect(await fm.rebuildAdapterForSecret("discord-2", second), "no connection running").toBe(false);
    expect(fm.startAdditionalAdapter).not.toHaveBeenCalled();
  });
});

describe("S-91: a token stored for a connection this process started with starts it now (no restart)", () => {
  const stopped = (dir: string) => {
    const { fm } = fleet(dir, [primary, second]);
    fm.startupFleetConfig = structuredClone(fm.fleetConfig);             // what finishStartup records in a real start
    fm.adapters.clear();                                                   // its start failed (a revoked token): nothing runs
    const made: any[] = [];
    const register = (id: string, onStarted?: () => void) => { const a = Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}) }); made.push(a); fm.adapters.set(id, a); onStarted?.(); };
    fm.startSingleAdapter = vi.fn(async (_f: unknown, channel: { id: string }, onStarted?: () => void) => register(channel.id, onStarted));
    fm.startAdditionalAdapter = vi.fn(async (channel: { id: string }, _r: boolean, onStarted?: () => void) => register(channel.id, onStarted));
    return { fm, made };
  };
  it("the primary, nothing running: started now, the way the background retry starts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_PRIMARY = "fake-primary";
    expect(await fm.rebuildAdapterForSecret("primary", primary)).toBe(true);
    expect([fm.startSingleAdapter.mock.calls.length, fm.adapters.has("primary"), fm.adapterState.get("primary")?.status]).toEqual([1, true, "connected"]);
  });
  it("a non-primary in a fleet with nothing running: started now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_TOKEN = "fake-token";
    expect(await fm.rebuildAdapterForSecret("discord-2", second)).toBe(true);
    expect(fm.startAdditionalAdapter).toHaveBeenCalledTimes(1);
  });
  it("one changed since AgEnD started, or added since: still the next start (false), nothing started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_PRIMARY = "fake-primary";
    expect(await fm.rebuildAdapterForSecret("primary", { ...primary, group_id: "2" }), "changed").toBe(false);
    fm.startupFleetConfig = { ...fm.startupFleetConfig, channels: [primary] };
    process.env.AGEND_TEST_P6_TOKEN = "fake-token";
    expect(await fm.rebuildAdapterForSecret("discord-2", second), "added since").toBe(false);
    expect([fm.startSingleAdapter.mock.calls.length, fm.startAdditionalAdapter.mock.calls.length, fm.adapters.size]).toEqual([0, 0, 0]);
  });
  it("never two starts at once: a background retry in flight finishes first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_PRIMARY = "fake-primary";
    let finish!: () => void;
    fm.adapterRetryInFlight.set("primary", new Promise<void>((r) => { finish = r; }));
    const rebuilt = fm.rebuildAdapterForSecret("primary", primary);
    await new Promise((r) => setTimeout(r, 20));
    expect(fm.startSingleAdapter, "waits for the retry").not.toHaveBeenCalled();
    fm.adapterRetryInFlight.delete("primary"); finish();
    expect(await rebuilt).toBe(true);
    expect(fm.startSingleAdapter).toHaveBeenCalledTimes(1);
  });
  it.each([["no health snapshot (Telegram)", false], ["a health snapshot (Discord)", true]])("a retry timer set while it came up never starts it a second time: %s", async (_n, snapshot) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_PRIMARY = "fake-primary";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fm.startSingleAdapter = vi.fn(async (_f: unknown, channel: { id: string }, onStarted?: () => void) => {
        fm.scheduleAdapterRetry(channel.id);                             // the in-flight retry's own, giving way
        const a = Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}), ...(snapshot ? { getHealthSnapshot: () => ({ status: "connected" }) } : {}) });
        fm.adapters.set(channel.id, a); onStarted?.();
      });
      const retry = vi.spyOn(fm, "attemptAdapterRetry");
      expect(await fm.rebuildAdapterForSecret("primary", primary)).toBe(true);
      vi.advanceTimersByTime(10 * 60_000);
      expect(retry).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("its start fails: the token goes back, the adapter it left is taken down, and the connection is the background retry's again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm, made } = stopped(dir);
    writeFileSync(join(dir, ".env"), "AGEND_TEST_P6_PRIMARY=old-token\n");
    process.env.AGEND_TEST_P6_PRIMARY = "old-token";
    fm.startSingleAdapter = vi.fn(async (_f: unknown, channel: { id: string }) => {
      const a = Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}) }); made.push(a); fm.adapters.set(channel.id, a);   // registered, then…
      throw new Error("login failed");                                                                                               // …never came up
    });
    const scheduled = vi.spyOn(fm, "scheduleAdapterRetry").mockImplementation(() => {});
    const job: any = { id: "s91", connectionId: "primary", status: "running", result: "applying" };
    await fm.runConnectionSecretApply(job, "new-token");
    expect([job.status, job.result]).toEqual(["done", "rolled_back"]);
    expect([process.env.AGEND_TEST_P6_PRIMARY, readFileSync(join(dir, ".env"), "utf8").includes("old-token"), readFileSync(join(dir, ".env"), "utf8").includes("new-token")]).toEqual(["old-token", true, false]);
    expect([fm.adapters.has("primary"), made[0].stop.mock.calls.length, made[0].listenerCount("message")]).toEqual([false, 1, 0]);
    expect([fm.adapterState.get("primary")?.status, scheduled.mock.calls.at(-1)?.[0]]).toEqual(["retrying", "primary"]);
    expect(fm.startSingleAdapter, "never started again with the old token").toHaveBeenCalledTimes(1);
  });
  it("#3365 review P2: a non-primary changed since start, with a sibling running, waits for the restart; one added since still starts (#1519 P6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    fm.adapters.set("primary", Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}) }));   // the primary runs
    process.env.AGEND_TEST_P6_TOKEN = "fake-token";
    expect(await fm.rebuildAdapterForSecret("discord-2", { ...second, group_id: "2" }), "changed: its binding is pending").toBe(false);
    expect(fm.startAdditionalAdapter).not.toHaveBeenCalled();
    fm.startupFleetConfig = { ...fm.startupFleetConfig, channels: [primary] };
    expect(await fm.rebuildAdapterForSecret("discord-2", second), "added since: #1519 P6 starts it").toBe(true);
    expect(fm.startAdditionalAdapter).toHaveBeenCalledTimes(1);
  });
  it("#3365 review P2: a teardown that fails is said (rollback_failed), never retried, and no adapter is admitted for it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    writeFileSync(join(dir, ".env"), "AGEND_TEST_P6_PRIMARY=old-token\n");
    process.env.AGEND_TEST_P6_PRIMARY = "old-token";
    fm.startSingleAdapter = vi.fn(async (_f: unknown, channel: { id: string }) => {
      fm.adapters.set(channel.id, Object.assign(new EventEmitter(), { stop: vi.fn(async () => { throw new Error("stop failed"); }) }));
      throw new Error("login failed");
    });
    const scheduled = vi.spyOn(fm, "scheduleAdapterRetry");
    const job: any = { id: "s91-stop", connectionId: "primary", status: "running", result: "applying" };
    await fm.runConnectionSecretApply(job, "new-token");
    expect([job.status, job.result, fm.adapterState.get("primary")?.status, fm.adapterState.get("primary")?.retryTimer]).toEqual(["done", "rollback_failed", "failed", undefined]);
    expect(process.env.AGEND_TEST_P6_PRIMARY, "the token still goes back").toBe("old-token");
    fm.scheduleAdapterRetry("primary");
    expect(fm.adapterState.get("primary")?.retryTimer, "no retry rearmed").toBeUndefined();
    // Every start refuses it (the real admission, not the test's fake).
    await expect(fm.startSingleAdapterOwned(fm.fleetConfig, primary)).rejects.toThrow(/could not be confirmed stopped/);
    await expect(fm.startAdditionalAdapterOwned(primary)).rejects.toThrow(/could not be confirmed stopped/);
    expect(scheduled.mock.results.every((r: any) => r.value === undefined)).toBe(true);
  });
  it("#3365 review P3: a failed primary start retires the session-prune interval it set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-s91-")); dirs.push(dir);
    const { fm } = stopped(dir);
    process.env.AGEND_TEST_P6_PRIMARY = "old-token";
    vi.spyOn(fm, "scheduleAdapterRetry").mockImplementation(() => {});
    fm.startSingleAdapter = vi.fn(async (_f: unknown, channel: { id: string }) => {
      fm.sessionPruneTimer = setInterval(() => {}, 60_000);                // what a real primary start installs
      fm.adapters.set(channel.id, Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}) }));
      throw new Error("login failed");
    });
    const job: any = { id: "s91-prune", connectionId: "primary", status: "running", result: "applying" };
    await fm.runConnectionSecretApply(job, "new-token");
    expect([job.result, fm.sessionPruneTimer]).toEqual(["rolled_back", null]);
  });
});
