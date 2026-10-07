/**
 * #1314: `file:` refs in systemPrompt / workflow resolve against the instance's working_directory, not the fleet
 * process's cwd; one release of fallback to the old fleet-directory file, warned with both paths; diagnostics name
 * paths, never contents. And the comma split applies only when a part is a `file:` ref.
 *
 * Private temp directories only. The fleet's cwd is injected (a parameter, or a stubbed `process.cwd`), never
 * changed with chdir; no fleet, CLI or tmux (bd0c88aa).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_FILE_MAX_BYTES,
  assembleSystemPrompt,
  readFileRef,
  resolveFileRefPath,
  resolveWorkflowText,
  systemPromptParts,
  type PromptFileWarning,
} from "../src/prompt-file-ref.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1314-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function put(root: string, rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A fleet directory and an instance working directory, each with its own prompts/role.md. */
function layout(opts: { fleet?: string; instance?: string } = {}) {
  const fleetCwd = scratch();
  const workingDirectory = scratch();
  if (opts.fleet !== undefined) put(fleetCwd, "prompts/role.md", opts.fleet);
  if (opts.instance !== undefined) put(workingDirectory, "prompts/role.md", opts.instance);
  const warnings: PromptFileWarning[] = [];
  return { fleetCwd, workingDirectory, warnings, ctx: { fleetCwd, workingDirectory, onWarning: (w: PromptFileWarning) => warnings.push(w) } };
}

describe("resolveFileRefPath", () => {
  it("relative under the working directory; ~/ under home; absolute as given", () => {
    expect(resolveFileRefPath("prompts/role.md", "/proj", "/home/u")).toBe("/proj/prompts/role.md");
    expect(resolveFileRefPath("./prompts/role.md", "/proj", "/home/u")).toBe("/proj/prompts/role.md");
    expect(resolveFileRefPath("../shared/role.md", "/proj/app", "/home/u")).toBe("/proj/shared/role.md");
    expect(resolveFileRefPath("~/prompts/role.md", "/proj", "/home/u")).toBe("/home/u/prompts/role.md");
    expect(resolveFileRefPath("/etc/agend/role.md", "/proj", "/home/u")).toBe("/etc/agend/role.md");
    expect(resolveFileRefPath(" prompts/role.md ", "/proj", "/home/u")).toBe("/proj/prompts/role.md");
    // A working_directory written with ~ is the same directory the CLI runs in.
    expect(resolveFileRefPath("role.md", "~/proj", "/home/u")).toBe("/home/u/proj/role.md");
  });
});

