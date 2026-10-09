/**
 * codex 0.162.0 audit (the host runs 0.160.0). Every surface AgEnD reads was captured live from the real 0.160.0 and
 * 0.162.0 binaries in the same run of scripts/manual/codex-version-audit: AgEnD's production writeConfig +
 * buildCommand, a private tmux socket, a mock Responses API, no account. tests/fixtures/codex-audit-0162/{v0160,v0162}
 * hold one frame per surface from each version; only scratch paths are replaced. Each 0.162 frame must read exactly
 * like its 0.160 twin under the production predicates, AND like what AgEnD needs there (so a change both versions
 * share cannot hide). A dialog is compared by what it DOES — keys and hold/block flags — not only by its name.
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
const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-0162-")));
const runtime = backend.getRuntimeDialogs(), startup = backend.getStartupDialogs();
const active = (d: any, pane: string) => (d.isActive ? d.isActive(pane) : d.pattern.test(pane));

/** The first dialog of a table the daemon would act on, with everything that decides what it does to the pane. */
function acting(table: readonly any[], pane: string) {
  const d = table.find(entry => active(entry, pane));
  return d ? { description: d.description, keys: d.keys, holdOnly: !!d.holdOnly, blocksDelivery: !!d.blocksDelivery, inputBlocked: !!d.inputBlocked } : null;
}

/** What the daemon reads from one capture with the production predicates. */
function reading(pane: string) {
  return {
    ready: backend.getReadyPattern().test(pane),
    busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane),
    resumeLoading: backend.getInputUnavailableTransients().some(t => t.isActive(pane)),
    runtimeDialog: acting(runtime, pane),
    startupDialog: acting(startup, pane),
  };
}

/**
 * The failed turn's own output: the rows between its `› <message>` and the composer. Earlier warnings in the
 * transcript (the "⚠ Heads up, … less than 5% …" quota notices) are not part of it, so they cannot satisfy a check.
 */
function lastTurnOutput(pane: string): string {
  const rows = pane.replace(/\r/g, "").split("\n");
  const lastIndex = (test: (row: string, index: number) => boolean) => {
    for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i]!, i)) return i;
    return -1;
  };
  const composer = lastIndex(r => /^› Ask Codex to do anything/.test(r));
  const message = lastIndex((r, i) => i < composer && /^› (?!Ask Codex to do anything)\S/.test(r));
  expect(composer, "composer row").toBeGreaterThan(0);
  expect(message, "the turn's message row").toBeGreaterThanOrEqual(0);
  return rows.slice(message + 1, composer).join("\n");
}
/** Error patterns that fire on the failed turn's own output, as type/action pairs. */
function turnErrors(pane: string): string[] {
  const out = lastTurnOutput(pane);
  return [...new Set(backend.getErrorPatterns()
    .filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(out); })
    .map(p => `${p.type}/${p.action}`))].sort();
}

const HOLD = { keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true };
const IDLE = { ready: true, busy: false, deliverable: true, resumeLoading: false, runtimeDialog: null, startupDialog: null };
const TRUST = { description: "Codex folder trust needs human confirmation", ...HOLD };
const PICKER = { description: "Codex rate-limit model-switch picker — Escape keeps the current model", keys: ["Escape"], holdOnly: false, blocksDelivery: true, inputBlocked: true };
const UNKNOWN = { description: "Codex interactive selection needs human input", ...HOLD };

describe("codex 0.162.0 reads like 0.160.0 on every captured surface", () => {
  it.each([
    ["idle", IDLE],
    ["busy", { ready: true, busy: true, deliverable: true, runtimeDialog: null, startupDialog: null }],
    ["turn-idle", IDLE],
    ["resume-loading", { ready: false, busy: false, deliverable: false, resumeLoading: true, runtimeDialog: null, startupDialog: null }],
    ["resumed", IDLE],
    ["usage-limit-error", IDLE],
    ["auth-401", IDLE],
    ["server-500", IDLE],
    ["model-capacity", IDLE],
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
    ["usage-limit-error", ["quota/pause"]],
    ["auth-401", ["auth_error/pause"]],
    ["model-capacity", ["model_error/nudge_continue"]],
  ])("the %s turn's own error row is recognised, with its action (%j), on both", (name, expected) => {
    for (const version of ["v0160", "v0162"] as const) {
      const out = lastTurnOutput(frame(version, name));
      expect(out, version).toMatch(/^■ /m);
      expect(out, version).not.toContain("Heads up");
      expect(turnErrors(frame(version, name)), version).toEqual(expected);
    }
  });

  it("the frames are what they say: the version in the header where it is on screen", () => {
    for (const name of ["idle", "resume-loading", "untrusted-plain-dir-no-prompt"]) {
      expect(frame("v0162", name), name).toContain("OpenAI Codex (v0.162.0)");
      expect(frame("v0160", name), name).toContain("OpenAI Codex (v0.160.0)");
    }
  });
});
