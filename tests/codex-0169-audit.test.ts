/**
 * Codex 0.167.2 → 0.169.0 audit: native frames from the committed rig (scripts/manual/codex-version-audit, pass1 + pass2) —
 * scratch npm prefixes, scratch HOMEs, a private tmux socket, the mock Responses API, no network (`unshare -rn`), no
 * account — plus the sign-in screens from an empty home. Each fixture is one frame per surface, normalised (paths, port,
 * ids, clock times). Verdict and sources: tests/fixtures/codex-audit-0169/README.md.
 *
 * The one change AgEnD needed: 0.169's resume-loading screen shows the bare shortcut hint `  ? for shortcuts` under the
 * composer, and the resume-in-progress input guard (codexUnboxedResumeLoading) required the composer to be the last
 * thing on screen, so it no longer fired. The frame was still not ready (nothing was delivered into it), so this restores
 * the guard rather than fixing a live misdelivery.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex169-")));
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0169/${v}/${name}.pane.txt`, import.meta.url), "utf8");
const active = (d: any, pane: string) => d.isActive ? d.isActive(pane) : d.pattern.test(pane);
function reading(pane: string) {
  const dialogs = (entries: readonly any[]) => entries.filter(d => active(d, pane)).map(d => ({ description: d.description, keys: d.keys, holdOnly: !!d.holdOnly }));
  return { ready: backend.getReadyPattern().test(pane), busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane), resume: backend.getInputUnavailableTransients().some(t => t.isActive(pane)),
    runtime: dialogs(backend.getRuntimeDialogs()), startup: dialogs(backend.getStartupDialogs()) };
}
/** The turn's own error row: the last `■ …` block of the frame (earlier rows are history from previous mock modes). */
function lastErrorRow(pane: string): string {
  const lines = pane.split("\n");
  const at = lines.map((l, i) => (/^■ /.test(l) ? i : -1)).filter(i => i >= 0).pop()!;
  const out = [lines[at]!];
  for (let i = at + 1; i < lines.length && lines[i]!.trim() && !/^[›•■⚠]/.test(lines[i]!.trimStart()); i++) out.push(lines[i]!);
  return out.join("\n");
}
const errors = (row: string) => backend.getErrorPatterns()
  .filter(p => new RegExp(p.pattern.source, p.pattern.flags.replace("g", "")).test(row)).map(p => `${p.type}/${p.action}`);
const IDLE = { ready: true, busy: false, deliverable: true, resume: false, runtime: [], startup: [] };
const VERSIONS = ["01672", "01690"];
const SURFACES = ["idle", "busy", "near-suppressed", "usage", "ws-credits", "ws-credits-dismissed", "ws-spend", "ws-spend-dismissed", "capacity",
  "model-not-found", "resume-loading", "resumed", "resumed-turn", "trust", "rate-picker", "rate-dismissed", "signin-menu", "signin-another-way"];

describe("Codex 0.169.0 versus 0.167.2 native surfaces", () => {
  it.each(SURFACES)("%s reads the same on both versions", name => {
    expect(reading(frame("01690", name))).toEqual(reading(frame("01672", name)));
  });

  it.each(["idle", "near-suppressed", "usage", "ws-credits-dismissed", "ws-spend-dismissed", "capacity", "model-not-found", "resumed", "resumed-turn", "rate-dismissed"])(
    "%s remains an ordinary composer", name => {
      for (const v of VERSIONS) expect(reading(frame(v, name)), v).toEqual(IDLE);
    });

  it("busy stays distinct from idle, and resume-loading cannot accept input", () => {
    for (const v of VERSIONS) {
      expect(reading(frame(v, "busy")), v).toEqual({ ...IDLE, busy: true });
      expect(reading(frame(v, "resume-loading")), v).toMatchObject({ ready: false, deliverable: false, resume: true });
    }
  });

  it("the usage-limit and workspace rows still classify as quota; capacity and model-not-found as before", () => {
    for (const v of VERSIONS) {
      expect(errors(lastErrorRow(frame(v, "usage"))), v).toContain("quota/pause");
      expect(errors(lastErrorRow(frame(v, "capacity"))), v).toEqual(errors(lastErrorRow(frame("01672", "capacity"))));
      expect(errors(lastErrorRow(frame(v, "model-not-found"))), v).toEqual(errors(lastErrorRow(frame("01672", "model-not-found"))));
    }
  });

  it("the trust prompt is still answered Trust (Enter); the rate-limit picker still gets its Escape", () => {
    for (const v of VERSIONS) {
      expect(reading(frame(v, "trust")).runtime.find(d => d.description === "Codex folder trust — trusting the agent's own folder"), v)
        .toEqual({ description: "Codex folder trust — trusting the agent's own folder", keys: ["Enter"], holdOnly: false });
      expect(reading(frame(v, "rate-picker")).runtime.some(d => d.keys.includes("Escape")), v).toBe(true);
    }
  });
});

describe("0.169's resume-loading screen: `? for shortcuts` under the composer", () => {
  const loading = frame("01690", "resume-loading");
  it("is the new layout (0.167.2's loading screen ends at the composer)", () => {
    expect(loading).toMatch(/ {2}Resuming session…\n+› Ask Codex to do anything\n+ {2}\? for shortcuts\n*$/);
    expect(frame("01672", "resume-loading")).toMatch(/ {2}Resuming session…\n+› Ask Codex to do anything\n*$/);
  });

  it.each([
    ["a settled session's footer (the status line's session id above the hints)", (p: string) => p.replace("  ? for shortcuts", "  00000000-0000-0000-0000-000000000000\n  ← for agents · ? for shortcuts")],
    ["any other row under the composer", (p: string) => p.replace("  ? for shortcuts", "  tab to queue message")],
    ["the hint plus another row", (p: string) => p.replace("  ? for shortcuts", "  ? for shortcuts\n  something else")],
    ["the hint with other text on its row", (p: string) => p.replace("  ? for shortcuts", "  ? for shortcuts · esc to interrupt")],
    ["the hint not indented as the TUI draws it", (p: string) => p.replace("  ? for shortcuts", "? for shortcuts")],
  ])("is NOT read as loading when %s", (_why, edit) => {
    const pane = edit(loading);
    expect(pane).not.toBe(loading);
    expect(backend.getInputUnavailableTransients().some(t => t.isActive(pane))).toBe(false);
  });
});

describe("0.169's sign-in screens", () => {
  it("are unchanged offline: the menu is held for a human; the sub-menu is not ready and holds nothing", () => {
    for (const name of ["signin-menu", "signin-another-way"]) expect(frame("01690", name)).toBe(frame("01672", name));
    for (const v of VERSIONS) {
      expect(reading(frame(v, "signin-menu")), v).toMatchObject({ ready: false, deliverable: false });
      expect(reading(frame(v, "signin-menu")).runtime.length, v).toBeGreaterThan(0);
      expect(reading(frame(v, "signin-another-way")), v).toEqual({ ready: false, busy: false, deliverable: false, resume: false, runtime: [], startup: [] });
    }
  });
});
