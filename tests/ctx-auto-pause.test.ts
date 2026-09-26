import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicCommands } from "../src/topic-commands.js";
import { setLocale } from "../src/locale.js";

/**
 * /ctx shows auto_pause_after setting and current pause state (#951).
 *
 * Effective auto-pause resolution:
 *   fleet-topic:   instance override → fleet defaults → 0 (disabled)
 *   classic:       classicChannels.getAutoPauseAfterByInstance → fleet defaults → 0
 */

let dataDir: string;
const inst = "worker";

beforeEach(() => {
  setLocale("en");
  dataDir = mkdtempSync(join(tmpdir(), "ctx-auto-pause-"));
  mkdirSync(join(dataDir, "instances", inst), { recursive: true });
  // Provide a statusline so context is available
  writeFileSync(
    join(dataDir, "instances", inst, "statusline.json"),
    JSON.stringify({ context_window: { used_percentage: 30 } }),
  );
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  setLocale("en");
});

function commandsFor(opts: {
  instanceAutoPause?: number;
  defaultAutoPause?: number;
  instanceStatus?: "running" | "paused" | "stopped" | "crashed";
  classicAutoPause?: number | null; // null = not classic
}) {
  const isClassic = opts.classicAutoPause !== undefined && opts.classicAutoPause !== null;
  const fleetDefault = opts.defaultAutoPause;
  return new TopicCommands({
    dataDir,
    fleetConfig: {
      defaults: fleetDefault !== undefined ? { auto_pause_after: fleetDefault } : {},
      instances: {
        [inst]: {
          backend: "claude-code",
          ...(opts.instanceAutoPause !== undefined
            ? { auto_pause_after: opts.instanceAutoPause }
            : {}),
        },
      },
    },
    modelDisplayForInstance: () => null,
    effortStrategyFor: () => "unsupported" as const,
    resolveInstanceEffort: () => ({ effort: null, source: "unset" as const }),
    getInstanceStatus: () => (opts.instanceStatus ?? "running") as "running" | "paused" | "stopped" | "crashed",
    classicChannels: isClassic
      ? ({
          getChannelIdByInstance: (name: string) => name === inst ? "ch-1" : null,
          getAutoPauseAfterByInstance: (_name: string, _default?: number) =>
            opts.classicAutoPause ?? _default ?? 0,
          getBackendByInstance: () => "claude-code",
        } as any)
      : null,
  } as any);
}

describe("/ctx auto-pause line (#951)", () => {
  it("shows Auto-pause: disabled when fleet-topic has no setting (default 0)", async () => {
    // Mutation guard: if this line is omitted from output, the test fails.
    const text = await commandsFor({}).getCtxText(inst);
    expect(text).toContain("Auto-pause: disabled");
  });

  it("General instance always shows disabled even when fleet default is non-zero", async () => {
    // Mutation guard: removing the General exemption in autoPauseLineFor would
    // cause a General instance with a fleet default to show "Auto-pause: 30m".
    // The daemon always forces auto_pause = 0 for General (daemon.ts:1433-1435).
    const general = new TopicCommands({
      dataDir,
      fleetConfig: {
        defaults: { auto_pause_after: 30 },
        instances: { general: { backend: "claude-code", general_topic: true } },
      },
      modelDisplayForInstance: () => null,
      effortStrategyFor: () => "unsupported" as const,
      resolveInstanceEffort: () => ({ effort: null, source: "unset" as const }),
      getInstanceStatus: () => "running" as const,
      classicChannels: null,
    } as any);
    // Need statusline for general instance too
    mkdirSync(join(dataDir, "instances", "general"), { recursive: true });
    writeFileSync(join(dataDir, "instances", "general", "statusline.json"),
      JSON.stringify({ context_window: { used_percentage: 10 } }));
    const text = await general.getCtxText("general");
    expect(text).toContain("Auto-pause: disabled");
    expect(text).not.toContain("30m");
  });

  it("shows Auto-pause: 30m for fleet-topic instance override", async () => {
    // Mutation guard: if effective auto-pause is wrong (e.g., ignores instance
    // override and uses default 0), the output would say "disabled" → fails.
    const text = await commandsFor({ instanceAutoPause: 30 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: 30m");
    expect(text).not.toContain("disabled");
  });

  it("falls back to fleet default when instance has no override", async () => {
    // Mutation guard: if instance override mistakenly wins over the absent
    // value (e.g., undefined treated as 0 instead of fallthrough), this fails.
    const text = await commandsFor({ defaultAutoPause: 60 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: 60m");
  });

  it("instance override wins over fleet default", async () => {
    const text = await commandsFor({ instanceAutoPause: 15, defaultAutoPause: 60 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: 15m");
    expect(text).not.toContain("60m");
  });

  it("shows disabled when instance override is 0 (disabled)", async () => {
    const text = await commandsFor({ instanceAutoPause: 0, defaultAutoPause: 60 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: disabled");
  });

  it("classic instance uses classicChannels.getAutoPauseAfterByInstance", async () => {
    // Mutation guard: if the classic path is ignored (e.g., always reads from
    // fleetConfig.instances), a non-zero classic value would not appear.
    const text = await commandsFor({ classicAutoPause: 45 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: 45m");
  });

  it("classic instance shows disabled when classicChannels returns 0", async () => {
    const text = await commandsFor({ classicAutoPause: 0 }).getCtxText(inst);
    expect(text).toContain("Auto-pause: disabled");
  });

  it("zh-TW locale shows localised auto-pause text", async () => {
    setLocale("zh-TW");
    const text = await commandsFor({ instanceAutoPause: 30 }).getCtxText(inst);
    expect(text).toContain("Auto-pause：30m");
  });
});

describe("/ctx pause state (#951)", () => {
  it("shows paused line when instance is paused", async () => {
    const text = await commandsFor({ instanceStatus: "paused" }).getCtxText(inst);
    expect(text).toContain("⏸ Paused");
  });

  it("does not show paused when instance is running", async () => {
    const text = await commandsFor({ instanceStatus: "running" }).getCtxText(inst);
    expect(text).not.toContain("⏸");
  });

  it("does not show paused when instance is stopped", async () => {
    const text = await commandsFor({ instanceStatus: "stopped" }).getCtxText(inst);
    expect(text).not.toContain("⏸");
  });
});
