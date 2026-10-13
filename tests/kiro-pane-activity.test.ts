import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KiroBackend } from "../src/backend/kiro.js";

/**
 * Panes below are verbatim from a live AgEnD-managed kiro-cli window, sampled
 * while it was working. kiro announces every tool call and reports its completion
 * on a separate line, so "currently running" is a relationship between the two
 * markers rather than a marker of its own.
 */

const RUNNING = [
  "> <br>",
  "I will run the following command: cd /home/han/Projects/AgEnD && gh pr merge 419 --repo songsid/AgEnD --merge 2>&1 (using tool: shell)",
  "Purpose: Merge #419",
  "",
  " → ↳ thinking...",
  "  Controls: o toggle convo ^+C interrupt",
].join("\n");

const FINISHED = [
  "I will run the following command: gh pr list --json number,title (using tool: shell)",
  "Purpose: List open PRs",
  " - Completed in 67.914s",
  "",
  "18% λ !>",
].join("\n");

const IDLE = [
  " ▸ Credits: 0.29 • Time: 5s",
  "",
  "9% !> Curious what I can do? Just ask!",
].join("\n");

// #1734: output with no trailing newline — completion printed on the same line.
const NO_TRAILING_NEWLINE_FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures/kiro-no-trailing-newline-1734.pane.txt"),
  "utf8",
);
// Synthetic pane that reproduces the exact bug: completion immediately after
// output bytes with no newline separator.
const NO_NEWLINE_SAME_LINE = [
  "I will run the following command: printf '%s' hello (using tool: shell)",
  "hello - Completed in 0.234s",
  "",
  "18% λ !>",
].join("\n");

describe("KiroBackend.getPaneActivity", () => {
  const backend = new KiroBackend("/tmp/test", TEST_KIRO_COMPAT);

  it("reports the tool and its purpose while it is running", () => {
    expect(backend.getPaneActivity(RUNNING)).toBe("shell: Merge #419");
  });

  it("reports nothing once the tool has completed (normal newline before completion)", () => {
    // The distinguishing marker is a completion line *after* the announcement.
    // Matching `(using tool: …)` alone would pin the turn's last tool to the
    // progress line for the rest of the session.
    expect(backend.getPaneActivity(FINISHED)).toBeNull();
  });

  it("reports nothing on an idle pane", () => {
    expect(backend.getPaneActivity(IDLE)).toBeNull();
  });

  it("follows the most recent announcement, not the first", () => {
    const pane = [
      "cmd one (using tool: shell)",
      "Purpose: first",
      " - Completed in 1.404s",
      "reading a file (using tool: fs_read)",
      "Purpose: inspect config",
    ].join("\n");

    expect(backend.getPaneActivity(pane)).toBe("fs_read: inspect config");
  });

  it("falls back to the bare tool name when kiro emitted no purpose", () => {
    expect(backend.getPaneActivity("delegating (using tool: subagent)")).toBe("subagent");
  });

  it("is not fooled by the phrase appearing in agent prose", () => {
    // The announcement is a parenthesised suffix; a sentence merely mentioning a
    // tool must not hold the instance's progress line hostage.
    expect(backend.getPaneActivity("I could use the shell tool: shell here")).toBeNull();
    expect(backend.getPaneActivity("18% λ !> what does (using tool) mean?")).toBeNull();
  });

  // ── #1734: completion on the same line as output (no trailing newline) ──────

  it("#1734: completion on same line as output — not busy (synthetic)", () => {
    // Shell tool output with no trailing newline: kiro appends ` - Completed in …`
    // immediately after the last output byte rather than on a new line.
    expect(backend.getPaneActivity(NO_NEWLINE_SAME_LINE)).toBeNull();
  });

  it("#1734: completion on same line as output — not busy (reporter's fixture)", () => {
    expect(backend.getPaneActivity(NO_TRAILING_NEWLINE_FIXTURE)).toBeNull();
  });

  it("#1734: tool still running — is still busy (must not regress)", () => {
    // A tool announcement with no completion line anywhere after it must
    // still be reported as running.
    const stillRunning = [
      "I will run the following command: make build (using tool: shell)",
      "Purpose: Build project",
      "cc -O2 -o output main.c",
    ].join("\n");
    expect(backend.getPaneActivity(stillRunning)).toBe("shell: Build project");
  });

  it("#1734: tool output containing '- Completed in' mid-line stays busy (false-positive guard)", () => {
    // A test runner or build log may emit "- Completed in 0.5s" inside a longer line.
    // The instance must NOT be considered idle — the completion marker is not at end of line.
    const midLineOutput = [
      "I will run the following command: pytest --tb=short (using tool: shell)",
      "Purpose: Run tests",
      "test_foo.py::test_bar - Completed in 0.5s FAILED (assert 1 == 2)",
    ].join("\n");
    expect(backend.getPaneActivity(midLineOutput)).toBe("shell: Run tests");
  });

  // Fable witness cases: three output lines that must NOT trigger a false idle.
  it.each([
    ["Step 3/5 - Completed in 3 steps", "no duration suffix"],
    ["  * lint - Completed in parallel", "no duration at all"],
    ["make: [build] - Completed in 2.3s, next: test", "text after duration"],
  ])("#1734: Fable witness — busy with output '%s' (%s)", (outputLine) => {
    const pane = [
      "I will run the following command: make all (using tool: shell)",
      "Purpose: build",
      outputLine,
      "still compiling...",
    ].join("\n");
    expect(backend.getPaneActivity(pane)).toBe("shell: build");
  });

  it("#1734: wide-regex mutation guard — reverting to /(?:^|\\s)-\\s*Completed in\\b/ makes the witness cases falsely match", () => {
    // The three Fable witness lines each have "- Completed in" but NOT at end-of-line with a
    // valid duration. The old wide regex (/\s*Completed in\b/) would match all of them and
    // falsely report the tool finished. Our tight regex (duration + $ anchor) does not.
    // This test goes red when the regex is reverted to the old form.
    const witnesses = [
      "Step 3/5 - Completed in 3 steps",
      "  * lint - Completed in parallel",
      "make: [build] - Completed in 2.3s, next: test",
    ];
    for (const line of witnesses) {
      const pane = [
        "I will run the following command: make all (using tool: shell)",
        "Purpose: build",
        line,
      ].join("\n");
      expect(backend.getPaneActivity(pane), `should stay busy for: ${line}`).toBe("shell: build");
    }
  });
});
