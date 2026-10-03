/**
 * The fleet hands its label to every adapter it starts (#1131 follow-up), so
 * the Discord slash commands it registers name the fleet. Both start paths:
 * the primary adapter and each additional one.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../src/channel/factory.js", () => ({
  createAdapter: vi.fn(async (_config: unknown, opts: Record<string, unknown>) => {
    created.push(opts);
    throw new Error("stop after createAdapter");
  }),
}));

import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  created.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("adapters are created with the fleet's label", () => {
  it("primary and additional adapters both get fleet_label", async () => {
    const dir = join(tmpdir(), `agend-label-wiring-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    vi.stubEnv("TEST_BOT_TOKEN", "x");
    const fm = new FleetManager(dir);
    const fleet = { defaults: {}, instances: {}, fleet_label: "lab-box" } as any;
    fm.fleetConfig = fleet;
    const channel = { id: "discord", type: "discord", bot_token_env: "TEST_BOT_TOKEN", group_id: "g" } as any;
    await expect((fm as any).startSingleAdapter(fleet, channel)).rejects.toThrow("stop after createAdapter");
    await expect((fm as any).startAdditionalAdapter({ ...channel, id: "second" })).rejects.toThrow("stop after createAdapter");
    expect(created.map(o => o.fleetLabel)).toEqual(["lab-box", "lab-box"]);
  });
});
