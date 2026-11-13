/**
 * codex 0.169.0's resume-loading screen (`  Resuming session…` over the composer) shows the bare shortcut hint
 * `  ? for shortcuts` under the composer. The resume-in-progress input guard (codexUnboxedResumeLoading) required the
 * composer to be the last thing on screen, so it stopped firing. Port of the alpha audit's fix (#3830); the frames are
 * that audit's (tests/fixtures/codex-audit-0169 on the alpha line): rig captures under `unshare -rn`, normalised.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex169m-")));
const frame = (name: string) => readFileSync(new URL(`./fixtures/codex-resume-loading-0169/${name}.pane.txt`, import.meta.url), "utf8");
const loadingGuard = (pane: string) => backend.getInputUnavailableTransients().some(t => t.isActive(pane));

describe("codex 0.169 resume-loading: `? for shortcuts` under the composer", () => {
  it("0.169's loading frame is held (input unavailable), not ready, not deliverable; 0.167.2's still is", () => {
    for (const name of ["resume-loading", "resume-loading-01672"]) {
      const pane = frame(name);
      expect(loadingGuard(pane), name).toBe(true);
      expect(backend.getReadyPattern().test(pane), name).toBe(false);
      expect(backend.isDeliveryInputReadyPane(pane), name).toBe(false);
    }
    expect(frame("resume-loading")).toMatch(/ {2}Resuming session…\n+› Ask Codex to do anything\n+ {2}\? for shortcuts\n*$/);
  });

  it("the settled session after it is not held", () => {
    expect(loadingGuard(frame("resumed"))).toBe(false);
  });

  it.each([
    ["a settled session's footer (the status line's session id above the hints)", (p: string) => p.replace("  ? for shortcuts", "  00000000-0000-0000-0000-000000000000\n  ← for agents · ? for shortcuts")],
    ["any other row under the composer", (p: string) => p.replace("  ? for shortcuts", "  tab to queue message")],
    ["the hint plus another row", (p: string) => p.replace("  ? for shortcuts", "  ? for shortcuts\n  something else")],
    ["the hint with other text on its row", (p: string) => p.replace("  ? for shortcuts", "  ? for shortcuts · esc to interrupt")],
    ["the hint not indented as the TUI draws it", (p: string) => p.replace("  ? for shortcuts", "? for shortcuts")],
  ])("is NOT read as loading when %s", (_why, edit) => {
    const pane = edit(frame("resume-loading"));
    expect(pane).not.toBe(frame("resume-loading"));
    expect(loadingGuard(pane)).toBe(false);
  });
});
