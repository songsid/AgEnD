import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { ClassicChannelManager, inferClassicChannelType } from "../src/classic-channel-manager.js";

describe("Classic channel adapter migration", () => {
  let dataDir: string;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dataDir = join(tmpdir(), `agend-classic-migration-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(dataDir, { recursive: true });
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeClassic(channels: Record<string, Record<string, unknown>>): void {
    writeFileSync(join(dataDir, "classicBot.yaml"), yaml.dump({ channels }), "utf8");
  }

  function readClassic(): any {
    return yaml.load(readFileSync(join(dataDir, "classicBot.yaml"), "utf8"));
  }

  it("distinguishes Telegram groups/private chats from Discord snowflakes", () => {
    expect(inferClassicChannelType("-5099690129")).toBe("telegram");
    expect(inferClassicChannelType("951494522")).toBe("telegram");
    expect(inferClassicChannelType("1496890283571413043")).toBe("discord");
    expect(inferClassicChannelType("custom-room")).toBeUndefined();
  });

  it("migrates a legacy Telegram row to Telegram even when Discord is primary", () => {
    writeClassic({
      "-5099690129": {
        name: "HanHanv",
        createdBy: "owner",
        createdAt: "2026-06-18T08:03:35.720Z",
      },
    });

    const manager = new ClassicChannelManager(dataDir, logger as any);
    manager.configureAdapters([
      { id: "discord", type: "discord" },
      { id: "telegram", type: "telegram" },
    ]);

    expect(manager.getInstanceByChannel("-5099690129", "telegram")).toBe("classic-hanhanv-0129");
    expect(manager.getInstanceByChannel("-5099690129", "discord")).toBeUndefined();
    const persisted = readClassic();
    expect(persisted.channels["-5099690129#telegram"]).toMatchObject({
      adapterId: "telegram",
      instanceName: "classic-hanhanv-0129",
    });
    expect(existsSync(join(dataDir, "classicBot.yaml.pre-adapter-repair.bak"))).toBe(true);
  });

  it("migrates a legacy Discord row to Discord even when Telegram is primary", () => {
    writeClassic({
      "1496890283571413043": {
        name: "codex",
        createdBy: "owner",
        createdAt: "2026-06-25T04:36:41.059Z",
      },
    });

    const manager = new ClassicChannelManager(dataDir, logger as any);
    manager.configureAdapters([
      { id: "telegram", type: "telegram" },
      { id: "discord-secondary", type: "discord" },
    ]);

    expect(manager.getInstanceByChannel("1496890283571413043", "discord-secondary"))
      .toBe("classic-codex-3043");
    expect(manager.getInstanceByChannel("1496890283571413043", "telegram")).toBeUndefined();
  });

  it("repairs a cross-platform binding in place when no correct row exists", () => {
    writeClassic({
      "-5099690129#discord": {
        channelId: "-5099690129",
        adapterId: "discord",
        instanceName: "classic-hanhanv-0129",
        name: "HanHanv",
        createdBy: "owner",
        createdAt: "2026-06-18T08:03:35.720Z",
      },
    });

    const manager = new ClassicChannelManager(dataDir, logger as any);
    manager.configureAdapters([
      { id: "discord", type: "discord" },
      { id: "telegram", type: "telegram" },
    ]);

    expect(manager.getInstanceByChannel("-5099690129", "telegram")).toBe("classic-hanhanv-0129");
    expect(readClassic().channels["-5099690129#telegram"]).toMatchObject({
      adapterId: "telegram",
      instanceName: "classic-hanhanv-0129",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fromAdapterId: "discord", toAdapterId: "telegram" }),
      "Repaired cross-platform Classic channel adapter binding",
    );
  });

  it("keeps the correctly bound live row and removes a phantom duplicate without deleting instance data", () => {
    const staleInstanceDir = join(dataDir, "instances", "classic-hanhanv-0129");
    mkdirSync(staleInstanceDir, { recursive: true });
    writeFileSync(join(staleInstanceDir, "session-id"), "keep-me", "utf8");
    writeClassic({
      "-5099690129#discord": {
        channelId: "-5099690129",
        adapterId: "discord",
        instanceName: "classic-hanhanv-0129",
        name: "HanHanv",
        createdBy: "owner",
        createdAt: "2026-06-18T08:03:35.720Z",
      },
      "-5099690129#telegram": {
        channelId: "-5099690129",
        adapterId: "telegram",
        instanceName: "classic-hanhanv-0129-telegram",
        name: "HanHanv",
        createdBy: "owner",
        createdAt: "2026-07-06T07:59:29.902Z",
      },
    });

    const manager = new ClassicChannelManager(dataDir, logger as any);
    manager.configureAdapters([
      { id: "discord", type: "discord" },
      { id: "telegram", type: "telegram" },
    ]);

    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getInstanceByChannel("-5099690129", "telegram"))
      .toBe("classic-hanhanv-0129-telegram");
    const persisted = readClassic();
    expect(persisted.channels["-5099690129#discord"]).toBeUndefined();
    expect(persisted.channels["-5099690129#telegram"]).toBeDefined();
    expect(readFileSync(join(staleInstanceDir, "session-id"), "utf8")).toBe("keep-me");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ staleInstanceName: "classic-hanhanv-0129" }),
      "Removed phantom Classic channel registration; instance data retained on disk",
    );
  });

  it("chooses the first matching-platform adapter and never moves explicit correct rows when primary order changes", () => {
    writeClassic({
      "1496890283571413043": { name: "legacy", createdBy: "owner", createdAt: "" },
    });
    const manager = new ClassicChannelManager(dataDir, logger as any);
    manager.configureAdapters([
      { id: "telegram", type: "telegram" },
      { id: "discord-a", type: "discord" },
      { id: "discord-b", type: "discord" },
    ]);
    expect(manager.getInstanceByChannel("1496890283571413043", "discord-a"))
      .toBe("classic-legacy-3043");

    const reloaded = new ClassicChannelManager(dataDir, logger as any);
    reloaded.configureAdapters([
      { id: "discord-b", type: "discord" },
      { id: "telegram", type: "telegram" },
      { id: "discord-a", type: "discord" },
    ]);
    expect(reloaded.getInstanceByChannel("1496890283571413043", "discord-a"))
      .toBe("classic-legacy-3043");
    expect(reloaded.getInstanceByChannel("1496890283571413043", "discord-b")).toBeUndefined();
  });
});
