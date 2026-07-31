import { describe, expect, it } from "vitest";
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

describe("KiroBackend.getPaneActivity", () => {
  const backend = new KiroBackend("/tmp/test");

  it("reports the tool and its purpose while it is running", () => {
    expect(backend.getPaneActivity(RUNNING)).toBe("shell: Merge #419");
  });

  it("reports nothing once the tool has completed", () => {
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
});
