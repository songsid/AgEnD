import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContextPercent } from "../src/topic-commands.js";
import { createBackend } from "../src/backend/factory.js";
import { PIE_GLYPHS } from "../src/tui-glyphs.js";

// The full progression Kiro steps through as the context window fills. Matching
// only the first one made every higher reading invisible to /ctx.
const GLYPHS = [..."◔◐◑◒◓◕●"];

function readyPattern(backendName: string): RegExp {
  const dir = mkdtempSync(join(tmpdir(), `pie-${backendName}-`));
  return createBackend(backendName, dir).getReadyPattern();
}

describe("TUI pie glyphs", () => {
  it("covers all seven glyphs", () => {
    expect([...PIE_GLYPHS]).toEqual(GLYPHS);
  });
});

describe("parseContextPercent with each pie glyph", () => {
  it("reads the percentage regardless of which glyph is showing", () => {
    // Real shape captured from a live pane: "kiro_default · auto · ◑ 27% · λ".
    for (const g of GLYPHS) {
      expect(parseContextPercent(`kiro_default · auto · ${g} 27% · λ`), g).toBe(27);
    }
  });

  it("reads low and high percentages alike", () => {
    for (const g of GLYPHS) {
      for (const pct of [1, 8, 27, 50, 88, 99, 100]) {
        expect(parseContextPercent(`kiro_default · auto · ${g} ${pct}% · λ`), `${g}${pct}`).toBe(pct);
      }
    }
  });

  it("tolerates no space and extra space between glyph and percentage", () => {
    for (const g of GLYPHS) {
      expect(parseContextPercent(`${g}42%`), g).toBe(42);
      expect(parseContextPercent(`${g}   42%`), g).toBe(42);
    }
  });

  it("takes the most recent reading when several are on screen", () => {
    // Bottom-up scan: the newest status line is the live one.
    const pane = ["kiro · ◔ 3% · λ", "... output ...", "kiro · ◕ 91% · λ"].join("\n");
    expect(parseContextPercent(pane)).toBe(91);
  });

  it("still returns null when no reading is present", () => {
    expect(parseContextPercent("just some agent output\nno status line here")).toBeNull();
  });
});

describe("ready patterns with each pie glyph", () => {
  // Resolved from the real backend objects — a copied regex here could drift
  // from the one that actually runs, which is how this bug survived.
  it("kiro-cli matches mid-line status and bare pie readings", () => {
    const pattern = readyPattern("kiro-cli");
    for (const g of GLYPHS) {
      expect(pattern.test(`kiro_default · auto · ${g} 27% · λ`), g).toBe(true);
      expect(pattern.test(`${g} 5%`), `${g} bare`).toBe(true);
    }
  });

  it("antigravity matches line-leading pie footers only (not mid-prose bullets)", () => {
    const pattern = readyPattern("antigravity");
    for (const g of GLYPHS) {
      expect(pattern.test(`${g} 5%`), `${g} bare`).toBe(true);
      expect(pattern.test(`  ${g} 27%`), `${g} indented footer`).toBe(true);
      // Mid-line / prose must not ready — ● especially is a common bullet.
      expect(pattern.test(`progress ${g} 45% done`), `${g} mid`).toBe(false);
      expect(pattern.test(`任務 ${g} 45% 完成`), `${g} cjk`).toBe(false);
    }
  });

  it("kiro-cli keeps its non-pie ready signals", () => {
    const pattern = readyPattern("kiro-cli");
    for (const line of [
      "All tools are now trusted",
      "Trust All Tools active",
      "Credits: 12  Time: 3s",
      "ask a question or describe a task",
      "22% !>",
      "8% ❯",
      "20% λ !>",
    ]) {
      expect(pattern.test(line), line).toBe(true);
    }
  });

  it("antigravity keeps its non-pie ready signals", () => {
    const pattern = readyPattern("antigravity");
    expect(pattern.test("? for shortcuts")).toBe(true);
    expect(pattern.test("Gemini")).toBe(true);
    expect(pattern.test(">")).toBe(true);
  });
});

describe("parseContextPercent ignores agent pie-like prose", () => {
  it("does not treat '● 45% 完成' style lines as context usage", () => {
    expect(parseContextPercent("任務 ● 45% 完成，繼續處理中")).toBeNull();
    expect(parseContextPercent("status: ● 45% done")).toBeNull();
  });

  it("still reads real status-line pie readings", () => {
    expect(parseContextPercent("kiro_default · auto · ◑ 27% · λ")).toBe(27);
    expect(parseContextPercent("◑ 27%")).toBe(27);
  });
});
