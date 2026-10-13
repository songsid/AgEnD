/**
 * #1218 PR4: a kiro Log shows fleet events only, with the reason, until the launch's root AND the conversation the
 * instance is in now are both proven (the leader's ruling, 2026-10-13; #849 root, #1789 current conversation). These
 * tests pin that the gate is closed today for every launch there is, and say why for each.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KIRO_LOG_PROOFS_TODAY, kiroLogGate, type KiroLogLaunch } from "../src/kiro-log-gate.js";
import { KiroBackend } from "../src/backend/kiro.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";

const launch = (engine: KiroLogLaunch["engine"], mode: KiroLogLaunch["mode"], credentialProfile: string | null = null): KiroLogLaunch => ({ engine, mode, credentialProfile });

describe("the kiro Log gate: closed today, with the reason", () => {
  it.each([
    ["no launch (not running)", null, "kiro_not_running"],
    ["V3", launch("v3", "resume", "p"), "kiro_v3"],
    ["an unknown engine", launch(null, "resume", "p"), "kiro_engine_unknown"],
    ["legacy mode, even with its engine pinned", launch("v1", "legacy", "p"), "kiro_legacy"],
    ["a fresh launch", launch("v2", "fresh", "p"), "kiro_fresh"],
    ["TUI (v2), resumed: its KIRO_HOME is inherited, a profile does not set it", launch("v2", "resume", "p"), "kiro_v2_root"],
    ["classic (v1), resumed, no profile: its store is inherited", launch("v1", "resume"), "kiro_no_profile"],
    ["classic (v1), resumed, with a profile — the root is proven, the current conversation is not", launch("v1", "resume", "p"), "kiro_session_unobservable"],
  ] as const)("%s", (_n, l, reason) => {
    expect(kiroLogGate(l)).toEqual({ open: false, reason });
  });

  it("with today's proofs, no launch of any engine, mode or profile opens it", () => {
    for (const engine of ["v1", "v2", "v3", null] as const) {
      for (const mode of ["legacy", "resume", "fresh"] as const) {
        for (const profile of [null, "p"]) expect(kiroLogGate(launch(engine, mode, profile), KIRO_LOG_PROOFS_TODAY).open, `${engine}/${mode}/${profile}`).toBe(false);
      }
    }
  });

  it("it opens only when every proof is positive — a missing or false one keeps it closed", () => {
    const yes = () => true, no = () => false;
    expect(kiroLogGate(launch("v1", "resume", "p"), { currentSession: yes })).toEqual({ open: true, engine: "v1" });
    expect(kiroLogGate(launch("v1", "resume", "p"), { currentSession: no })).toMatchObject({ open: false, reason: "kiro_session_unobservable" });
    expect(kiroLogGate(launch("v1", "resume"), { v2Root: yes, currentSession: yes })).toMatchObject({ open: false, reason: "kiro_no_profile" });
    expect(kiroLogGate(launch("v2", "resume"), { v2Root: yes, currentSession: yes })).toEqual({ open: true, engine: "v2" });
    expect(kiroLogGate(launch("v2", "resume"), { v2Root: no, currentSession: yes })).toMatchObject({ open: false, reason: "kiro_v2_root" });
    expect(kiroLogGate(launch("v2", "resume"), { v2Root: yes })).toMatchObject({ open: false, reason: "kiro_session_unobservable" });
    expect(kiroLogGate(launch("v2", "fresh"), { v2Root: yes, currentSession: yes })).toMatchObject({ open: false, reason: "kiro_fresh" });
    expect(kiroLogGate(launch("v3", "resume"), { v2Root: yes, currentSession: yes })).toMatchObject({ open: false, reason: "kiro_v3" });
  });
});

describe("KiroBackend.logLaunch: the last launch built in full", () => {
  // A scratch AGEND_HOME and XDG_DATA_HOME: a profile's build prepares its home from the shared kiro root, never the real one.
  let home: string; let saved: Record<string, string | undefined>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kiro-log-"));
    saved = { AGEND_HOME: process.env.AGEND_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.AGEND_HOME = join(home, "agend"); process.env.XDG_DATA_HOME = join(home, "xdg");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  const config = (over: Partial<CliBackendConfig> = {}) => ({ workingDirectory: home, instanceDir: home, instanceName: "k", mcpServers: {}, ...over }) as CliBackendConfig;

  it("none before a build; the plan's engine, mode and profile after one; cleared by a build that throws", () => {
    const b = new KiroBackend(home, TEST_KIRO_COMPAT);
    expect(b.logLaunch()).toBeNull();
    b.buildCommand(config({ kiroUi: "tui", backendOptions: { credential_profile: "work" } }));
    expect(b.logLaunch()).toEqual({ engine: "v2", mode: "legacy", credentialProfile: "work" });   // this kiro has no --agent: legacy
    b.buildCommand(config());
    expect(b.logLaunch()).toEqual({ engine: "v1", mode: "legacy", credentialProfile: null });
    // A later build that fails leaves nothing behind: the reason never describes a launch that did not happen.
    expect(() => b.buildCommand(config({ model: "bad model; rm -rf /" }))).toThrow();
    expect(b.logLaunch()).toBeNull();
    const unknown = new KiroBackend(home, { ...TEST_KIRO_COMPAT, source: "unknown" });
    expect(() => unknown.buildCommand(config())).toThrow();
    expect(unknown.logLaunch()).toBeNull();
  });

  it("a copy: changing what it returns changes nothing", () => {
    const b = new KiroBackend(home, TEST_KIRO_COMPAT);
    b.buildCommand(config());
    const l = b.logLaunch()!;
    l.mode = "resume";
    expect(b.logLaunch()!.mode).toBe("legacy");
  });
});
