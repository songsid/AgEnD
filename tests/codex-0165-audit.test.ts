/**
 * Codex 0.164.0 → 0.165.0 audit (decision ffb8104e): native frames from the committed rig (scripts/manual/codex-version-audit,
 * pass1 + pass2) — scratch npm prefixes, scratch HOMEs, a private tmux socket, the mock Responses API; no account. Each
 * fixture is one frame per surface, normalised (paths, ports, ids, clock times). Verdict and sources:
 * tests/fixtures/codex-audit-0165/README.md.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex165-")));
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0165/${v}/${name}.pane.txt`, import.meta.url), "utf8");
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
const VERSIONS = ["01640", "01650"];

describe("Codex 0.165.0 versus 0.164.0 native surfaces", () => {
  it.each(["idle", "near-suppressed", "usage", "capacity", "model-not-found", "resumed", "resumed-turn", "rate-dismissed"])("%s remains an ordinary composer", name => {
    for (const v of VERSIONS) expect(reading(frame(v, name)), v).toEqual(IDLE);
  });

  it("busy stays distinct from idle, and resume-loading cannot accept input", () => {
    for (const v of VERSIONS) {
      expect(reading(frame(v, "busy")), v).toEqual({ ...IDLE, busy: true });
      expect(reading(frame(v, "resume-loading")), v).toMatchObject({ ...HOLD, resume: true });
    }
  });

  // hmsg-53600a2c: an AgEnD session always trusts its folder — Enter on "Trust and continue", the only key-sending entry.
  it("folder trust is answered Trust, never held", () => {
    const AUTO_TRUST = { description: "Codex folder trust — trusting the agent's own folder", keys: ["Enter"], holdOnly: false };
    for (const v of VERSIONS) {
      const value = reading(frame(v, "trust"));
      expect(value, v).toMatchObject(HOLD);
      for (const table of [value.runtime, value.startup]) {
        expect(table[0], v).toEqual(AUTO_TRUST);
        expect(table.filter(d => d.keys.length > 0), v).toEqual([AUTO_TRUST]);
      }
    }
    expect(reading(frame("01650", "trust"))).toEqual(reading(frame("01640", "trust")));
  });

  it("the rate-limit picker is still dismissed with Escape only", () => {
    for (const v of VERSIONS) {
      const value = reading(frame(v, "rate-picker"));
      expect(value, v).toMatchObject(HOLD);
      expect(value.runtime[0]).toEqual({ description: "Codex rate-limit model-switch picker — Escape keeps the current model", keys: ["Escape"], holdOnly: false });
      expect(value.runtime.filter(d => d.keys.length > 0)).toHaveLength(1);
    }
  });

  it("the turn's own error rows read the same: usage → quota pause, capacity → nudge", () => {
    for (const v of VERSIONS) {
      expect(errors(lastErrorRow(frame(v, "usage"))), v).toEqual(["quota/pause"]);
      expect(errors(lastErrorRow(frame(v, "capacity"))), v).toEqual(["model_error/nudge_continue"]);
    }
  });

  it("#56445: a provider's model_not_found is no longer retried; its message shows as is — and neither form is detected (unchanged)", () => {
    const before = lastErrorRow(frame("01640", "model-not-found"));
    const after = lastErrorRow(frame("01650", "model-not-found"));
    expect(before).toMatch(/^■ unexpected status 404 Not Found: The model `gpt-audit-missing` does not exist/);
    expect(after).toBe("■ The model `gpt-audit-missing` does not exist or you do not have access to it.");
    expect(errors(before)).toEqual([]);
    expect(errors(after)).toEqual([]);
  });

  it("the banners name the versions", () => {
    expect(frame("01640", "idle")).toContain("OpenAI Codex (v0.164.0)");
    expect(frame("01650", "idle")).toContain("OpenAI Codex (v0.165.0)");
  });
});
