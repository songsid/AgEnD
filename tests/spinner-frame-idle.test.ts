import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneStateMachine } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

/**
 * Why cancel buttons vanished mid-turn on some claude-code instances.
 *
 * The spinner animates through six glyphs and one of them is a plain ASCII
 * asterisk. The busy pattern's leading class excluded ASCII, so that one frame
 * did not match — and since `❯` is always on screen (claude keeps its input box
 * rendered), the ready pattern is permanently true and the busy pattern is the
 * only discriminator. One unlucky frame therefore meant "idle" while the CLI was
 * generating, and whatever check sampled the state at that moment retired the
 * button.
 *
 * Measured live on a continuously working pane, 50 samples at 250ms:
 *   ✻ 11/11  ✽ 10/10  ✢ 10/10  · 9/9  ✶ 4/4  * 0/6
 */

const FRAMES = ["✻", "✽", "✢", "·", "✶", "*"] as const;

const spinner = (glyph: string, secs = 46) =>
  [
    `${glyph} Befuddling… (4m ${secs}s · ↓ 15.1k tokens)`,
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "",
    "────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────",
    "  ok",
  ].join("\n");

const bareSpinner = (glyph: string, label = "Nesting") =>
  [
    `${glyph} ${label}…`,
    "",
    "────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────",
    "  ok",
  ].join("\n");

const FINISHED = [
  "✻ Worked for 6m 49s",
  "",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  ok",
].join("\n");

const backend = new ClaudeCodeBackend(mkdtempSync(join(tmpdir(), "agend-spinner-")));

describe("busy pattern across the whole spinner animation", () => {
  it("matches every frame, including the ASCII asterisk", () => {
    for (const glyph of FRAMES) {
      expect(backend.getBusyPattern().test(spinner(glyph)), `frame ${glyph}`).toBe(true);
    }
  });

  it("matches the incrementally-painted bare line seen before the timer appears", () => {
    for (const glyph of FRAMES) {
      expect(backend.getBusyPattern().test(bareSpinner(glyph)), `bare frame ${glyph}`).toBe(true);
    }
  });

  it("matches Claude's hyphenated spinner labels", () => {
    for (const label of ["Razzle-dazzling", "Sock-hopping", "Topsy-turvying", "Fiddle-faddling"]) {
      expect(backend.getBusyPattern().test(bareSpinner("*", label)), label).toBe(true);
      expect(backend.getBusyPattern().test(spinner("✢").replace("Befuddling", label)), label).toBe(true);
    }
  });

  it("matches an elapsed suffix while Claude is still repainting it", () => {
    expect(backend.getBusyPattern().test("* Nesting… (3s · ↓")).toBe(true);
  });

  it("still rejects the finished line, which has no ellipsis and no counter", () => {
    expect(backend.getBusyPattern().test(FINISHED)).toBe(false);
  });

  it("does not fire on ordinary pane furniture", () => {
    // Widening the class must not make prose or prompts look like a spinner.
    for (const line of ["❯ ", "  ok", "> ask a question or describe a task ↵",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      "* bullet point… (3 items)", "- item… (see below)", "* two words…",
      "* Waiting...", "* Waiting… trailing prose",
      // Allowing the asterisk must not allow every ASCII symbol: quoted prose
      // shaped like a spinner would pin the instance in `working` forever.
      "> quoted… (2s)", "- Something happened… (5s ago)", "I waited… (30s) for the build"]) {
      expect(backend.getBusyPattern().test(line), line).toBe(false);
    }
  });
});

describe("PaneStateMachine: one observation per capture", () => {
  const machine = () => new PaneStateMachine(backend.getReadyPattern(), 600_000, 0, backend.getBusyPattern());

  it("reports working on the asterisk frame", () => {
    const sm = machine();
    sm.observe(spinner("✻", 44), 2_000);
    // This is the exact regression: same line, same instant in the turn, only
    // the animation frame differs.
    sm.observe(spinner("*", 46), 4_000);
    expect(sm.snapshot(4_000).state).toBe("working");
  });

  it("treats moving content as working while output is still arriving", () => {
    const sm = machine();
    sm.observe(spinner("✻", 44), 2_000);
    sm.observe(FINISHED, 4_000, { settled: false }); // not settled: output was flowing
    expect(sm.snapshot(4_000).state).toBe("working");
  });

  it("sees a finished turn as idle on the first settled capture", () => {
    // The property a naive single-observe would have broken. Captures are
    // event-driven: the one taken 2s after output stops always differs from the
    // previous capture, so without the settled flag a finished turn would stay
    // "working" until the next 60s safety sweep — buttons and progress tickers
    // lingering a minute past the end of every turn.
    const sm = machine();
    sm.observe(spinner("✻", 44), 2_000);
    sm.observe(FINISHED, 4_000, { settled: true });
    expect(sm.snapshot(4_000).state).toBe("idle");
  });

  it("still reports stuck when a non-ready pane stops changing", () => {
    const sm = new PaneStateMachine(backend.getReadyPattern(), 60_000, 0, backend.getBusyPattern());
    const frozen = "some half-drawn dialog with no prompt";
    sm.observe(frozen, 1_000);
    sm.observe(frozen, 2_000);
    expect(sm.snapshot(2_000).state).toBe("working");
    sm.observe(frozen, 70_000);
    expect(sm.snapshot(70_000).state).toBe("stuck");
  });

  it("keeps a generating pane working even on a settled capture", () => {
    // Belt and braces: the two fixes cover each other. Even if a capture is
    // classified settled while the CLI is in fact generating, the busy pattern
    // now recognises every frame and vetoes idle.
    const sm = machine();
    sm.observe(spinner("✻", 44), 2_000);
    for (const glyph of FRAMES) {
      sm.observe(spinner(glyph, 50), 6_000, { settled: true });
      expect(sm.snapshot(6_000).state, `settled capture on frame ${glyph}`).toBe("working");
    }
  });

  it("keeps the timer-less initial frame working on a settled capture", () => {
    // Claude 2.1.239 paints `* Nesting…` first and appends the timer later. A
    // 2s idle-debounce capture can therefore legitimately see this exact pane.
    const sm = machine();
    sm.observe(FINISHED, 1_000);
    sm.observe(bareSpinner("*"), 4_000, { settled: true });
    expect(sm.snapshot(4_000).state).toBe("working");
  });
});
