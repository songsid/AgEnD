/**
 * #964: Codex relabels its live status row with the reasoning title
 * (`• Planning the edit (12s • esc to interrupt)`) instead of "Working". The
 * busy veto only knew the literal "Working", so a working pane read as ready
 * on both the Context-footer and the configured no-Context readiness paths.
 *
 * Status-row shapes below are the ones mined from real codex 0.156/0.157
 * output logs; every case calls the production backend and state machine.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { PaneStateMachine } from "../src/daemon.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function backend(items?: string[]): CodexBackend {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-964-"));
  dirs.push(dir);
  if (items) writeFileSync(join(dir, "config.toml"), `[tui]\nstatus_line = ${JSON.stringify(items)}\n`);
  const b = new CodexBackend(join(dir, "instance"));
  (b as any).isolatedCodexHome = dir;
  return b;
}

/** What the daemon's idle gate decides for one settled capture. */
function gateState(b: CodexBackend, pane: string): string {
  const machine = new PaneStateMachine(b.getReadyPattern(), 60_000, 0, b.getBusyPattern());
  return machine.observe(pane, 1_000, { settled: true }).state;
}

const pane = (status: string, footer: string) =>
  ["• Earlier answer.", "", status, "", "› Ask Codex to do anything", "", footer].join("\n");

const STATUS_ROWS = [
  "• Planning the edit (esc to interrupt)",
  "• Planning the edit (12s • esc to interrupt)",
  "• Reviewing the diff for regressions (2m 05s • esc to interrupt)",
  "• Running the focused tests (41s · esc to interrupt)",
  "• Checking migrations (1m 02s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
  "• Working (3s • esc to interrupt)",
];

const PATHS: Array<[string, string[] | undefined, string]> = [
  ["Context-first footer", undefined, "  Context 46% left · gpt-5.6-sol medium"],
  ["configured Context in any position", ["model-with-reasoning", "context-remaining"], "  gpt-5.6-sol medium · Context 46% left"],
  ["configured no-Context footer", ["model-with-reasoning"], "  gpt-5.6-sol medium"],
];

describe("a busy Codex status row with a reasoning title is busy on every readiness path (#964)", () => {
  for (const [path, items, footer] of PATHS) {
    it.each(STATUS_ROWS)(`${path}: %s is NOT ready`, (status) => {
      const b = backend(items);
      const p = pane(status, footer);
      expect(b.getBusyPattern().test(p)).toBe(true);
      expect(gateState(b, p)).toBe("working");
      expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
      expect(b.isStableUnknownLayoutIdlePane(p)).toBe(false);
    });

    it(`${path}: the same pane without the status row is still ready`, () => {
      const b = backend(items);
      const idle = ["• Earlier answer.", "", "› Ask Codex to do anything", "", footer].join("\n");
      expect(b.getBusyPattern().test(idle)).toBe(false);
      expect(gateState(b, idle)).toBe("idle");
    });
  }

  it("does not read transcript prose that mentions the status row as busy", () => {
    const b = backend();
    for (const prose of [
      "• The status row reads `• Planning the edit (esc to interrupt)` while it works.",
      "• Press esc to interrupt if it hangs.",
      "  • Planning the edit (12s • esc to interrupt)",
      "› • Planning the edit (12s • esc to interrupt)",
      "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
    ]) {
      const p = pane(prose, "  Context 46% left");
      expect(b.getBusyPattern().test(p), prose).toBe(false);
    }
  });
});
