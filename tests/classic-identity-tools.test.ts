import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agend-classic-identity-"));
  dirs.push(dir);
  const fleetPath = join(dir, "fleet.yaml");
  writeFileSync(fleetPath, "defaults:\n  backend: kiro-cli\ninstances: {}\n");

  const fm = new FleetManager(dir);
  fm.loadConfig(fleetPath);
  const classic = new ClassicChannelManager(dir, (fm as any).logger);
  classic.setPrimaryAdapterId("telegram");
  classic.register("12345", "telegram", "classic-room-2345", "Room", "owner", "kiro-cli");
  (fm as any).classicChannels = classic;
  const send = vi.fn();
  (fm as any).instanceIpcClients.set("classic-room-2345", { send });
  return { dir, fm, classic, send };
}

describe("Classic identity tools", () => {
  it("answers set_display_name and persists it to classicBot.yaml", () => {
    const { dir, fm, send } = setup();

    (fm as any).handleSetDisplayName("classic-room-2345", {
      fleetRequestId: "dn_1",
      payload: { name: "Nova" },
    });

    expect(send).toHaveBeenCalledWith({
      type: "fleet_display_name_response",
      fleetRequestId: "dn_1",
      result: { display_name: "Nova" },
    });
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf8")) as any;
    expect(saved.channels["12345#telegram"].display_name).toBe("Nova");
    expect(fm.resolveDisplayName("classic-room-2345")).toBe("Nova");

    const reloaded = new ClassicChannelManager(dir, (fm as any).logger);
    reloaded.setPrimaryAdapterId("telegram");
    expect(reloaded.getAll().find(ch => ch.instanceName === "classic-room-2345")?.displayName).toBe("Nova");
  });

  it("persists set_description through the same Classic path", () => {
    const { dir, fm, send } = setup();

    (fm as any).handleSetDescription("classic-room-2345", {
      fleetRequestId: "desc_1",
      payload: { description: "Helps the Room" },
    });

    expect(send).toHaveBeenCalledWith({
      type: "fleet_description_response",
      fleetRequestId: "desc_1",
      result: { description: "Helps the Room" },
    });
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf8")) as any;
    expect(saved.channels["12345#telegram"].description).toBe("Helps the Room");
  });

  it("supports the CLI/HTTP tool path used by Classic CLI-mode backends", async () => {
    const { fm, classic } = setup();

    await expect(fm.handleSetDisplayNameHttp("classic-room-2345", "Orbit"))
      .resolves.toEqual({ display_name: "Orbit" });
    await expect(fm.handleSetDescriptionHttp("classic-room-2345", "Classic helper"))
      .resolves.toEqual({ description: "Classic helper" });
    const row = classic.getAll().find(ch => ch.instanceName === "classic-room-2345");
    expect(row).toMatchObject({ displayName: "Orbit", description: "Classic helper" });
  });

  it("injects persisted Classic identity on the next startup", async () => {
    const { fm, classic } = setup();
    classic.setDisplayNameByInstance("classic-room-2345", "Nova");
    classic.setDescriptionByInstance("classic-room-2345", "Helps the Room");
    const startInstance = vi.spyOn(fm as any, "startInstance").mockResolvedValue(undefined);

    await (fm as any).startClassicInstance("classic-room-2345", "kiro-cli");

    expect(startInstance).toHaveBeenCalledWith(
      "classic-room-2345",
      expect.objectContaining({ display_name: "Nova", description: "Helps the Room" }),
      expect.any(Boolean),
      "classic",
    );
  });

  it("returns an explicit error for an unknown instance instead of timing out", () => {
    const { fm, send } = setup();
    (fm as any).instanceIpcClients.set("missing", { send });

    (fm as any).handleSetDisplayName("missing", {
      fleetRequestId: "dn_missing",
      payload: { name: "Ghost" },
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "fleet_display_name_response",
      fleetRequestId: "dn_missing",
      error: "Instance 'missing' not found",
    }));
  });
});
