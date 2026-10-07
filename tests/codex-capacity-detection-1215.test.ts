/**
 * #1215 codex capacity detection hardening: glyph table, live-row ownership,
 * shared status glyph.
 *
 * Pure pattern/store tests over the live CodexBackend.getErrorPatterns():
 * no fleet, no CLI, no tmux. Unicode categories behind the table were
 * verified programmatically (■ U+25A0 So, ⚠ U+26A0 So, ✖ U+2716 So,
 * ❌ U+274C So, ⛔ U+26D4 So vs • U+2022 Po, │ U+2502 So-but-excluded,
 * ※ U+203B Po, × U+00D7 Sm; ─–▟ is U+2500–U+259F, outside which ■/⚠ sit).
 */
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { CODEX_STATUS_GLYPH, codexLiveRowMatches } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

const SENTENCE = "Selected model is at capacity. Please try a different model.";
const patterns = new CodexBackend("/tmp/codex-capacity-detection-1215").getErrorPatterns();
const capacity = patterns.find(p => p.action === "nudge_continue")!;
const byType = (type: string) => patterns.filter(p => p.type === type);

describe("glyph table: what opens a capacity line (#1215)", () => {
  it("accepts status glyphs, including future ones in So", () => {
    for (const glyph of ["■", "⚠", "⚠️", "✖", "❌", "⛔"]) {
      expect(capacity.pattern.test(`${glyph} ${SENTENCE}`), glyph).toBe(true);
    }
  });

  it("rejects prose markers and box-drawing chrome", () => {
    for (const prefix of ["•", "-", ">", "│", "※", "×"]) {
      expect(capacity.pattern.test(`${prefix} ${SENTENCE}`), JSON.stringify(prefix)).toBe(false);
    }
    // The issue's exact case: a left-border popup/table row.
    expect(capacity.pattern.test(`│ ${SENTENCE}`)).toBe(false);
  });

  it("documents the accepted false-negative boundary (fail to detect, never false-pause)", () => {
    // Po/Sm openers the So class cannot see stay invisible by design.
    expect(capacity.pattern.test(`※ ${SENTENCE}`)).toBe(false);
    expect(capacity.pattern.test(`× ${SENTENCE}`)).toBe(false);
  });
});

describe("shared CODEX_STATUS_GLYPH for quota / rate_limit / auth (#1215)", () => {
  it("one constant names both glyphs", () => {
    expect(CODEX_STATUS_GLYPH).toBe(String.raw`■|⚠`);
  });

  it.each(["quota", "rate_limit", "auth_error"])("%s matches both glyphs, so a re-hardcode of one breaks loudly", type => {
    const decorated = byType(type).filter(p => p.pattern.source.includes("■"));
    expect(decorated.length).toBeGreaterThan(0);
    for (const ep of decorated) {
      expect(ep.pattern.source, `${type} keeps the shared glyph`).toContain("⚠");
    }
  });

  it("quota reads through either glyph", () => {
    const ep = byType("quota").find(p => p.pattern.source.includes("insufficient_quota"))!;
    expect(ep.pattern.test("■ Error: insufficient_quota")).toBe(true);
    expect(ep.pattern.test("⚠ Error: insufficient_quota")).toBe(true);
    expect(ep.pattern.test("│ Error: insufficient_quota")).toBe(false);
  });

  it("rate_limit reads through either glyph", () => {
    const ep = byType("rate_limit").find(p => p.pattern.source.includes("rate_limit_exceeded"))!;
    expect(ep.pattern.test("■ rate_limit_exceeded")).toBe(true);
    expect(ep.pattern.test("⚠ rate_limit_exceeded")).toBe(true);
  });

  it("auth_error reads through either glyph", () => {
    const ep = byType("auth_error").find(p => p.pattern.source.includes("invalid_api_key"))!;
    expect(ep.pattern.test("■ invalid_api_key")).toBe(true);
    expect(ep.pattern.test("⚠ invalid_api_key")).toBe(true);
  });
});

describe("live-row ownership (#1215)", () => {
  const IDLE_TAIL = "\n\n› Ask Codex to do anything\n  Context 100% left";
  const live = (row: string) => `• earlier answer\n\n${row}${IDLE_TAIL}`;

  it("a live capacity row owns the screen", () => {
    expect(codexLiveRowMatches(live(`■ ${SENTENCE}`), capacity.pattern)).toBe(true);
    expect(codexLiveRowMatches(live(`⚠ ${SENTENCE}`), capacity.pattern)).toBe(true);
  });

  it("a quotation inside an answer is not evidence", () => {
    const pane = `• you said ${SENTENCE} huh\n\n• I quoted it back, then kept working\n\nWorked for 12s${IDLE_TAIL}`;
    expect(codexLiveRowMatches(pane, capacity.pattern)).toBe(false);
  });

  it("scrollback above a newer turn is not evidence", () => {
    const pane = `■ ${SENTENCE}\n\n› keep going\n\n• all done here${IDLE_TAIL}`;
    expect(codexLiveRowMatches(pane, capacity.pattern)).toBe(false);
  });

  it("a transcript item below the composer disowns the row", () => {
    const pane = `■ ${SENTENCE}\n\n› Ask Codex to do anything\n• a transcript echo below the composer\n  Context 100% left`;
    expect(codexLiveRowMatches(pane, capacity.pattern)).toBe(false);
  });

  it("no composer, no live row", () => {
    expect(codexLiveRowMatches(`■ ${SENTENCE}\n\nstill printing…`, capacity.pattern)).toBe(false);
  });

  it("a box-drawing popup row never matches in the first place", () => {
    expect(codexLiveRowMatches(live(`│ ${SENTENCE}`), capacity.pattern)).toBe(false);
  });

  it("does not disturb a stateful pattern's lastIndex", () => {
    const stateful = new RegExp(capacity.pattern.source, capacity.pattern.flags + "g");
    stateful.lastIndex = 3;
    codexLiveRowMatches(live(`■ ${SENTENCE}`), stateful);
    expect(stateful.lastIndex).toBe(3);
  });
});

describe("one shared occurrence counter (#1215)", () => {
  it("the static clones with g: repeated calls agree despite lastIndex", () => {
    const count = (Daemon as any).countOccurrences;
    const pane = `■ ${SENTENCE}\n\n■ ${SENTENCE}\n\n› Ask Codex to do anything`;
    expect(count(capacity.pattern, pane)).toBe(2);
    capacity.pattern.lastIndex = 7;
    expect(count(capacity.pattern, pane)).toBe(2);
    expect(capacity.pattern.lastIndex).toBe(7);
  });
});
