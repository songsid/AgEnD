import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContextPercent,
  parseTokenContextRatio,
  readStatuslineContextPct,
  resolveInstanceContext,
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
