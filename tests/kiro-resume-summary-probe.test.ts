/**
 * Idle classic rooms answering kiro-cli-chat's resume-summary probe.
 *
 * AgEnD does not send "In a few words, summarize our conversation so far." —
 * kiro-cli-chat injects it on `--resume` / `--resume-id` of a non-empty
 * conversation. Isolated: scratch AGEND_HOME, private tmux socket, never the
 * live fleet. Mutations: drop the override INPUT and the probe comes back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { shellQuote, type CliBackendConfig } from "../src/backend/types.js";
import { kasBucket } from "../src/backend/kiro-kas-store.js";
import { recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import {
  KIRO_RESUME_SUMMARY_OVERRIDE, KIRO_RESUME_SUMMARY_PROMPT,
  kiroChatArgvFromLaunchCommand, kiroChatWouldInjectResumeSummary, kiroLaunchResumesConversation,
} from "../src/kiro-resume-summary.js";
import { tmuxSocketNameFor } from "../src/paths.js";

const exec = promisify(execFile);

const LEGACY: KiroCliCompatibility = {
  version: "kiro-cli 2.28.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version",
};
const AGENT: KiroCliCompatibility = { ...LEGACY, supportsInstanceAgent: true };

const dirs: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
let saved: { AGEND_HOME?: string; KIRO_HOME?: string };
beforeEach(() => { saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME }; });
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): { agend: string; work: string; inst: string } {
  const agend = scratch("agend-probe-home-");
  const work = scratch("agend-probe-work-");
  const inst = join(agend, "instances", "classic-idle");
  mkdirSync(inst, { recursive: true });
  process.env.AGEND_HOME = agend;
  process.env.KIRO_HOME = scratch("agend-probe-kiro-");
  return { agend, work, inst };
}

function config(h: { work: string; inst: string }, over: Partial<CliBackendConfig> = {}): CliBackendConfig {
  return {
    workingDirectory: h.work, instanceDir: h.inst, instanceName: "classic-idle",
    mcpServers: { agend: { command: "node", args: ["server.js"], env: {} } }, ...over,
  };
}

describe("kiro-cli-chat resume-summary injection (the job AgEnD does not own)", () => {
  it("injects the probe only on resume with no positional INPUT", () => {
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume"])).toBe(true);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--legacy-ui", "--trust-all-tools", "--resume"])).toBe(true);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume-id", "conv-1"])).toBe(true);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume-id=conv-1"])).toBe(true);
    expect(kiroChatWouldInjectResumeSummary(["--resume"])).toBe(true);
  });

  it("a supplied INPUT replaces the default, including the AgEnD override", () => {
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume", KIRO_RESUME_SUMMARY_OVERRIDE])).toBe(false);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume", KIRO_RESUME_SUMMARY_PROMPT])).toBe(false);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--resume-id", "conv-1", KIRO_RESUME_SUMMARY_OVERRIDE])).toBe(false);
  });

  it("a fresh launch (no --resume / --resume-id) never injects", () => {
    expect(kiroChatWouldInjectResumeSummary(["chat", "--legacy-ui", "--trust-all-tools"])).toBe(false);
    expect(kiroChatWouldInjectResumeSummary(["chat", "--agent", "agend-x", "--model", "auto"])).toBe(false);
  });

  it("mutation: dropping the override from a resume argv brings the probe back", () => {
    const withOverride = ["chat", "--resume", "--model", "auto", KIRO_RESUME_SUMMARY_OVERRIDE];
    expect(kiroChatWouldInjectResumeSummary(withOverride)).toBe(false);
    const sabotaged = withOverride.filter(a => a !== KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(kiroChatWouldInjectResumeSummary(sabotaged)).toBe(true);
    expect(sabotaged).toContain("--resume");
  });
});

describe("AgEnD kiro launch: no resume-summary probe", () => {
  it("a classic --resume launch appends the override INPUT and would not inject", () => {
    const h = home();
    const cmd = new KiroBackend(h.inst, LEGACY).buildCommand(config(h));
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(kiroLaunchResumesConversation(argv)).toBe(true);
    expect(argv.at(-1)).toBe(KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(cmd.endsWith(` ${shellQuote(KIRO_RESUME_SUMMARY_OVERRIDE)}`)).toBe(true);
    expect(kiroChatWouldInjectResumeSummary(argv)).toBe(false);
  });

  it("a V3 --resume-id launch is unchanged (no override)", () => {
    const h = home();
    const backend = new KiroBackend(h.inst, LEGACY);
    const fresh = backend.buildCommand(config(h, { kiroUi: "v3" }));
    expect(kiroLaunchResumesConversation(kiroChatArgvFromLaunchCommand(fresh))).toBe(false);
    expect(kiroChatArgvFromLaunchCommand(fresh)).not.toContain(KIRO_RESUME_SUMMARY_OVERRIDE);
    const createdAt = new Date(Date.now() + 1000).toISOString();
    const dir = join(process.env.KIRO_HOME!, "sessions", kasBucket(h.work), "sess_idle");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "sess_idle", createdAt, lastModifiedAt: createdAt, schemaVersion: "1.0.0" }));
    writeFileSync(join(dir, "messages.jsonl"), "");
    const cmd = backend.buildCommand(config(h, { kiroUi: "v3" }));
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(argv).toContain("--resume-id");
    expect(argv).toContain("sess_idle");
    expect(argv).not.toContain(KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(cmd).not.toContain(shellQuote(KIRO_RESUME_SUMMARY_OVERRIDE));
  });

  it("a TUI per-instance --resume-id launch is unchanged (no override)", async () => {
    const h = home();
    recordKiroLaunch({
      instance: "classic-idle", workingDirectory: h.work, credentialProfile: null,
      kiroVersion: "2.28.0", ui: "tui", flags: ["--tui", "--agent-engine=v2"],
    });
    const dir = join(process.env.KIRO_HOME!, "sessions", "cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tui-sess.json"), JSON.stringify({
      session_id: "tui-sess", cwd: h.work, updated_at: new Date().toISOString(),
    }));
    const backend = new KiroBackend(h.inst, AGENT);
    const cfg = config(h, { kiroUi: "tui" });
    await backend.prepareLaunch(cfg);
    backend.writeConfig(cfg);
    const cmd = backend.buildCommand(cfg);
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(argv).toContain("--resume-id");
    expect(argv).toContain("tui-sess");
    expect(argv).not.toContain(KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(cmd).not.toContain(shellQuote(KIRO_RESUME_SUMMARY_OVERRIDE));
  });

  it("mutation: a V3 resume must not pick up the classic override if the ui guard is dropped", () => {
    const h = home();
    const backend = new KiroBackend(h.inst, LEGACY);
    const createdAt = new Date(Date.now() + 1000).toISOString();
    const dir = join(process.env.KIRO_HOME!, "sessions", kasBucket(h.work), "sess_idle");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "sess_idle", createdAt, lastModifiedAt: createdAt, schemaVersion: "1.0.0" }));
    writeFileSync(join(dir, "messages.jsonl"), "");
    const cmd = backend.buildCommand(config(h, { kiroUi: "v3" }));
    expect(cmd, "V3 must stay byte-for-byte without the classic INPUT").not.toMatch(/'!:'/);
  });

  it("a fresh launch (skipResume) does not pass the override and does not inject", () => {
    const h = home();
    const cmd = new KiroBackend(h.inst, LEGACY).buildCommand(config(h, { skipResume: true }));
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(kiroLaunchResumesConversation(argv)).toBe(false);
    expect(argv).not.toContain(KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(kiroChatWouldInjectResumeSummary(argv)).toBe(false);
  });

  it("mutation of the launch command: strip the override and the probe would fire", () => {
    const h = home();
    const cmd = new KiroBackend(h.inst, LEGACY).buildCommand(config(h));
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(kiroChatWouldInjectResumeSummary(argv)).toBe(false);
    const sabotaged = argv.filter(a => a !== KIRO_RESUME_SUMMARY_OVERRIDE);
    expect(kiroChatWouldInjectResumeSummary(sabotaged), "without the override kiro injects the probe").toBe(true);
  });
});

describe("isolated repro: scratch AGEND_HOME, private tmux, mock kiro-cli", () => {
  it("the AgEnD launch argv on a private socket does not inject; dropping the override does", async () => {
    const h = home();
    const liveHome = join(process.env.HOME || "/home/han", ".agend");
    expect(h.agend).not.toBe(liveHome);
    const socket = tmuxSocketNameFor(h.agend, liveHome);
    expect(socket, "scratch home must not use tmux's default (live) socket").toBeTruthy();
    expect(socket).not.toBe("default");

    const cmd = new KiroBackend(h.inst, LEGACY).buildCommand(config(h));
    const argv = kiroChatArgvFromLaunchCommand(cmd);
    expect(kiroChatWouldInjectResumeSummary(argv)).toBe(false);

    const mock = join(h.agend, "mock-kiro-cli");
    const log = join(h.agend, "probe-log.json");
    writeFileSync(mock, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.KIRO_PROBE_LOG, JSON.stringify(process.argv.slice(2)));
setTimeout(() => {}, 15000);
`);
    chmodSync(mock, 0o755);

    const run = async (chatArgv: string[], dest: string) => {
      await exec("tmux", ["-L", socket!, "new-session", "-d", "-s", "probe",
        mock, ...chatArgv], { timeout: 5_000, env: { ...process.env, KIRO_PROBE_LOG: dest } });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try { return JSON.parse(readFileSync(dest, "utf-8")) as string[]; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error(`mock kiro did not write ${dest}`);
    };

    try {
      const seen = await run(argv, log);
      expect(kiroChatWouldInjectResumeSummary(seen)).toBe(false);
      expect(seen.at(-1)).toBe(KIRO_RESUME_SUMMARY_OVERRIDE);

      const droppedLog = join(h.agend, "probe-dropped.json");
      const dropped = argv.filter(a => a !== KIRO_RESUME_SUMMARY_OVERRIDE);
      // kill-server, not only kill-session: the second new-session must start a
      // new tmux server so KIRO_PROBE_LOG is the dropped dest, not the first run's.
      execFileSync("tmux", ["-L", socket!, "kill-server"], { stdio: "ignore" });
      const seenDropped = await run(dropped, droppedLog);
      expect(kiroChatWouldInjectResumeSummary(seenDropped)).toBe(true);
      expect(KIRO_RESUME_SUMMARY_PROMPT.length).toBeGreaterThan(10);
    } finally {
      try { execFileSync("tmux", ["-L", socket!, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
    }
  }, 15_000);
});
