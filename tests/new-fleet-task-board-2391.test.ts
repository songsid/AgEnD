/**
 * The user's decision (2026-10-22, on #2391): the task board is off by default for a NEW fleet. Every path that creates
 * a fleet.yaml writes `defaults.dashboard.task_board: false`, visibly — `agend init` (setup-wizard), `agend quickstart`
 * (a new fleet, or a fresh start), and the setup page (`agend setup` / the web quickstart before there is a fleet).
 * An existing fleet.yaml is never rewritten: there, unset still allows.
 *
 * The setup page through the real SetupHost on a scratch directory (no fleet started: spawnFleet is a spy).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFleetConfig, type WizardAnswers } from "../src/setup-wizard.js";
import { newQuickstartFleet } from "../src/quickstart.js";
import { SetupHost } from "../src/setup-host.js";
import { dashboardFeaturesOffIn, NEW_FLEET_DASHBOARD } from "../src/dashboard-permissions.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { setupHttp, decideSetup } from "./helpers/setup-confirmation-1423.js";

const fixtures: { host: SetupHost; dir: string }[] = [];
afterEach(async () => { for (const { host, dir } of fixtures.splice(0)) { await host.shutdown(false, "test cleanup"); rmSync(dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
/** What a fleet.yaml, as written, says the task board is for an agent of it: off, or allowed. */
const board = (fleet: unknown, agent = "agent-1") => (dashboardFeaturesOffIn(fleet, agent).includes("task_board") ? "off" : "allowed");

describe("a new fleet.yaml says the task board is off", () => {
  it("the one value every path writes: task_board false, and nothing else switched", () => {
    expect([NEW_FLEET_DASHBOARD, Object.isFrozen(NEW_FLEET_DASHBOARD)]).toEqual([{ task_board: false }, true]);
  });
  it("agend init (setup-wizard's buildFleetConfig): in defaults, valid, and in effect for its agents", () => {
    const answers: WizardAnswers = { channelType: "telegram", backend: "claude-code", botTokenEnv: "AGEND_BOT_TOKEN", groupId: -1001234567890,
      channelMode: "topic", accessMode: "locked", allowedUsers: [], projectRoots: [], instances: [], costGuard: { enabled: false }, dailySummary: { enabled: false } };
    const written = yaml.load(yaml.dump(buildFleetConfig(answers))) as Record<string, any>;
    expect([written.defaults.dashboard, validateFleetConfig(written as never).valid, board(written)]).toEqual([{ task_board: false }, true, "off"]);
    expect([written.web.notify_login, written.defaults.tips ?? true]).toEqual(["dm", true]);
  });
  it("agend quickstart (a new fleet, or a fresh start): in defaults beside the backend, one connection or several", () => {
    const telegram = { type: "telegram", token: "t", tokenEnvName: "TG", botUsername: "b", groupId: "-100", userId: "1" };
    const discord = { type: "discord", token: "d", tokenEnvName: "DC", botUsername: "c", groupId: "200", userId: "123456789012345678" };
    for (const platforms of [[telegram], [telegram, discord]]) {
      const written = yaml.load(yaml.dump(newQuickstartFleet(platforms as never, [], "codex"))) as Record<string, any>;
      expect([written.defaults, board(written)]).toEqual([{ backend: "codex", dashboard: { task_board: false } }, "off"]);
      expect([written.web.notify_login, written.defaults.tips ?? true]).toEqual(["dm", true]);
    }
  });
});

describe("the setup page (agend setup, the web quickstart before a fleet)", () => {
  async function harness(existing?: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-test-new-fleet-board-")), spawnFleet = vi.fn();
    if (existing !== undefined) writeFileSync(join(dir, "fleet.yaml"), existing);
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: () => {} });
    fixtures.push({ host, dir });
    const { port, path, code } = await host.start();
    const signed = await setupHttp(port, path + "open", "POST", { code });
    const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
    const commit = async () => {
      const pending = await setupHttp(port, path + "api/settings/quickstart/commit", "POST",
        { web_only: true, backend: "claude-code", working_directory: "/home/demo/project", instance_name: "agent-1" }, cookie);
      expect(pending.status, JSON.stringify(pending.body)).toBe(202);
      expect((await decideSetup(dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
      return yaml.load(readFileSync(join(dir, "fleet.yaml"), "utf8")) as Record<string, any>;
    };
    return { dir, commit };
  }
  it("no fleet.yaml yet: the file it writes has the board off, in defaults, for the new agent", async () => {
    const h = await harness();
    expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
    const written = await h.commit();
    expect([written.defaults?.dashboard, board(written), validateFleetConfig(written as never).valid]).toEqual([{ task_board: false }, "off", true]);
    expect([written.web.notify_login, written.defaults.tips ?? true]).toEqual(["dm", true]);
  });
  it("control — a fleet.yaml already there is never given the switch: its board stays allowed", async () => {
    const h = await harness("defaults:\n  backend: claude-code\ninstances: {}\n");
    const written = await h.commit();
    expect([written.defaults?.dashboard, board(written)]).toEqual([undefined, "allowed"]);
    expect([written.web?.notify_login, written.defaults.tips]).toEqual([undefined, undefined]);
  });
});
