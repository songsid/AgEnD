import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { buildMcpCoreInstructions } from "../src/instructions.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import type { InstanceConfig } from "../src/types.js";

// Skills used to reach only Kiro General (.kiro/skills); Claude and Codex have
// native on-demand skill directories too (.claude/skills, .agents/skills) and
// saw none of it — and non-Kiro "steering" was bare .md files in the workspace
// root, which no CLI reads. These tests pin the cross-backend publishing rules.

describe("cross-backend skill publishing", () => {
  let dataDir: string;
  let workDir: string;
  let fm: FleetManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "agend-skills-data-"));
    workDir = mkdtempSync(join(tmpdir(), "agend-skills-work-"));
    fm = new FleetManager(dataDir);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function sync(backend: string): void {
    (fm as any).ensureGeneralInstructions(workDir, backend);
  }

  it.each([
    ["kiro-cli", ".kiro/skills"],
    ["claude-code", ".claude/skills"],
    ["codex", ".agents/skills"],
    ["opencode", ".agents/skills"],
    ["grok", ".grok/skills"],
    ["antigravity", ".agents/skills"],
  ])("publishes bundled skills into %s's native directory", (backend, skillsDir) => {
    sync(backend);
    expect(existsSync(join(workDir, skillsDir, "delegation-playbook", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workDir, skillsDir, "development-workflow", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workDir, skillsDir, "fleet-health", "SKILL.md"))).toBe(true);
    // General receives worker-only playbooks too so it understands the worker contract.
    expect(existsSync(join(workDir, skillsDir, "worker-collaboration", "SKILL.md"))).toBe(true);
    // The manifest records ownership for future syncs.
    const manifest = JSON.parse(readFileSync(join(workDir, skillsDir, ".agend-managed-skills.json"), "utf-8"));
    const bundled = readdirSync(join(process.cwd(), "src", "general-knowledge", "skills"))
      .filter(name => existsSync(join(process.cwd(), "src", "general-knowledge", "skills", name, "SKILL.md")))
      .sort();
    expect(manifest).toEqual(bundled);
  });

  it("publishes no skills for backends without a native skill mechanism", () => {
    sync("gemini-cli");
    expect(existsSync(join(workDir, ".agents"))).toBe(false);
    expect(existsSync(join(workDir, ".claude"))).toBe(false);
    expect(existsSync(join(workDir, ".gemini"))).toBe(false);
  });

  it("antigravity publishes into the configured hidden workspace", () => {
    // agy >= 1.1.0 accepts hidden paths, so relocating would split its durable
    // session/workspace data away from the configured directory.
    const instanceName = `agend-skills-test-${process.pid}`;
    const hiddenDir = join(workDir, ".agend", "ws");
    mkdirSync(hiddenDir, { recursive: true });
    (fm as any).ensureGeneralInstructions(hiddenDir, "antigravity", instanceName);
    expect(existsSync(join(hiddenDir, ".agents", "skills", "delegation-playbook", "SKILL.md"))).toBe(true);
  });

  it("never touches a user-authored skill, even on a name collision", () => {
    const userSkill = join(workDir, ".claude", "skills", "fleet-health");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "# my own fleet-health notes\n");

    sync("claude-code");

    // The user's file survives byte-for-byte and stays out of the manifest.
    expect(readFileSync(join(userSkill, "SKILL.md"), "utf-8")).toBe("# my own fleet-health notes\n");
    const manifest = JSON.parse(readFileSync(join(workDir, ".claude", "skills", ".agend-managed-skills.json"), "utf-8"));
    expect(manifest).not.toContain("fleet-health");
    // Other bundled skills still published.
    expect(existsSync(join(workDir, ".claude", "skills", "delegation-playbook", "SKILL.md"))).toBe(true);
  });

  it("adopts and refreshes pre-manifest Kiro General skills on upgrade", () => {
    const skills = join(workDir, ".kiro", "skills");
    const legacyFleetHealth = join(skills, "fleet-health", "SKILL.md");
    const legacyModelDiscovery = join(skills, "model-discovery", "SKILL.md");
    mkdirSync(join(skills, "fleet-health"), { recursive: true });
    mkdirSync(join(skills, "model-discovery"), { recursive: true });
    writeFileSync(legacyFleetHealth, "legacy fleet-health content\n");
    writeFileSync(legacyModelDiscovery, "legacy model-discovery content\n");
    expect(existsSync(join(skills, ".agend-managed-skills.json"))).toBe(false);

    sync("kiro-cli");

    const source = join(process.cwd(), "src", "general-knowledge", "skills");
    expect(readFileSync(legacyFleetHealth, "utf-8")).toBe(
      readFileSync(join(source, "fleet-health", "SKILL.md"), "utf-8"),
    );
    expect(readFileSync(legacyModelDiscovery, "utf-8")).toBe(
      readFileSync(join(source, "model-discovery", "SKILL.md"), "utf-8"),
    );
    const manifest = JSON.parse(readFileSync(join(skills, ".agend-managed-skills.json"), "utf-8"));
    expect(manifest).toContain("fleet-health");
    expect(manifest).toContain("model-discovery");
  });

  it("does not adopt legacy Kiro skills when the directory also has a user skill", () => {
    const skills = join(workDir, ".kiro", "skills");
    const collision = join(skills, "fleet-health", "SKILL.md");
    const userSkill = join(skills, "my-notes", "SKILL.md");
    mkdirSync(join(skills, "fleet-health"), { recursive: true });
    mkdirSync(join(skills, "my-notes"), { recursive: true });
    writeFileSync(collision, "user-edited fleet-health\n");
    writeFileSync(userSkill, "my private notes\n");

    sync("kiro-cli");

    expect(readFileSync(collision, "utf-8")).toBe("user-edited fleet-health\n");
    expect(readFileSync(userSkill, "utf-8")).toBe("my private notes\n");
    const manifest = JSON.parse(readFileSync(join(skills, ".agend-managed-skills.json"), "utf-8"));
    expect(manifest).not.toContain("fleet-health");
    expect(manifest).not.toContain("my-notes");
  });

  it("removes a previously managed skill that is no longer bundled, and only that", () => {
    sync("claude-code");
    const skills = join(workDir, ".claude", "skills");
    // Simulate an older AgEnD having published a since-retired skill…
    mkdirSync(join(skills, "old-retired-skill"), { recursive: true });
    writeFileSync(join(skills, "old-retired-skill", "SKILL.md"), "retired\n");
    const manifest: string[] = JSON.parse(readFileSync(join(skills, ".agend-managed-skills.json"), "utf-8"));
    writeFileSync(join(skills, ".agend-managed-skills.json"), JSON.stringify([...manifest, "old-retired-skill"]));
    // …and the user having a skill of their own.
    mkdirSync(join(skills, "my-notes"), { recursive: true });
    writeFileSync(join(skills, "my-notes", "SKILL.md"), "mine\n");

    sync("claude-code");

    expect(existsSync(join(skills, "old-retired-skill"))).toBe(false); // managed → cleaned up
    expect(readFileSync(join(skills, "my-notes", "SKILL.md"), "utf-8")).toBe("mine\n"); // user's → untouched
  });

  it("is idempotent: a second sync changes nothing", () => {
    sync("codex");
    const skillPath = join(workDir, ".agents", "skills", "delegation-playbook", "SKILL.md");
    const first = readFileSync(skillPath, "utf-8");
    sync("codex");
    expect(readFileSync(skillPath, "utf-8")).toBe(first);
  });

  it("worker startup publishes only shared and worker skills", async () => {
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      working_directory: workDir,
      backend: "codex",
    };
    (fm as any).fleetConfig = { defaults: {}, instances: { worker: config } };
    vi.spyOn((fm as any).lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);

    await fm.startInstance("worker", config, false, "fleet-topic");

    const skills = join(workDir, ".agents", "skills");
    const published = readdirSync(skills)
      .filter(name => !name.startsWith("."))
      .sort();
    expect(published).toEqual([
      "cross-instance-messaging",
      "model-discovery",
      "scheduling",
      "worker-collaboration",
    ]);
    expect(existsSync(join(skills, "delegation-playbook"))).toBe(false);
    expect((fm as any).lifecycle.start).toHaveBeenCalledOnce();
  });

  it("Classic startup does not publish bundled skills", async () => {
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      working_directory: workDir,
      backend: "codex",
      lightweight: true,
    };
    (fm as any).fleetConfig = { defaults: {}, instances: {} };
    vi.spyOn((fm as any).lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);

    await fm.startInstance("classic-test", config, false, "classic");

    expect(existsSync(join(workDir, ".agents", "skills"))).toBe(false);
  });

  it("does not block worker startup when additive skill publishing fails", async () => {
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      working_directory: workDir,
      backend: "codex",
    };
    (fm as any).fleetConfig = { defaults: {}, instances: { worker: config } };
    vi.spyOn(fm as any, "syncRoleSkills").mockImplementation(() => {
      throw new Error("read-only workspace");
    });
    const lifecycleStart = vi.spyOn((fm as any).lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);

    await expect(fm.startInstance("worker", config, false, "fleet-topic")).resolves.toBeUndefined();
    expect(lifecycleStart).toHaveBeenCalledOnce();
  });

  it("treats missing roles as General-only for backward compatibility", () => {
    const source = join(workDir, "source");
    const legacy = join(source, "legacy-skill");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "---\nname: legacy-skill\ndescription: Legacy metadata\n---\n");

    const workerDest = join(workDir, "worker-skills");
    (fm as any).syncManagedSkills(workerDest, source, "worker");
    expect(existsSync(join(workerDest, "legacy-skill"))).toBe(false);

    const generalDest = join(workDir, "general-skills");
    (fm as any).syncManagedSkills(generalDest, source, "general");
    expect(existsSync(join(generalDest, "legacy-skill", "SKILL.md"))).toBe(true);
  });

  it("removes a managed worker skill when its role becomes General-only", () => {
    const source = join(workDir, "source");
    const skill = join(source, "changing-skill");
    const dest = join(workDir, "worker-skills");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: changing-skill\ndescription: Test\nroles: [worker]\n---\n");
    (fm as any).syncManagedSkills(dest, source, "worker");
    expect(existsSync(join(dest, "changing-skill"))).toBe(true);

    writeFileSync(join(skill, "SKILL.md"), "---\nname: changing-skill\ndescription: Test\nroles: [general]\n---\n");
    (fm as any).syncManagedSkills(dest, source, "worker");

    expect(existsSync(join(dest, "changing-skill"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, ".agend-managed-skills.json"), "utf-8"))).toEqual([]);
  });
});

