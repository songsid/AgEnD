/**
 * Codex 0.165.0 → 0.166.0 audit (decision ffb8104e): native frames from the committed rig (scripts/manual/codex-version-audit,
 * pass1 + pass2) — scratch npm prefixes, scratch HOMEs, a private tmux socket, the mock Responses API, no network
 * (`unshare -rn`), no account. Each fixture is one frame per surface, normalised (paths, port, clock times). Verdict and
 * sources: tests/fixtures/codex-audit-0166/README.md.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex166-")));
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0166/${v}/${name}.pane.txt`, import.meta.url), "utf8");
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
const HOLD = { ready: false, busy: false, deliverable: false, resume: false };
const VERSIONS = ["01650", "01660"];
const SURFACES = ["idle", "busy", "near-suppressed", "usage", "ws-credits", "ws-credits-dismissed", "ws-spend", "ws-spend-dismissed", "capacity",
  "model-not-found", "resume-loading", "resumed", "resumed-turn", "trust", "rate-picker", "rate-dismissed", "approval"];

describe("Codex 0.166.0 versus 0.165.0 native surfaces", () => {
  it.each(SURFACES)("%s reads the same on both versions", name => {
    expect(reading(frame("01660", name))).toEqual(reading(frame("01650", name)));
  });

  it.each(["idle", "near-suppressed", "usage", "ws-credits-dismissed", "ws-spend-dismissed", "capacity", "model-not-found", "resumed", "resumed-turn", "rate-dismissed"])(
    "%s remains an ordinary composer", name => {
      for (const v of VERSIONS) expect(reading(frame(v, name)), v).toEqual(IDLE);
    });

  it("busy stays distinct from idle, and resume-loading cannot accept input", () => {
    for (const v of VERSIONS) {
      expect(reading(frame(v, "busy")), v).toEqual({ ...IDLE, busy: true });
      expect(reading(frame(v, "resume-loading")), v).toMatchObject({ ...HOLD, resume: true });
    }
  });

  it("0.166's one new frame — a bare composer for a moment after the resume transient — is never taken for a ready pane", () => {
    const pane = frame("01660", "resume-redraw");
    expect(pane.trim()).toBe("› Ask Codex to do anything");
    expect(reading(pane)).toMatchObject({ ready: false, deliverable: false, runtime: [], startup: [] });
  });

  // hmsg-53600a2c: an AgEnD session always trusts its folder; an approval is still held for a person.
  it("folder trust is answered Trust; an approval is still held without automatic confirmation", () => {
    const AUTO_TRUST = { description: "Codex folder trust — trusting the agent's own folder", keys: ["Enter"], holdOnly: false };
    for (const v of VERSIONS) {
      const value = reading(frame(v, "trust"));
      expect(value, v).toMatchObject(HOLD);
      for (const table of [value.runtime, value.startup]) {
        expect(table[0], v).toEqual(AUTO_TRUST);
        expect(table.filter(d => d.keys.length > 0), v).toEqual([AUTO_TRUST]);
      }
    }
    for (const v of VERSIONS) for (const name of ["approval"]) {
      const value = reading(frame(v, name));
      expect(value, `${v} ${name}`).toMatchObject(HOLD);
      expect(value.runtime.length, `${v} ${name}`).toBeGreaterThan(0);
      for (const d of [...value.runtime, ...value.startup]) expect(d, `${v} ${name}`).toMatchObject({ keys: [], holdOnly: true });
    }
  });

  it("the workspace-limit prompts (#2847) and the rate-limit picker are still dismissed with Escape only", () => {
    for (const v of VERSIONS) {
      for (const name of ["ws-credits", "ws-spend"]) {
        const value = reading(frame(v, name));
        expect(value, `${v} ${name}`).toMatchObject(HOLD);
        expect(value.runtime.filter(d => d.keys.length > 0).map(d => d.keys), `${v} ${name}`).toEqual([["Escape"]]);
      }
      const picker = reading(frame(v, "rate-picker"));
      expect(picker, v).toMatchObject(HOLD);
      expect(picker.runtime.filter(d => d.keys.length > 0).map(d => d.keys), v).toEqual([["Escape"]]);
    }
  });

  it("the turn's own error rows read the same: usage and workspace limits → quota pause, capacity → nudge", () => {
    for (const v of VERSIONS) {
      for (const name of ["usage", "ws-credits", "ws-spend"]) expect(errors(lastErrorRow(frame(v, name))), `${v} ${name}`).toEqual(["quota/pause"]);
      expect(errors(lastErrorRow(frame(v, "capacity"))), v).toEqual(["model_error/nudge_continue"]);
      expect(errors(lastErrorRow(frame(v, "model-not-found"))), v).toEqual([]);
    }
  });

  it("the banners name the versions", () => {
    expect(frame("01650", "idle")).toContain("OpenAI Codex (v0.165.0)");
    expect(frame("01660", "idle")).toContain("OpenAI Codex (v0.166.0)");
  });
});
