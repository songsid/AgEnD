import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * #991: the #978 stable-unknown-layout escape hatch vetoed on a WIDE "• … esc to interrupt" match (indented lines
 * included), while everything else reads a live status row through the precise whole-row matcher of #964. A reply that
 * quotes the phrase therefore pinned an idle pane busy for the hatch while the rest of the daemon saw it idle. The hatch
 * now uses the same precise signal: a real live status row (any title) still vetoes; a quote, indented or in prose, does
 * not. The pane is the bottom of a real resumed Codex with an unrecognised footer; only the transcript above differs.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const NO_CONTEXT = readFileSync(join(fixtures, "codex-0157-resumed-no-context-footer.pane.txt"), "utf8");
const b = new CodexBackend("/tmp/codex-991-probe");
const withAbove = (lines: string[]) => NO_CONTEXT.replace("› Ask Codex to do anything", `${lines.join("\n")}\n\n› Ask Codex to do anything`);

describe("the escape hatch's busy veto is the precise live status row", () => {
  it("the unmodified fixture is the idle case the hatch exists for", () => {
    expect(b.isStableUnknownLayoutIdlePane(NO_CONTEXT)).toBe(true);
  });

  const LIVE = [
    "• Working (3s • esc to interrupt)",
    "• Planning the edit (esc to interrupt)",
    "• Planning the edit (12s • esc to interrupt)",
    "• Reviewing the diff for regressions (2m 05s • esc to interrupt)",
    "• Running the focused tests (41s · esc to interrupt)",
    "• Checking migrations (1m 02s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
  ];
  it.each(LIVE)("a real live status row vetoes: %s", (row) => {
    const pane = withAbove([row]);
    expect(b.getBusyPattern().test(pane)).toBe(true);
    expect(b.isStableUnknownLayoutIdlePane(pane)).toBe(false);
  });

  const QUOTES = [
    "  • Planning the edit (esc to interrupt)",                       // indented: a quote in a reply
    "    • Working (5m 51s • esc to interrupt)",
    "• You can press esc to interrupt at any time.",                  // a column-zero reply bullet, prose
    "• The status row reads `(12s • esc to interrupt)` while it works.",
    "  to stop it press esc to interrupt",
  ];
  it.each(QUOTES)("a quote of the phrase does not: %s", (row) => {
    const pane = withAbove([row]);
    expect(b.getBusyPattern().test(pane)).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane(pane)).toBe(true);
  });

  it("the hatch and the daemon-wide busy pattern now agree on every row above", () => {
    for (const row of [...LIVE, ...QUOTES]) {
      const pane = withAbove([row]);
      expect(b.isStableUnknownLayoutIdlePane(pane), row).toBe(!b.getBusyPattern().test(pane));
    }
  });

  it("its other vetoes are unchanged: queued input, a known picker, no live composer, a dropped app-server", () => {
    expect(b.isStableUnknownLayoutIdlePane(withAbove(["↳ a queued message"]))).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane(withAbove(["Messages to be submitted after next tool call"]))).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane("• Earlier answer.\n\n  no composer here")).toBe(false);
  });
});
