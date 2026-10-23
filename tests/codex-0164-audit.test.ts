/** Native mock-provider captures, private prefixes/HOMEs/tmux/netns; no account. */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex164-")));
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0164/${v}/${name}.pane.txt`, import.meta.url), "utf8");
const active = (d: any, pane: string) => d.isActive ? d.isActive(pane) : d.pattern.test(pane);
function reading(pane: string) {
  const dialogs = (entries: readonly any[]) => entries.filter(d => active(d, pane)).map(d => ({ description: d.description, keys: d.keys, holdOnly: !!d.holdOnly }));
  return { ready: backend.getReadyPattern().test(pane), busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane), resume: backend.getInputUnavailableTransients().some(t => t.isActive(pane)),
    runtime: dialogs(backend.getRuntimeDialogs()), startup: dialogs(backend.getStartupDialogs()) };
}
const IDLE = { ready: true, busy: false, deliverable: true, resume: false, runtime: [], startup: [] };
const HOLD = { ready: false, busy: false, deliverable: false, resume: false };
describe("Codex 0.164.0 versus 0.163.0 native surfaces", () => {
  it.each(["idle", "turn-idle", "near-suppressed", "usage", "rate429", "insufficient", "resumed", "resumed-turn", "rate-dismissed", "permission-dismissed", "approval-declined"])("%s remains an ordinary composer", name => {
    expect(reading(frame("01640", name))).toEqual(IDLE);
    expect(reading(frame("01630", name))).toEqual(IDLE);
  });
  it("busy stays distinct from idle, and resume-loading cannot accept input", () => {
    for (const v of ["01630", "01640"]) {
      expect(reading(frame(v, "busy"))).toEqual({ ...IDLE, busy: true });
      expect(reading(frame(v, "resume-loading"))).toEqual({ ...HOLD, resume: true, runtime: [], startup: [] });
    }
  });
  it.each(["trust", "onboarding", "permissions-picker", "queued-permission", "tool-approval", "resume-picker"])("%s is held without automatic confirmation", name => {
    for (const v of ["01630", "01640"]) {
      const value = reading(frame(v, name));
      expect(value).toMatchObject(HOLD);
      expect(value.runtime.length).toBeGreaterThan(0); expect(value.startup.length).toBeGreaterThan(0);
      for (const d of [...value.runtime, ...value.startup]) expect(d).toMatchObject({ keys: [], holdOnly: true });
    }
    expect(reading(frame("01640", name))).toEqual(reading(frame("01630", name)));
  });
  it("the existing rate picker rule only dismisses with Escape", () => {
    for (const v of ["01630", "01640"]) {
      const value = reading(frame(v, "rate-picker"));
      expect(value).toMatchObject(HOLD);
      for (const table of [value.runtime, value.startup]) {
        expect(table[0]).toEqual({ description: "Codex rate-limit model-switch picker — Escape keeps the current model", keys: ["Escape"], holdOnly: false });
        expect(table.filter(d => d.keys.length > 0)).toHaveLength(1);
      }
      expect(frame(v, "rate-picker")).toContain("Approaching rate limits");
    }
  });
  it("the fresh default Bedrock option changes login choices, not configured-provider startup", () => {
    expect(frame("01640", "onboarding")).toContain("4. Use Amazon Bedrock");
    expect(frame("01630", "onboarding")).not.toContain("Use Amazon Bedrock");
    expect(frame("01640", "idle")).toContain("OpenAI Codex (v0.164.0)");
    expect(frame("01630", "idle")).toContain("OpenAI Codex (v0.163.0)");
    expect(frame("01640", "tool-approval")).toContain("Would you like to run the following command?");
    expect(frame("01640", "tool-approval")).toContain("$ echo probe");
    expect(frame("01640", "resume-picker")).toContain("Working directory · resume");
  });
  it("queues a message behind the permission selection and submits one turn after dismissal", () => {
    const log = readFileSync(new URL("./fixtures/codex-audit-0164/queue-receipts.log.txt", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("./fixtures/codex-audit-0164/capture-manifest.json", import.meta.url), "utf8"));
    for (const v of ["01630", "01640"]) {
      expect(log).toContain(`queued-request-held ${v === "01630" ? "0.163.0" : "0.164.0"}`);
      expect(log).toContain(`queued-request-delivered ${v === "01630" ? "0.163.0" : "0.164.0"}`);
      expect(manifest[v].queueReceipt).toMatchObject({ heldBeforeDismissal: true, queuedTurnRequests: 1 });
      expect(frame(v, "queued-permission")).toContain("Update Model Permissions");
      expect(frame(v, "permission-dismissed")).toContain("› queued audit request");
      expect(frame(v, "permission-dismissed")).toContain("• ok");
    }
  });
  it.each([["usage", "quota/pause"], ["insufficient", "quota/pause"], ["rate429", "rate_limit/nudge_continue"]])("%s keeps its own classification, excluding historical rows", (name, error) => {
    for (const v of ["01630", "01640"]) {
      const pane = frame(v, name), rows = pane.split("\n");
      let composer = -1, input = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (composer < 0 && /^› Ask Codex/.test(rows[i])) composer = i;
        else if (composer >= 0 && /^› audit /.test(rows[i])) { input = i; break; }
      }
      expect(composer).toBeGreaterThan(input); expect(input).toBeGreaterThanOrEqual(0);
      const output = rows.slice(input + 1, composer).join("\n");
      expect(output).toMatch(/^■ /m); expect(output).not.toContain("Heads up");
      expect([...new Set(backend.getErrorPatterns().filter(p => p.pattern.test(output)).map(p => `${p.type}/${p.action}`))]).toEqual([error]);
    }
  });
  it("the unchanged internal reset timeout is not standalone pane chrome or a model failure", () => {
    const text = "rate limit reset consume timed out";
    expect(reading(text)).toMatchObject({ ready: false, busy: false, deliverable: false, runtime: [], startup: [] });
    expect(backend.getErrorPatterns().filter(p => p.pattern.test(text))).toEqual([]);
    const presence = JSON.parse(readFileSync(new URL("./fixtures/codex-audit-0164/literal-presence.json", import.meta.url), "utf8"));
    for (const v of ["0.163.0", "0.164.0"]) expect(presence[v].literals[text]).toBe(true);
  });
});
