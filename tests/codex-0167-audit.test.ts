/**
 * Codex 0.166.0 → 0.167.0 audit (decision ffb8104e): native frames from the committed rig (scripts/manual/codex-version-audit,
 * pass1 + pass2) — scratch npm prefixes, scratch HOMEs, a private tmux socket, the mock Responses API, no network
 * (`unshare -rn`), no account — plus the sign-in screens from an empty home. Each fixture is one frame per surface,
 * normalised (paths, port, clock times). Verdict and sources: tests/fixtures/codex-audit-0167/README.md.
 *
 * The one change AgEnD needed: 0.167's startup folder-trust screen offers "2. Back to Agent Command Center" with the
 * footer "enter continue · esc back" (0.166: "2. Quit" / "esc quit"), and the auto-trust answer (#2893, the user's
 * decision hmsg-53600a2c) held every such prompt for a human.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex167-")));
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0167/${v}/${name}.pane.txt`, import.meta.url), "utf8");
/** The frame's text rows without blank ones, for layout assertions. */
const rows = (v: string, name: string) => frame(v, name).split("\n").filter(l => l.trim()).join("\n");
const active = (d: any, pane: string) => d.isActive ? d.isActive(pane) : d.pattern.test(pane);
function reading(pane: string) {
  const dialogs = (entries: readonly any[]) => entries.filter(d => active(d, pane)).map(d => ({ description: d.description, keys: d.keys, holdOnly: !!d.holdOnly }));
  return { ready: backend.getReadyPattern().test(pane), busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane), resume: backend.getInputUnavailableTransients().some(t => t.isActive(pane)),
    runtime: dialogs(backend.getRuntimeDialogs()), startup: dialogs(backend.getStartupDialogs()) };
}
/** The remote selection card a held dialog would offer for this frame (null: none — the sign-in screen never gets one). */
const cards = (pane: string) => [...backend.getRuntimeDialogs(), ...backend.getStartupDialogs()]
  .filter((d: any) => active(d, pane) && d.remoteCard).map((d: any) => d.remoteCard(pane));
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
const VERSIONS = ["01660", "01670"];
const SURFACES = ["idle", "busy", "near-suppressed", "usage", "ws-credits", "ws-credits-dismissed", "ws-spend", "ws-spend-dismissed", "capacity",
  "model-not-found", "resume-loading", "resumed", "resumed-turn", "trust", "rate-picker", "rate-dismissed", "signin-menu", "signin-another-way"];

describe("Codex 0.167.0 versus 0.166.0 native surfaces", () => {
  it.each(SURFACES)("%s reads the same on both versions", name => {
    expect(reading(frame("01670", name))).toEqual(reading(frame("01660", name)));
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
      expect(errors(lastErrorRow(frame(v, "capacity"))), v).toEqual(errors(lastErrorRow(frame("01660", "capacity"))));
      expect(errors(lastErrorRow(frame(v, "model-not-found"))), v).toEqual(errors(lastErrorRow(frame("01660", "model-not-found"))));
    }
  });
});

describe("0.167's folder-trust screen: 'Back to Agent Command Center' / 'esc back'", () => {
  it("is the new layout (0.166 shows 'Quit' / 'esc quit')", () => {
    expect(rows("01670", "trust")).toMatch(/› 1\. Trust and continue\n {2}2\. Back to Agent Command Center\n {2}enter continue · esc back/);
    expect(rows("01660", "trust")).toMatch(/› 1\. Trust and continue\n {2}2\. Quit\n {2}enter continue · esc quit/);
  });

  it("is answered Trust on both versions — Enter on the highlighted 'Trust and continue', exactly as before", () => {
    for (const v of VERSIONS) {
      const auto = reading(frame(v, "trust")).runtime.find(d => d.description === "Codex folder trust — trusting the agent's own folder");
      expect(auto, v).toEqual({ description: "Codex folder trust — trusting the agent's own folder", keys: ["Enter"], holdOnly: false });
    }
  });

  it.each([
    ["the cancel option and footer do not pair (Back + esc quit)", (p: string) => p.replace("esc back", "esc quit")],
    ["the cancel option and footer do not pair (Quit + esc back)", (p: string) => p.replace("Back to Agent Command Center", "Quit")],
    ["both cancel options at once", (p: string) => p.replace("2. Back to Agent Command Center", "2. Back to Agent Command Center\n  3. Quit")],
    ["the cursor is on the cancel option", (p: string) => p.replace("› 1. Trust and continue\n  2. Back", "  1. Trust and continue\n› 2. Back")],
    ["an unknown cancel option", (p: string) => p.replace("Back to Agent Command Center", "Back to somewhere else")],
  ])("is held for a human, never pressed, when %s", (_why, edit) => {
    const pane = edit(frame("01670", "trust"));
    expect(reading(pane).runtime.map(d => d.description)).not.toContain("Codex folder trust — trusting the agent's own folder");
    expect(reading(pane).runtime.map(d => d.description)).toContain("Codex folder trust needs human confirmation");
  });
});

describe("0.167's sign-in: 'Sign in another way' replaces the API-key and provider rows", () => {
  it("the main menu now ends with '3. Sign in another way'; the API key and Bedrock moved into that sub-menu", () => {
    expect(frame("01670", "signin-menu")).toMatch(/3\. Sign in another way/);
    expect(frame("01670", "signin-menu")).not.toMatch(/Use an OpenAI API key/);
    expect(rows("01670", "signin-another-way")).toMatch(/Sign in another way\n> 1\. Use an OpenAI API key[\s\S]*2\. Use Amazon Bedrock/);
  });

  it("reads as before: the menu is held for a human with no selection card; the sub-menu is not ready and holds nothing", () => {
    for (const v of VERSIONS) {
      expect(reading(frame(v, "signin-menu")), v).toMatchObject({ ready: false, deliverable: false });
      expect(reading(frame(v, "signin-menu")).runtime.length, v).toBeGreaterThan(0);
      expect(cards(frame(v, "signin-menu")), v).toEqual(cards(frame(v, "signin-menu")).map(() => null));
      expect(reading(frame(v, "signin-another-way")), v).toEqual({ ready: false, busy: false, deliverable: false, resume: false, runtime: [], startup: [] });
      expect(cards(frame(v, "signin-another-way")), v).toEqual([]);
    }
  });
});
