/**
 * Tests for Grok watcher panel busy detection fix (#2334).
 *
 * Root cause: getBusyPattern() used /[\u2800-\u28FF]\s+\p{L}[^\n]*…\s*\d+s\b/
 * Grok Build's Watchers panel animation uses braille glyphs + elapsed timer,
 * matching the pattern even when the turn was done.
 *
 * Fix: require `[stop]` on the spinner line — ALL real Grok turn-status lines
 * end with `[stop]` (or `[↓][stop]`); watcher lines do not.
 *
 * Fixtures:
 *   grok-watcher-idle.pane.txt — idle turn + active watcher animation
 *   grok-watcher-busy.pane.txt — active tool-run (⠼ Run Read … [↓][stop]) + watcher
 *   Real fixtures from grok-1.0.60-audit/ (verified [stop] on every spinner line)
 *
 * The watcher glyph cycle includes braille chars (:⸬⁙⋅ and others); the leader's
 * live pane also showed the watcher with titles starting with turn-status words
 * ("Waiting for PR merge", "Running deployment"). These are negative controls.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string) =>
  readFileSync(join(ROOT, "tests/fixtures", name), "utf-8");
const fixtureAudit = (dir: string, step: string) =>
  readFileSync(join(ROOT, "tests/fixtures/grok-1.0.60-audit", dir, step + ".pane.txt"), "utf-8");

const backend = new GrokBackend("/tmp/agend-grok-watcher-test");

// ── Regression: idle turn + active watcher → NOT busy ───────────────────────

describe("Grok watcher: idle composer + active watcher → idle (#2334)", () => {
  it("idle pane with ⠴ watcher (braille + seconds, no [stop]) is NOT busy", () => {
    const pane = fixture("grok-watcher-idle.pane.txt");
    expect(backend.getReadyPattern().test(pane), "ready pattern must match").toBe(true);
    expect(backend.getBusyPattern().test(pane), "busy must NOT match — turn is done").toBe(false);
  });
});

// ── Real in-turn states MUST match ──────────────────────────────────────────

describe("Grok busy: real turn-spinner fixtures (must match)", () => {
  it("1.0.60 at 120col — ⠴ Waiting for response… [stop]", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.60-120", "03-busy-a"))).toBe(true);
  });
  it("1.0.60 at 80col — ⠴ Waiting for response… [stop]", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.60-80", "03-busy-a"))).toBe(true);
  });
  it("1.0.52 at 120col — ⠦ Waiting for response… [stop]", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.52-120", "03-busy-a"))).toBe(true);
  });
  it("1.0.52 at 80col — ⠦ Waiting for response… [stop]", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.52-80", "03-busy-a"))).toBe(true);
  });

  it("tool-run state ⠼ Run Read … [↓][stop] (leader's captured line) IS busy", () => {
    // Real captured pane: an active tool call in the turn — must stay busy.
    const pane = fixture("grok-watcher-busy.pane.txt");
    expect(backend.getBusyPattern().test(pane), "active tool-run with [stop] must match").toBe(true);
  });

  it("bare tool-run spinner line ⠼ Run Read … [↓][stop]", () => {
    const line = "    ⠼ Run Read `/home/han/…/install-sh-prefix-sudo-229…`… 0.1s    3m19s ⇣24.4k [↓][stop]";
    expect(backend.getBusyPattern().test(line)).toBe(true);
  });
});

// ── Idle frames NOT busy ─────────────────────────────────────────────────────

describe("Grok busy: idle frames (must NOT match)", () => {
  it("1.0.60 ready frame (done turn)", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.60-120", "02-ready"))).toBe(false);
  });
  it("1.0.60 done frame", () => {
    expect(backend.getBusyPattern().test(fixtureAudit("1.0.60-120", "04-done"))).toBe(false);
  });
});

// ── Watcher panel negatives (must NOT match) ─────────────────────────────────

describe("Grok busy: watcher panel negatives (must NOT match)", () => {
  it("bare watcher line: ⠴ Monitor Watch … 45.2s (no [stop])", () => {
    const line = "   ⠴ Monitor Watch PR 2315 merge then GitHub Pages live hash…        45.2s";
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("watcher title starting with 'Waiting' (no [stop]) — P2 verb-whitelist trap", () => {
    // Would have triggered the old verb-whitelist pattern but not [stop] pattern.
    const line = "   ⠴ Waiting for PR 2315 merge…        2h01m";
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("watcher title starting with 'Running' (no [stop]) — P2 verb-whitelist trap", () => {
    const line = "   ⠴ Running deployment monitor…        48.2s";
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("watcher glyph cycle: colon and non-braille chars (:⸬⁙⋅)", () => {
    // These are NOT braille glyphs — already safe; verified as control.
    const line = "   ⸬ Monitor Watch PR 2315 merge…        2h01m";
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("prose line with '…' and seconds (no braille, no [stop])", () => {
    // Old-style false positive: no braille glyph so already safe.
    const line = "   prose from an idle conversation… 3.0s";
    expect(backend.getBusyPattern().test(line)).toBe(false);
  });

  it("cross-line false positive: ⠴ Waiting…\\n prose… 3.0s (no [stop] on spinner line)", () => {
    // The old [\s\S]*? could cross lines; [stop]-anchored pattern stays on one line.
    const pane = "   ⠴ Waiting for a CI result\n   prose from an idle conversation… 3.0s\n  │ ❯ │";
    expect(backend.getBusyPattern().test(pane)).toBe(false);
  });
});
