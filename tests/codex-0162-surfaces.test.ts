/**
 * codex 0.162.0 audit (the host runs 0.160.0). Every surface AgEnD reads was captured live from the real 0.160.0 and
 * 0.162.0 binaries in the same run of scripts/manual/codex-version-audit: AgEnD's production writeConfig +
 * buildCommand, a private tmux socket, a mock Responses API, no account. tests/fixtures/codex-audit-0162/{v0160,v0162}
 * hold one frame per surface from each version; only scratch paths are replaced. Each 0.162 frame must read exactly
 * like its 0.160 twin under the production predicates, AND like what AgEnD needs there (so a change both versions
 * share cannot hide).
 *
 * Two 0.162 differences needed production rules and carry their own fixtures: the Control key label (`^c`, #1443 —
 * session lock and resume-cwd picker) and the Luna Reserve picker's server buttons (#1439, every version).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const frame = (version: "v0160" | "v0162", name: string) =>
  readFileSync(new URL(`./fixtures/codex-audit-0162/${version}/${name}.pane.txt`, import.meta.url), "utf8");
// The rig's instance config: AgEnD's own (context status line), as the production launch writes it.
const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-0162-")));
const runtime = backend.getRuntimeDialogs(), startup = backend.getStartupDialogs();
const active = (d: any, pane: string) => (d.isActive ? d.isActive(pane) : d.pattern.test(pane));

/** What the daemon reads from one capture with the production predicates. */
function reading(pane: string) {
  return {
    ready: backend.getReadyPattern().test(pane),
    busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane),
    resumeLoading: backend.getInputUnavailableTransients().some(t => t.isActive(pane)),
    runtimeDialog: runtime.find(d => active(d, pane))?.description ?? null,
    startupDialog: startup.find(d => active(d, pane))?.description ?? null,
    errors: [...new Set(backend.getErrorPatterns().filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(pane); }).map(p => p.type))].sort(),
  };
}

const IDLE = { ready: true, busy: false, deliverable: true, resumeLoading: false, runtimeDialog: null, startupDialog: null };
const TRUST = "Codex folder trust needs human confirmation";
const PICKER = "Codex rate-limit model-switch picker — Escape keeps the current model";
const UNKNOWN = "Codex interactive selection needs human input";

describe("codex 0.162.0 reads like 0.160.0 on every captured surface", () => {
  it.each([
    ["idle", IDLE],
    ["busy", { ready: true, busy: true, deliverable: true, runtimeDialog: null }],
    ["turn-idle", IDLE],
    ["resume-loading", { ready: false, busy: false, deliverable: false, resumeLoading: true, runtimeDialog: null }],
    ["resumed", IDLE],
    ["usage-limit-error", { ...IDLE }],
    ["auth-401", { ...IDLE }],
    ["server-500", { ...IDLE }],
    ["model-capacity", { ...IDLE }],
    ["compact-with-args-is-a-chat-message", IDLE],
    ["trust-prompt-git", { ready: false, deliverable: false, runtimeDialog: TRUST, startupDialog: TRUST }],
    ["untrusted-plain-dir-no-prompt", IDLE],
    ["rate-limit-picker", { ready: false, deliverable: false, runtimeDialog: PICKER, startupDialog: PICKER }],
    ["rate-limit-picker-80x24", { ready: false, deliverable: false, runtimeDialog: PICKER, startupDialog: PICKER }],
    ["rate-limit-dismissed", IDLE],
    ["login", { ready: false, deliverable: false, runtimeDialog: UNKNOWN, startupDialog: UNKNOWN }],
  ])("%s", (name, expected) => {
    const v0162 = frame("v0162", name), v0160 = frame("v0160", name);
    expect(reading(v0162)).toEqual(reading(v0160));
    expect(reading(v0162)).toMatchObject(expected);
  });

  it.each([
    ["usage-limit-error", "quota"],
    ["auth-401", "auth_error"],
    ["model-capacity", "model_error"],
  ])("the %s turn's error line is recognised (%s) on both", (name, type) => {
    for (const version of ["v0160", "v0162"] as const) expect(reading(frame(version, name)).errors, version).toContain(type);
  });

  it("the frames are what they say: the version in the header where it is on screen", () => {
    for (const name of ["idle", "resume-loading", "untrusted-plain-dir-no-prompt"]) {
      expect(frame("v0162", name), name).toContain("OpenAI Codex (v0.162.0)");
      expect(frame("v0160", name), name).toContain("OpenAI Codex (v0.160.0)");
    }
  });
});