describe("the instance's file, not the fleet directory's", () => {
  it("both exist: the instance's is read, no warning (the acceptance case)", () => {
    const { ctx, warnings } = layout({ fleet: "FLEET", instance: "INSTANCE" });
    expect(readFileRef("prompts/role.md", "systemPrompt", ctx)).toBe("INSTANCE");
    expect(assembleSystemPrompt("file:prompts/role.md", ctx)).toBe("INSTANCE");
    expect(warnings).toEqual([]);
  });

  it("only the fleet directory has it: read once more for this release, warned with BOTH paths", () => {
    const { ctx, warnings, fleetCwd, workingDirectory } = layout({ fleet: "FLEET" });
    expect(readFileRef("prompts/role.md", "systemPrompt", ctx)).toBe("FLEET");
    expect(warnings).toEqual([{
      field: "systemPrompt", problem: "fleet_dir_fallback",
      path: join(workingDirectory, "prompts/role.md"), legacyPath: join(fleetCwd, "prompts/role.md"),
    }]);
  });

  it("neither has it: nothing, warned with the resolved path and ENOENT", () => {
    const { ctx, warnings, workingDirectory } = layout();
    expect(assembleSystemPrompt("file:prompts/role.md", ctx)).toBeUndefined();
    expect(warnings).toEqual([{ field: "systemPrompt", problem: "missing", code: "ENOENT", path: join(workingDirectory, "prompts/role.md") }]);
  });

  it("an absolute ref never falls back; ~/ uses home", () => {
    const { ctx, warnings, fleetCwd } = layout({ fleet: "FLEET" });
    const abs = put(scratch(), "abs.md", "ABSOLUTE");
    expect(readFileRef(abs, "systemPrompt", ctx)).toBe("ABSOLUTE");
    expect(readFileRef(join(fleetCwd, "nope.md"), "systemPrompt", ctx)).toBe("");
    expect(warnings.map(w => w.problem)).toEqual(["missing"]);
    const home = scratch();
    put(home, "p/role.md", "HOME");
    expect(readFileRef("~/p/role.md", "systemPrompt", { ...ctx, home })).toBe("HOME");
  });

  it("diagnostics never carry the contents: too large, a directory", () => {
    const { ctx, warnings, workingDirectory } = layout();
    const marker = "SECRET-MARKER-1314";
    put(workingDirectory, "big.md", marker + "x".repeat(PROMPT_FILE_MAX_BYTES));
    mkdirSync(join(workingDirectory, "adir"));
    expect(readFileRef("big.md", "systemPrompt", ctx)).toBe("");
    expect(readFileRef("adir", "workflow", ctx)).toBe("");
    expect(warnings).toEqual([
      { field: "systemPrompt", problem: "too_large", path: join(workingDirectory, "big.md") },
      { field: "workflow", problem: "unreadable", code: "EISDIR", path: join(workingDirectory, "adir") },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(marker);
    // Exactly at the cap is still read.
    put(workingDirectory, "edge.md", "y".repeat(PROMPT_FILE_MAX_BYTES));
    expect(readFileRef("edge.md", "systemPrompt", ctx)).toHaveLength(PROMPT_FILE_MAX_BYTES);
  });
});

describe("the comma split", () => {
  it("an inline prompt with commas stays ONE paragraph", () => {
    const { ctx } = layout();
    const inline = "You are Kuro, a careful reviewer, and you never merge.";
    expect(systemPromptParts(inline)).toEqual([inline]);
    expect(assembleSystemPrompt(inline, ctx)).toBe(inline);
  });

  it("split when a part is a file: ref; parts in order, inline text between them kept, empties dropped", () => {
    const { ctx, workingDirectory } = layout();
    put(workingDirectory, "a.md", "A");
    put(workingDirectory, "b.md", "B");
    expect(assembleSystemPrompt("file:a.md, Be brief, file:b.md", ctx)).toBe("A\n\nBe brief\n\nB");
    expect(assembleSystemPrompt("Intro, file:missing.md", ctx)).toBe("Intro");
  });
});

describe("workflow", () => {
  it("file: refs follow the same rules; inline text and builtin are untouched", () => {
    const { ctx, warnings } = layout({ fleet: "FLEET-WF", instance: "INSTANCE-WF" });
    expect(resolveWorkflowText("file:prompts/role.md", ctx)).toBe("INSTANCE-WF");
    expect(resolveWorkflowText("Do it, then report.", ctx)).toBe("Do it, then report.");
    expect(warnings).toEqual([]);
  });
});

describe("config validation warns about a ref that names no file", () => {
  /** The instance's own warnings (a one-instance fleet also gets the unrelated "no general_topic" one). */
  const fleet = (instance: Record<string, unknown>) => {
    const result = validateFleetConfig({ channel: { type: "telegram", group_id: 1, bot_token_env: "T" }, defaults: {}, instances: { a: instance } } as never);
    return { ...result, warnings: result.warnings.filter(w => w.path.startsWith("instances.a.")) };
  };

  it("a missing systemPrompt / workflow file is a warning on the instance (not an error); present ones are silent", () => {
    const wd = scratch();
    put(wd, "prompts/role.md", "R");
    const result = fleet({ working_directory: wd, systemPrompt: "file:prompts/role.md, file:prompts/missing.md", workflow: "file:wf.md" });
    expect(result.valid).toBe(true);
    expect(result.warnings.map(w => w.path)).toEqual(["instances.a.systemPrompt", "instances.a.workflow"]);
    expect(result.warnings[0]!.message).toContain(join(wd, "prompts/missing.md"));
    expect(fleet({ working_directory: wd, systemPrompt: "file:prompts/role.md" }).warnings).toEqual([]);
    expect(fleet({ working_directory: wd, systemPrompt: "Inline, with commas" }).warnings).toEqual([]);
  });
});

describe("the daemon builds the instructions from the instance's files", () => {
  function daemonFor(config: Partial<InstanceConfig>) {
    const instanceDir = scratch();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
    const daemon = new Daemon("prompt-1314", {
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      log_level: "silent", ...config,
    } as unknown as InstanceConfig, instanceDir, false, { binaryName: "claude" } as never, undefined, { child: () => logger } as never);
    const env = () => {
      const built = (daemon as unknown as { buildBackendConfig(): { mcpServers: Record<string, { env?: Record<string, string> }> } }).buildBackendConfig();
      return Object.values(built.mcpServers).find(s => s.env?.AGEND_INSTANCE_NAME === "prompt-1314" || s.env)!.env!;
    };
    return { daemon, logger, env };
  }

  it("relative refs read the working directory's files; the fleet directory's same-name file is ignored", () => {
    const { fleetCwd, workingDirectory } = layout({ fleet: "FLEET", instance: "INSTANCE" });
    put(workingDirectory, "wf.md", "WORKFLOW");
    vi.spyOn(process, "cwd").mockReturnValue(fleetCwd);
    const { env, logger } = daemonFor({ working_directory: workingDirectory, systemPrompt: "file:prompts/role.md, Inline, part", workflow: "file:wf.md" });
    const e = env();
    expect(e.AGEND_CUSTOM_PROMPT).toBe("INSTANCE\n\nInline\n\npart");
    expect(e.AGEND_WORKFLOW).toBe("WORKFLOW");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("an inline prompt with commas reaches the agent as one paragraph", () => {
    const { workingDirectory } = layout();
    const inline = "You are Kuro, a careful reviewer.";
    expect(daemonFor({ working_directory: workingDirectory, systemPrompt: inline }).env().AGEND_CUSTOM_PROMPT).toBe(inline);
  });

  it("the one-release fallback: read from the fleet directory, logged with both paths, the topic told once per daemon", () => {
    const { fleetCwd, workingDirectory } = layout({ fleet: "FLEET" });
    vi.spyOn(process, "cwd").mockReturnValue(fleetCwd);
    const { daemon, env, logger } = daemonFor({ working_directory: workingDirectory, systemPrompt: "file:prompts/role.md" });
    const notices: unknown[] = [];
    daemon.on("prompt_file_fallback", e => notices.push(e));
    expect(env().AGEND_CUSTOM_PROMPT).toBe("FLEET");
    env(); // a respawn builds the config again
    const [fields, message] = logger.warn.mock.calls[0]!;
    expect(fields).toEqual({ field: "systemPrompt", path: join(workingDirectory, "prompts/role.md"), legacyPath: join(fleetCwd, "prompts/role.md") });
    expect(message).toContain(join(workingDirectory, "prompts/role.md"));
    expect(message).toContain(join(fleetCwd, "prompts/role.md"));
    expect(message).not.toContain("FLEET\n");
    expect(notices).toEqual([{ name: "prompt-1314", field: "systemPrompt", path: join(workingDirectory, "prompts/role.md"), legacyPath: join(fleetCwd, "prompts/role.md") }]);
  });
});

describe("the fleet tells the instance's topic about the fallback", () => {
  it("prompt_file_fallback → one notice naming the field and both paths", () => {
    setLocale("en");
    const notifyInstanceTopic = vi.fn(() => true);
    const ctx = {
      fleetConfig: { instances: { worker: {} }, defaults: {} }, logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: { insert() {} }, isPlannedRestart: () => false, notifyInstanceTopic, webhookEmit() {}, clearCancelButton() {},
      checkModelFailover() {}, setTopicIcon() {}, restartSingleInstance: vi.fn(async () => {}),
    } as unknown as LifecycleContext;
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
    new InstanceLifecycle(ctx).attachIncidentHandlers("worker", daemon as never);
    daemon.emit("prompt_file_fallback", { name: "worker", field: "systemPrompt", path: "/proj/prompts/role.md", legacyPath: "/home/u/.agend/prompts/role.md" });
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker",
      t("prompt_file.fleet_dir_fallback", "systemPrompt", "/home/u/.agend/prompts/role.md", "/proj/prompts/role.md"));
    const [, text] = notifyInstanceTopic.mock.calls[0]! as unknown as [string, string];
    expect(text).toContain("/proj/prompts/role.md");
    expect(text).toContain("/home/u/.agend/prompts/role.md");
  });
});
