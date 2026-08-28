import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContextPercent,
  parseTokenContextRatio,
  readStatuslineContextPct,
  readStatuslineModel,
  resolveInstanceContext,
  TopicCommands,
} from "../src/topic-commands.js";

describe("context parsers for kiro / grok / codex", () => {
  it("kiro pie statusline → used %", () => {
    expect(parseContextPercent("kiro_default · auto · ◕ 63% · λ")).toBe(63);
  });

  it("codex Context N% left → inverted used %", () => {
    expect(parseContextPercent("  Context 33% left")).toBe(67);
  });

  it("grok token ratio → used %", () => {
    const ratio = parseTokenContextRatio("  67K / 500K │ 0/4 ✓");
    expect(ratio?.percentage).toBeCloseTo(13.4);
    expect(parseContextPercent("  67K / 500K │ 0/4 ✓")).toBeCloseTo(13.4);
  });

  it("ignores an impossible prose ratio below Grok's real title bar", () => {
    const pane = [
      "branch ~/repo [Click here to Upgrade] 153K / 500K │ 4/4 ✓",
      "agent discussion: compare 200K / 11.1K records",
    ].join("\n");
    expect(parseTokenContextRatio(pane)?.percentage).toBeCloseTo(30.6);
    expect(parseContextPercent(pane)).toBeCloseTo(30.6);
  });

  it("ignores an impossible percent below Kiro's real statusline", () => {
    const pane = [
      "kiro_default · auto · ◕ 63% · λ",
      "projected growth is 133% > last year",
    ].join("\n");
    expect(parseContextPercent(pane)).toBe(63);
  });

  it("returns null when a pane contains only impossible context candidates", () => {
    expect(parseTokenContextRatio("200K / 11.1K")).toBeNull();
    expect(parseContextPercent("Context 133% used\nContext 140% left")).toBeNull();
  });
});

describe("resolveInstanceContext", () => {
  it("reads claude-code from statusline.json", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctx-resolve-"));
    const inst = "claude-bot";
    mkdirSync(join(dataDir, "instances", inst), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", inst, "statusline.json"),
      JSON.stringify({ context_window: { used_percentage: 41.2 } }),
    );
    expect(readStatuslineContextPct(dataDir, inst)).toBeCloseTo(41.2);
    const { context } = resolveInstanceContext(dataDir, inst, "claude-code", { bypassCache: true });
    expect(context).toBeCloseTo(41.2);
  });

  it("reads Claude's actually active model from statusline.json", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "model-resolve-"));
    const inst = "claude-bot";
    mkdirSync(join(dataDir, "instances", inst), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", inst, "statusline.json"),
      JSON.stringify({ model: { id: "claude-sonnet-5", display_name: "Sonnet 5" } }),
    );
    expect(readStatuslineModel(dataDir, inst)).toBe("Sonnet 5 (claude-sonnet-5)");
  });

  it("/ctx prefers Claude's live model over the configured rejected model", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctx-live-model-"));
    const inst = "claude-bot";
    mkdirSync(join(dataDir, "instances", inst), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", inst, "statusline.json"),
      JSON.stringify({
        context_window: { used_percentage: 12 },
        model: { id: "claude-sonnet-5", display_name: "Sonnet 5" },
      }),
    );
    const commands = new TopicCommands({
      dataDir,
      fleetConfig: {
        defaults: {},
        instances: { [inst]: { backend: "claude-code", model: "claude-opus-4-6[1m]" } },
      },
      modelDisplayForInstance: () => "claude-opus-4-6[1m]",
    } as any);

    const text = await commands.getCtxText(inst);
    expect(text).toContain("Sonnet 5 (claude-sonnet-5)");
    expect(text).not.toContain("claude-opus-4-6[1m]");
  });

  it("clamps a trusted statusline reading to the user-visible range", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctx-resolve-clamp-"));
    const inst = "claude-overflow";
    mkdirSync(join(dataDir, "instances", inst), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", inst, "statusline.json"),
      JSON.stringify({ context_window: { used_percentage: 133 } }),
    );
    expect(readStatuslineContextPct(dataDir, inst)).toBe(100);
  });

  it("does not use statusline.json for non-claude backends (stale after switch)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ctx-resolve-stale-"));
    const inst = "was-claude-now-kiro";
    mkdirSync(join(dataDir, "instances", inst), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", inst, "statusline.json"),
      JSON.stringify({ context_window: { used_percentage: 99 } }),
    );
    // No tmux pane in test → scrape fails → null (must NOT return 99 from statusline)
    const { context } = resolveInstanceContext(dataDir, inst, "kiro-cli", { bypassCache: true });
    expect(context).toBeNull();
  });
});
