import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { DEFAULT_REPLY_TRIGGERS } from "../src/reply-triggers.js";
import { validateClassicBotConfig } from "../src/config-validator.js";

const dirs: string[] = [];

function manager(config: unknown): ClassicChannelManager {
  const dir = mkdtempSync(join(tmpdir(), "agend-classic-behavior-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml.dump(config));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const result = new ClassicChannelManager(dir, logger);
  result.configureAdapters([{ id: "discord", type: "discord" }]);
  return result;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Classic behavior setting fallback", () => {
  it("reply triggers default off, inherit fleet/Classic defaults and retain an explicit room false on save/reload", () => {
    expect(DEFAULT_REPLY_TRIGGERS).toBe(false);
    expect(manager({}).getReplyTriggers("missing")).toBe(false);
    expect(manager({}).getReplyTriggers("missing", undefined, true)).toBe(true);
    expect(manager({ defaults: { reply_triggers: false } }).getReplyTriggers("missing", undefined, true)).toBe(false);
    const m = manager({ defaults: { reply_triggers: true }, channels: { "123#discord": {
      channelId: "123", adapterId: "discord", name: "room", instanceName: "classic-one", reply_triggers: false,
    } } });
    expect(m.getReplyTriggers("123", "discord", true)).toBe(false);
    m.toggleCollab("123", "discord");
    m.reloadFromDisk();
    expect(m.getReplyTriggersByInstance("classic-one", true)).toBe(false);
    expect((yaml.load(readFileSync(join(dirs.at(-1)!, "classicBot.yaml"), "utf8")) as any).channels["123#discord"].reply_triggers).toBe(false);
  });
  it("resolves channel → Classic defaults → fleet defaults with nullish boolean semantics", () => {
    const channels = {
      "123456789012345678#discord": {
        channelId: "123456789012345678",
        adapterId: "discord",
        instanceName: "classic-one",
        reply_completion_guard: false,
        tool_progress: "verbose",
      },
    };
    const configured = manager({
      defaults: { reply_completion_guard: true, tool_progress: "standard" },
      channels,
    });

    expect(configured.getReplyCompletionGuardByInstance("classic-one", true)).toBe(false);
    expect(configured.getToolProgressByInstance("classic-one", "off")).toBe("verbose");

    const classicOnly = manager({ defaults: { reply_completion_guard: false, tool_progress: "standard" }, channels: {} });
    expect(classicOnly.getReplyCompletionGuardByInstance("missing", true)).toBe(false);
    expect(classicOnly.getToolProgressByInstance("missing", "verbose")).toBe("standard");

    const fleetOnly = manager({ channels: {} });
    expect(fleetOnly.getReplyCompletionGuardByInstance("missing", false)).toBe(false);
    expect(fleetOnly.getToolProgressByInstance("missing", "verbose")).toBe("verbose");
  });

  it("validates both Classic defaults and channel overrides", () => {
    const result = validateClassicBotConfig({
      defaults: { reply_triggers: "yes", tool_progress: "chatty", reply_completion_guard: "yes" },
      channels: { one: { reply_triggers: 1, tool_progress: "sometimes", reply_completion_guard: 1 } },
    });
    expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      "defaults.reply_triggers",
      "channels.one.reply_triggers",
      "defaults.tool_progress",
      "defaults.reply_completion_guard",
      "channels.one.tool_progress",
      "channels.one.reply_completion_guard",
    ]));
  });
});