describe("core-rules steering placement", () => {
  let dataDir: string;
  let workDir: string;
  let fm: FleetManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "agend-steer-data-"));
    workDir = mkdtempSync(join(tmpdir(), "agend-steer-work-"));
    fm = new FleetManager(dataDir);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("kiro keeps its native steering directory", () => {
    (fm as any).ensureGeneralInstructions(workDir, "kiro-cli");
    expect(readFileSync(join(workDir, ".kiro", "steering", "core-rules.md"), "utf-8")).toContain("# Core Rules");
    // No bare copy in the workspace root.
    expect(existsSync(join(workDir, "core-rules.md"))).toBe(false);
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["codex", "AGENTS.md"],
    ["grok", "AGENTS.md"],
    ["antigravity", ".agents/agents.md"],
  ])("%s embeds core rules into %s as a managed block instead of a bare root file", (backend, filename) => {
    (fm as any).ensureGeneralInstructions(workDir, backend);
    const content = readFileSync(join(workDir, filename), "utf-8");
    expect(content).toContain("agend:core-rules");
    expect(content).toContain("# Core Rules");
    // The eager file keeps the coordinator core; details moved to skills.
    expect(content).toContain("Fleet Coordinator");
    expect(content).toContain("delegation-playbook");
    // No orphaned root file that no CLI reads.
    expect(existsSync(join(workDir, "core-rules.md"))).toBe(false);
  });

  it("updates the managed block in an EXISTING file while preserving user edits", () => {
    (fm as any).ensureGeneralInstructions(workDir, "claude-code");
    const path = join(workDir, "CLAUDE.md");
    // The user customizes their file around the block…
    const withUserEdits = "# My own preamble\n\n" + readFileSync(path, "utf-8") + "\n## My extra section\nkeep me\n";
    writeFileSync(path, withUserEdits);
    // …and a newer AgEnD ships different core rules.
    (fm as any).ensureGeneralInstructions(workDir, "claude-code");

    const after = readFileSync(path, "utf-8");
    expect(after).toContain("# My own preamble");
    expect(after).toContain("keep me");
    expect(after.match(/agend:core-rules/g)!.length).toBe(2); // exactly one begin + one end marker
  });

  it("second sync is byte-stable (no marker duplication)", () => {
    (fm as any).ensureGeneralInstructions(workDir, "codex");
    const path = join(workDir, "AGENTS.md");
    const first = readFileSync(path, "utf-8");
    (fm as any).ensureGeneralInstructions(workDir, "codex");
    expect(readFileSync(path, "utf-8")).toBe(first);
  });
});

describe("MCP instructions budget", () => {
  it("stays under Claude Code's ~2KB truncation with realistic long names", () => {
    const s = buildMcpCoreInstructions({
      instanceName: "a-realistically-long-instance-name-t1532671461406277715",
      workingDirectory: "/home/someuser/.agend/workspaces/a-realistically-long-instance-name-t1532671461406277715",
      runtimeIdentity: { kind: "fleet-topic", backend: "claude-code", model: "claude-sonnet-4.6-with-long-tag" },
    });
    expect(Buffer.byteLength(s, "utf-8")).toBeLessThan(2048);
    // The two contracts that must never be truncated away:
    expect(s).toContain("reply");
    expect(s).toContain("report_result");
    expect(s).toContain("NEVER re-send");
  });
});
