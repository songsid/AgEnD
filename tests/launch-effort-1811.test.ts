import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliHelp, codexEffort, flagEffort, helpOption, resetCliHelpCache } from "../src/backend/launch-effort.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { GrokBackend } from "../src/backend/grok.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { resolveCodexLaunchModel } from "../src/backend/codex-metadata.js";
import { t } from "../src/locale.js";
import { registerExecutableFixture } from "./support/process-guard.js";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";

/**
 * #1811: a configured effort reaches codex, claude-code, grok and antigravity at launch — only where this binary's
 * help lists the flag and the level is one it (or, for codex, the model's catalog) takes. Anything else launches
 * without it, with a quiet note. No real CLI runs here: a binary is a shell script printing a help text captured
 * verbatim from the real one (claude 2.1.299, grok 1.0.46, agy 1.3.4).
 */
const CLAUDE_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "  --disallowedTools <tools...>          Comma or space-separated list of tool names to deny",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --environment <environment_id>        Create a new cloud session that runs on",
].join("\n");
const GROK_HELP = [
  "      --reasoning-effort <EFFORT>",
  "          Reasoning effort for reasoning models",
  "          ",
  "          [aliases: --effort]",
  "",
  "      --restore-code",
  "          Restore the original session's repository snapshot when resuming.",
].join("\n");
const AGY_HELP = [
  "  --continue                      Continue the most recent conversation",
  "  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)",
  "  -i                              Short alias for --prompt-interactive",
].join("\n");
const OLD_HELP = "Usage: cli [options]\n  --model <model>   Model\n  --continue        Continue\n";

let root: string;
const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-launch-effort-"));
  process.env.AGEND_HOME = join(root, "agend");
  process.env.CODEX_HOME = join(root, "codex-shared");
  mkdirSync(join(root, "codex-shared"), { recursive: true });
  resetCliHelpCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

