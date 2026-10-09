/**
 * #1519 P6 (docs/design/ux-onboarding-walkthrough.md §5.2 "Activation without a restart"): a connection appended to a
 * running fleet starts on Apply — no restart — when nothing else at startup level changed and the first connection is
 * untouched; a token stored for a stopped, non-primary connection starts it. Everything else still asks for a restart.
 * Real FleetManager (planner, reconcile, secret rebuild) on a scratch dir with `instances: {}`; adapter starts are fakes,
 * instance starts throw — nothing is launched.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendedConnections } from "../src/fleet-level-config.js";
import { FleetManager } from "../src/fleet-manager.js";
import { APPLY_FLEET_TARGET } from "../src/apply-job.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.AGEND_TEST_P6_TOKEN; delete process.env.AGEND_TEST_P6_PRIMARY; });

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
  it("the primary, or a fleet with no running connection: still the next start (false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-p6-")); dirs.push(dir);
    const { fm } = fleet(dir, [primary, second]);
    fm.adapters.delete("primary");
    expect(await fm.rebuildAdapterForSecret("primary", primary)).toBe(false);
    expect(await fm.rebuildAdapterForSecret("discord-2", second), "no connection running").toBe(false);
    expect(fm.startAdditionalAdapter).not.toHaveBeenCalled();
  });
});