/** A "binary" that prints this help, and records each call in a file next to it. */
function fakeBinary(name: string, help: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\necho call >> "${path}.calls"\ncat <<'AGEND_HELP_EOF'\n${help}\nAGEND_HELP_EOF\n`);
  chmodSync(path, 0o755);
  registerExecutableFixture(path);                                  // a generated fake, never the real CLI
  return path;
}

describe("reading a binary's help", () => {
  it("finds the option and the levels its entry lists — on the row, or on the lines under it", () => {
    expect(helpOption(CLAUDE_HELP, "--effort")).toEqual({ listed: true, levels: ["low", "medium", "high", "xhigh", "max"] });
    expect(helpOption(AGY_HELP, "--effort")).toEqual({ listed: true, levels: ["low", "medium", "high", "xhigh", "max"] });
    expect(helpOption(GROK_HELP, "--reasoning-effort")).toEqual({ listed: true, levels: null });
    // An alias inside another option's entry is not that option; a later option's list is not this one's.
    expect(helpOption(GROK_HELP, "--effort").listed).toBe(false);
    expect(helpOption(OLD_HELP, "--effort")).toEqual({ listed: false, levels: null });
    expect(helpOption("  --effort <level>   Effort\n  --mode <m>   (a, b)\n", "--effort")).toEqual({ listed: true, levels: null });
    // Values AgEnD does not have are not offered.
    expect(helpOption("  --effort <l>  (low, ultra, max)\n", "--effort").levels).toEqual(["low", "max"]);
  });

  it("is read once per binary file; a changed file is read again; an unreadable one gives nothing", () => {
    const bin = fakeBinary("claude", CLAUDE_HELP);
    const run = vi.fn(() => CLAUDE_HELP);
    expect(cliHelp(bin, run)).toBe(CLAUDE_HELP);
    expect(cliHelp(bin, run)).toBe(CLAUDE_HELP);
    expect(run).toHaveBeenCalledTimes(1);
    utimesSync(bin, new Date(), new Date(Date.now() + 60_000));      // an update puts another file there
    cliHelp(bin, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(cliHelp(join(root, "missing"), run)).toBeNull();
    expect(cliHelp(bin, () => { throw new Error("exit 2"); })).toBe(CLAUDE_HELP);   // cached for this file
    resetCliHelpCache();
    expect(cliHelp(bin, () => { throw new Error("exit 2"); })).toBeNull();
  });
});

describe("the gate", () => {
  const helpRun = (help: string) => () => help;
  it("passes the flag when the help lists it and the level is one it takes", () => {
    const bin = fakeBinary("x", "");
    expect(flagEffort("claude-code", "high", bin, helpRun(CLAUDE_HELP))).toEqual({ arg: " --effort high", note: null, level: "high" });
    resetCliHelpCache();
    expect(flagEffort("antigravity", "MAX ", bin, helpRun(AGY_HELP))).toEqual({ arg: " --effort max", note: null, level: "max" });
    resetCliHelpCache();
    expect(flagEffort("grok", "medium", bin, helpRun(GROK_HELP))).toEqual({ arg: " --reasoning-effort medium", note: null, level: "medium" });
  });

  it("nothing, with a note, when the version lacks the flag, its help cannot be read, or lists no levels", () => {
    const bin = fakeBinary("x", "");
    expect(flagEffort("claude-code", "high", bin, helpRun(OLD_HELP)))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "high", "claude-code", t("effort.launch_no_flag", "--effort")) });
    resetCliHelpCache();
    expect(flagEffort("antigravity", "high", bin, () => { throw new Error("no help"); }))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "high", "antigravity", t("effort.launch_no_help")) });
    resetCliHelpCache();
    expect(flagEffort("antigravity", "high", bin, helpRun("  --effort   Reasoning effort\n")))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "high", "antigravity", t("effort.launch_no_levels", "--effort")) });
  });

  it("an invalid level is dropped: one the CLI does not list, grok's beyond its three, or no level at all", () => {
    const bin = fakeBinary("x", "");
    expect(flagEffort("antigravity", "max", bin, helpRun("  --effort   (low|medium|high)\n")))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "max", "antigravity", t("effort.launch_level_not_offered", "low, medium, high")) });
    resetCliHelpCache();
    expect(flagEffort("grok", "xhigh", bin, helpRun(GROK_HELP)).arg).toBeNull();
    expect(flagEffort("claude-code", "ultra", bin, helpRun(CLAUDE_HELP)))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "ultra", "claude-code", t("effort.launch_not_a_level", "low, medium, high, xhigh, max")) });
    expect(flagEffort("claude-code", "high; rm -rf /", bin, helpRun(CLAUDE_HELP)).arg).toBeNull();
    expect(flagEffort("claude-code", undefined, bin, helpRun(CLAUDE_HELP))).toEqual({ arg: null, note: null });
  });

  it("codex: the model's catalog entry decides; an unknown model gets nothing", () => {
    expect(codexEffort("max", { model: "gpt-6-luna", levels: ["low", "medium", "high", "xhigh", "max"] }))
      .toEqual({ arg: ` -c 'model_reasoning_effort="max"'`, note: null });
    expect(codexEffort("max", { model: "gpt-5.5", levels: ["low", "medium", "high", "xhigh"] }).arg).toBeNull();
    expect(codexEffort("high", { model: "gpt-9", levels: null }))
      .toEqual({ arg: null, note: t("effort.launch_skipped", "high", "codex", t("effort.launch_codex_unknown_model", "gpt-9")) });
    expect(codexEffort(undefined, { model: "gpt-5.5", levels: ["high"] })).toEqual({ arg: null, note: null });
  });
});

describe("the real builders: fresh and resumed launches", () => {
  const config = (instance: string, over: Record<string, unknown> = {}) =>
    ({ workingDirectory: instance, instanceDir: instance, instanceName: "worker", mcpServers: {}, ...over }) as never;
  const instanceDir = () => { const d = join(root, "agend", "instances", "worker"); mkdirSync(d, { recursive: true }); return d; };

  it("claude-code: --effort with --continue; nothing on a claude without it, and the note is quiet and read once", () => {
    const dir = instanceDir();
    const b = new ClaudeCodeBackend(dir);
    (b as any).binaryPath = fakeBinary("claude", CLAUDE_HELP);
    writeFileSync(join(dir, "session-id"), "abc");
    (b as any).hasProjectSession = () => true;                      // a conversation to resume
    const cmd = b.buildCommand(config(dir, { effort: "high", model: "opus" }));
    expect(cmd).toContain(" --continue");
    expect(cmd).toContain(" --effort high");
    expect(b.consumeQuietLaunchNotes()).toEqual([]);
    (b as any).binaryPath = fakeBinary("claude-old", OLD_HELP);
    expect(b.buildCommand(config(dir, { effort: "high" }))).not.toContain("--effort");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("effort.launch_skipped", "high", "claude-code", t("effort.launch_no_flag", "--effort"))]);
    expect(b.consumeQuietLaunchNotes()).toEqual([]);
    // No effort configured: no flag, no note, and the binary's help is not even read.
    (b as any).binaryPath = fakeBinary("claude-unread", CLAUDE_HELP);
    expect(b.buildCommand(config(dir))).not.toContain("--effort");
    expect(b.consumeQuietLaunchNotes()).toEqual([]);
  });

  it("grok: --reasoning-effort with --resume <id>; a level beyond its three is dropped", () => {
    const dir = instanceDir();
    const b = new GrokBackend(dir);
    (b as any).binaryPath = fakeBinary("grok", GROK_HELP);
    (b as any).storedSessionId = () => "11111111-2222-4333-8444-555555555555";
    const cmd = b.buildCommand(config(dir, { effort: "high" }));
    expect(cmd).toContain(" --resume 11111111-2222-4333-8444-555555555555");
    expect(cmd).toContain(" --reasoning-effort high");
    expect(b.buildCommand(config(dir, { effort: "max" }))).not.toContain("--reasoning-effort");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("effort.launch_skipped", "max", "grok", t("effort.launch_level_not_offered", "low, medium, high"))]);
  });

  it("antigravity: --effort with --continue on 1.3.x; nothing on 1.0.x, which has no --effort", () => {
    const dir = instanceDir();
    const b = new AntigravityBackend(dir);
    (b as any).binaryPath = fakeBinary("agy", AGY_HELP);
    const cmd = b.buildCommand(config(dir, { effort: "xhigh" }));
    expect(cmd).toContain(" --continue");
    expect(cmd).toContain(" --effort xhigh");
    (b as any).binaryPath = fakeBinary("agy-1.0", OLD_HELP);
    expect(b.buildCommand(config(dir, { effort: "xhigh" }))).not.toContain("--effort");
    expect(b.consumeQuietLaunchNotes()).toHaveLength(1);
  });

  it("codex: -c model_reasoning_effort, on a resume too, when the model's catalog lists the level", () => {
    const dir = instanceDir();
    writeFileSync(join(root, "codex-shared", "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort })) },
      { slug: "gpt-5.5", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })) },
    ] }));
    const b = new CodexBackend(dir);
    (b as any).planResume = () => ({ mode: "resume", id: "019a-thread" });
    const cmd = b.buildCommand(config(dir, { effort: "max", model: "gpt-6.1-sol" }));
    expect(cmd).toContain("resume '019a-thread'");
    expect(cmd).toContain(` -c 'model_reasoning_effort="max"'`);
    expect(b.consumeQuietLaunchNotes()).toEqual([]);
    // gpt-5.5 lists no max: launched without it.
    expect(b.buildCommand(config(dir, { effort: "max", model: "gpt-5.5" }))).not.toContain("model_reasoning_effort");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("effort.launch_skipped", "max", "codex", t("effort.launch_level_not_offered", "low, medium, high, xhigh"))]);
    // A model the catalog does not list (or lists without levels): nothing is passed — no guessed floor.
    expect(b.buildCommand(config(dir, { effort: "high", model: "gpt-9" }))).not.toContain("model_reasoning_effort");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("effort.launch_skipped", "high", "codex", t("effort.launch_codex_unknown_model", "gpt-9"))]);
    // No model given: config.toml's model is the one that runs.
    writeFileSync(join(root, "codex-shared", "config.toml"), `model = "gpt-5.5"\n`);
    expect(b.buildCommand(config(dir, { effort: "xhigh" }))).toContain(` -c 'model_reasoning_effort="xhigh"'`);
  });
});

describe("the daemon", () => {
  it("hands the configured effort to the builder, and sends what the launch left out as a QUIET note", async () => {
    const dir = mkdtempSync(join(root, "daemon-"));
    const daemon = new Daemon("worker", {
      working_directory: dir, backend: "codex", effort: "max", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "instance"), false, undefined, undefined, pino({ level: "silent" }) as any) as any;
    mkdirSync(join(dir, "instance"), { recursive: true });
    const seen: CliBackendConfig[] = [];
    daemon.backend = {
      binaryName: "codex",
      writeConfig: vi.fn(),
      buildCommand: vi.fn((c: CliBackendConfig) => { seen.push(c); return "codex"; }),
      consumeQuietLaunchNotes: vi.fn(() => ["effort not passed"]),
    } as unknown as CliBackend;
    const events: unknown[] = [];
    daemon.on("backend_launch_warning", (event: unknown) => events.push(event));
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(seen[0]?.effort).toBe("max");
    expect(events).toEqual([{ name: "worker", message: "effort not passed", quiet: true }]);
    vi.restoreAllMocks();
  });
});

describe("review r1: codex's effort follows the model that will really run", () => {
  const CACHE = JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })) },
    { slug: "gpt-5.5", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })) },
  ] });
  const setup = (homeToml: string) => {
    writeFileSync(join(root, "codex-shared", "models_cache.json"), CACHE);
    writeFileSync(join(root, "codex-shared", "config.toml"), homeToml);
    const dir = join(root, "agend", "instances", "worker");
    const work = join(root, "work", "repo");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(work, ".git"), { recursive: true });
    const b = new CodexBackend(dir);
    (b as any).planResume = () => ({ mode: "fresh", reason: "none" });
    const launch = (over: Record<string, unknown> = {}) => {
      const cmd = b.buildCommand({ workingDirectory: work, instanceDir: dir, instanceName: "worker", mcpServers: {}, effort: "max", ...over } as never);
      return { passed: cmd.includes(`model_reasoning_effort="max"`), notes: b.consumeQuietLaunchNotes() };
    };
    return { work, launch };
  };
  const UNPROVEN = t("effort.launch_skipped", "max", "codex", t("effort.launch_codex_model_unproven"));

  it("(a) the ROOT model key, read as TOML — not a `model =` line inside a string, and in any key or quote form", () => {
    const decoy = `developer_instructions = '''\nExample configuration:\nmodel = "gpt-6.1-sol"\n'''\n`;
    for (const root_ of [`model = 'gpt-5.5'\n`, `"model" = "gpt-5.5"\n`, `  model = "gpt-5.5"\n`]) {
      const { launch } = setup(root_ + decoy);
      expect(launch().passed, root_).toBe(false);                                     // gpt-5.5 has no max
    }
    // Controls: the plain root key of a model that has max; a model given to the launch.
    expect(setup(`model = "gpt-6.1-sol"\n` + decoy).launch().passed).toBe(true);
    expect(setup(`model = 'gpt-5.5'\n` + decoy).launch({ model: "gpt-6.1-sol" }).passed).toBe(true);
    // A top-level profile: read as older codex versions did (its [profiles.x] model). This is the reader's rule, not a
    // claim about codex 0.162.1, which refuses a top-level `profile` at startup — either way the root model's levels
    // are not borrowed.
    expect(setup(`model = "gpt-6.1-sol"\nprofile = "slow"\n[profiles.slow]\nmodel = "gpt-5.5"\n`).launch().passed).toBe(false);
  });

  it("(b) a project .codex/config.toml that could set another model: unproven — no flag, a quiet note", () => {
    const { work, launch } = setup(`model = "gpt-6.1-sol"\n`);
    mkdirSync(join(work, ".codex"), { recursive: true });
    writeFileSync(join(work, ".codex", "config.toml"), `model = "gpt-5.5"\n`);
    expect(launch()).toEqual({ passed: false, notes: [UNPROVEN] });
    // Control: a model given to the launch outranks every file.
    expect(launch({ model: "gpt-6.1-sol" })).toEqual({ passed: true, notes: [] });
    // The same model there, or none: proven.
    writeFileSync(join(work, ".codex", "config.toml"), `model = "gpt-6.1-sol"\napproval_policy = "never"\n`);
    expect(launch().passed).toBe(true);
    // A profile it selects, or a file that does not parse: unproven.
    writeFileSync(join(work, ".codex", "config.toml"), `profile = "x"\n`);
    expect(launch().notes).toEqual([UNPROVEN]);
    writeFileSync(join(work, ".codex", "config.toml"), `model = \n`);
    expect(launch().notes).toEqual([UNPROVEN]);
  });

  it("(b) only up to the project root: a file above the nearest .git does not apply; project_root_markers = [] reads every ancestor", () => {
    const { work, launch } = setup(`model = "gpt-6.1-sol"\n`);
    mkdirSync(join(work, "..", ".codex"), { recursive: true });
    writeFileSync(join(work, "..", ".codex", "config.toml"), `model = "gpt-5.5"\n`);
    expect(launch().passed).toBe(true);                                                // above the repo's .git
    writeFileSync(join(root, "codex-shared", "config.toml"), `model = "gpt-6.1-sol"\nproject_root_markers = []\n`);
    expect(launch().notes).toEqual([UNPROVEN]);                                        // no root marker: it may apply
  });

  it("the codex home's own config.toml met on the way up is the user layer, not a project file", () => {
    setup(`model = "gpt-6.1-sol"\nproject_root_markers = []\n`);                     // the working directory
    // The home itself sits at <root>/.codex, an ancestor of the working directory; with no root marker the walk
    // reaches it, and it must be read as the user layer it is, not as a project file.
    process.env.CODEX_HOME = join(root, ".codex");
    mkdirSync(join(root, ".codex"), { recursive: true });
    // It selects a profile: read as a project file that alone would make the model unproven.
    writeFileSync(join(root, ".codex", "config.toml"), `profile = "deep"\nproject_root_markers = []\n[profiles.deep]\nmodel = "gpt-6.1-sol"\n`);
    writeFileSync(join(root, ".codex", "models_cache.json"), CACHE);
    const dir = join(root, "agend", "instances", "worker2");
    mkdirSync(dir, { recursive: true });
    const b = new CodexBackend(dir);
    (b as any).planResume = () => ({ mode: "fresh", reason: "none" });
    const cmd = b.buildCommand({ workingDirectory: join(root, "work", "repo"), instanceDir: dir, instanceName: "w2", mcpServers: {}, effort: "max" } as never);
    expect(cmd).toContain(`model_reasoning_effort="max"`);
  });
});

describe("review r2: the walk starts where codex really runs — the physical working directory", () => {
  const CACHE = JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })) },
    { slug: "gpt-5.5", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })) },
  ] });
  const layout = (projectModel: string) => {
    writeFileSync(join(root, "codex-shared", "models_cache.json"), CACHE);
    writeFileSync(join(root, "codex-shared", "config.toml"), `model = "gpt-6.1-sol"\n`);
    const repo = join(root, "repos", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub"), { recursive: true });
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "config.toml"), `model = "${projectModel}"\n`);
    mkdirSync(join(root, "links"), { recursive: true });
    symlinkSync(join(repo, "sub"), join(root, "links", "alias"));
    symlinkSync(repo, join(root, "links", "root-alias"));
    const dir = join(root, "agend", "instances", "worker");
    mkdirSync(dir, { recursive: true });
    const b = new CodexBackend(dir);
    (b as any).planResume = () => ({ mode: "fresh", reason: "none" });
    return (workingDirectory: string, over: Record<string, unknown> = {}) => {
      const cmd = b.buildCommand({ workingDirectory, instanceDir: dir, instanceName: "worker", mcpServers: {}, effort: "max", ...over } as never);
      b.consumeQuietLaunchNotes();
      return cmd.includes(`model_reasoning_effort="max"`);
    };
  };

  it("a symlink into the repo is walked from its target: the repo's project model counts", () => {
    const launch = layout("gpt-5.5");
    expect(launch(join(root, "links", "alias"))).toBe(false);
    expect(resolveCodexLaunchModel({ isolatedHome: join(root, "none"), sharedHome: join(root, "codex-shared"), workingDirectory: join(root, "links", "alias") }))
      .toEqual({ model: "gpt-6.1-sol", proven: false });
  });

  it("controls: the real path; a link to the repo root; a model on the command line; a project with the same model", () => {
    let launch = layout("gpt-5.5");
    expect(launch(join(root, "repos", "repo", "sub"))).toBe(false);
    expect(launch(join(root, "links", "root-alias"))).toBe(false);
    expect(launch(join(root, "links", "alias"), { model: "gpt-6.1-sol" })).toBe(true);
    rmSync(join(root, "repos"), { recursive: true, force: true });
    rmSync(join(root, "links"), { recursive: true, force: true });
    launch = layout("gpt-6.1-sol");
    expect(launch(join(root, "links", "alias"))).toBe(true);
  });

  it("a working directory that cannot be resolved proves nothing", () => {
    layout("gpt-6.1-sol");
    expect(resolveCodexLaunchModel({ isolatedHome: join(root, "none"), sharedHome: join(root, "codex-shared"), workingDirectory: join(root, "gone") }))
      .toEqual({ model: "gpt-6.1-sol", proven: false });
  });
});
