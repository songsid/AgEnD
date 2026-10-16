/**
 * Board 0340ec89: agy reads `.agents/AGENTS.md`, not the lowercase `.agents/agents.md` AgEnD wrote — on a case-sensitive
 * filesystem it never saw its fleet instructions (tests/fixtures/agy-1.3.6-audit).
 * - Written to `.agents/AGENTS.md`; the reload notice and General's file name it.
 * - A legacy `.agents/agents.md` alone becomes `.agents/AGENTS.md` (renamed whole: a person's lines kept); beside a
 *   person's own `.agents/AGENTS.md` it stays, and only AgEnD's blocks move out of it.
 * - On a case-insensitive filesystem the two names are one file (modelled by a hard link: the same inode): nothing moves.
 * - #1914 review: the move never replaces what is at the new name — one that appears just before the move (the race),
 *   a directory, a dangling symlink. A dangling symlink is kept and not written through: the launch says so instead.
 */
// The race: just before the fs call that moves the legacy file, something appears at the new name.
const race = vi.hoisted(() => ({ before: null as null | ((src: string) => void) }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const hook = <F extends (...a: any[]) => any>(f: F) => ((...a: Parameters<F>) => { race.before?.(String(a[0])); return f(...a); }) as F;
  return { ...real, linkSync: hook(real.linkSync), renameSync: hook(real.renameSync) };
});
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFileSync: () => { throw new Error("no agy here"); }, spawnSync: () => ({ status: 1, stdout: "", stderr: "" }) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_AGENTS_FILE, AntigravityBackend, agyLegacyAgentsFile, migrateAgyAgentsFile } from "../src/backend/antigravity.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { buildInstructionReloadNotice } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";

const FX = new URL("./fixtures/agy-1.3.6-audit/", import.meta.url);
let root: string, workspace: string, instanceDir: string, backend: AntigravityBackend;
const upper = () => join(workspace, ".agents", "AGENTS.md");
const lower = () => join(workspace, ".agents", "agents.md");
const block = (id: string, body: string) => `<!-- AGEND:${id}:BEGIN -->\n${body}\n<!-- AGEND:${id}:END -->\n`;
const config = (over: Partial<CliBackendConfig> = {}): CliBackendConfig => ({
  workingDirectory: workspace, instanceDir, instanceName: "agy-worker", agentMode: "cli", instructions: "# Fleet instructions v2", mcpServers: {}, ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-agy-0340-"));
  workspace = join(root, "ws");
  instanceDir = join(root, "agend", "instances", "agy-worker");
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(instanceDir, { recursive: true });
  backend = new AntigravityBackend(instanceDir, join(root, "home"), join(root, "agend"));
});
afterEach(() => { race.before = null; rmSync(root, { recursive: true, force: true }); });

describe("what agy 1.3.6 loads (the saved capture)", () => {
  it("lists .agents/AGENTS.md, AGENTS.md and GEMINI.md after its own /compact — not the lowercase file beside them", () => {
    const pane = readFileSync(new URL("instructions-and-compact.pane.txt", FX), "utf8");
    expect(pane).toContain("Conversation compacted");
    for (const loaded of ["AGY-ROOT-AGENTS", "AGY-GEMINI-MD", "AGY-UPPER-AGENTS"]) expect(pane).toContain(loaded);
    for (const unread of ["AGY-MARKER-5T1", "AGY-RULES-DIR"]) expect(pane).not.toContain(unread);
    expect(readFileSync(new URL("README.md", FX), "utf8")).toContain("`.agents/agents.md` (what AgEnD wrote before) | `AGY-MARKER-5T1` | **no**");
  });
});

describe("the instructions file", () => {
  it("is written to .agents/AGENTS.md, and nothing under the lowercase name", () => {
    backend.writeConfig(config());
    expect(AGY_AGENTS_FILE).toBe(join(".agents", "AGENTS.md"));
    expect(readFileSync(upper(), "utf8")).toBe(block("agy-worker", "# Fleet instructions v2"));
    expect(existsSync(lower())).toBe(false);
  });

  it("a legacy file alone becomes the new one, whole: a person's lines are kept and AgEnD's block is replaced", () => {
    writeFileSync(lower(), `My own agy rules.\n\n${block("agy-worker", "# Fleet instructions v1")}`);
    backend.writeConfig(config());
    expect(existsSync(lower())).toBe(false);
    const text = readFileSync(upper(), "utf8");
    expect(text).toContain("My own agy rules.");
    expect(text).toContain("# Fleet instructions v2");
    expect(text).not.toContain("# Fleet instructions v1");
  });

  it("beside a person's own .agents/AGENTS.md: their file keeps its text, and only this instance's block leaves the legacy file", () => {
    writeFileSync(upper(), "Their own new-style rules.\n");
    writeFileSync(lower(), `Their old rules.\n\n${block("agy-worker", "# Fleet instructions v1")}${block("agy-other", "# Other instance")}`);
    backend.writeConfig(config());
    const now = readFileSync(upper(), "utf8");
    expect(now.startsWith("Their own new-style rules.\n")).toBe(true);
    expect(now).toContain(block("agy-worker", "# Fleet instructions v2"));
    const old = readFileSync(lower(), "utf8");
    expect(old).toContain("Their old rules.");
    expect(old).toContain("# Other instance");                         // another instance moves its own block, at its launch
    expect(old).not.toContain("agy-worker");
  });

  it("a legacy file that held only this instance's block (beside a new one) is removed", () => {
    writeFileSync(upper(), "Their own new-style rules.\n");
    writeFileSync(lower(), block("agy-worker", "# Fleet instructions v1"));
    backend.writeConfig(config());
    expect(existsSync(lower())).toBe(false);
  });

  it("case-insensitive filesystem (the two names one file, modelled by a hard link): nothing is renamed or removed", () => {
    writeFileSync(lower(), `My own agy rules.\n\n${block("agy-worker", "# Fleet instructions v1")}`);
    linkSync(lower(), upper());                                          // the same inode under both names, as APFS resolves them
    expect(agyLegacyAgentsFile(workspace)).toBeNull();
    backend.writeConfig(config());
    expect(statSync(upper()).ino).toBe(statSync(lower()).ino);
    const text = readFileSync(upper(), "utf8");
    expect(text).toContain("My own agy rules.");
    expect(text).toContain("# Fleet instructions v2");
    expect(text.match(/AGEND:agy-worker:BEGIN/g)).toHaveLength(1);
  });

  it("a migration another instance already made is not repeated (nothing to move)", () => {
    writeFileSync(upper(), block("agy-a", "a"));
    expect(() => migrateAgyAgentsFile(workspace)).not.toThrow();
    expect(readFileSync(upper(), "utf8")).toBe(block("agy-a", "a"));
  });

  it("race: a file that appears at the new name just before the move is kept, and the legacy file stays", () => {
    writeFileSync(lower(), `Old rules.\n\n${block("agy-worker", "# Fleet instructions v1")}`);
    race.before = src => { if (src === lower()) { race.before = null; writeFileSync(upper(), "Theirs, made meanwhile.\n"); } };
    backend.writeConfig(config());
    expect(readFileSync(upper(), "utf8").startsWith("Theirs, made meanwhile.\n")).toBe(true);
    expect(readFileSync(upper(), "utf8")).toContain(block("agy-worker", "# Fleet instructions v2"));
    expect(readFileSync(lower(), "utf8")).toBe("Old rules.\n");      // only this instance's block left it
  });

  it("a directory at the new name is kept: the legacy file is not moved onto or into it", () => {
    writeFileSync(lower(), "Old rules.\n");
    mkdirSync(upper());
    migrateAgyAgentsFile(workspace);
    expect(statSync(upper()).isDirectory()).toBe(true);
    expect(readFileSync(lower(), "utf8")).toBe("Old rules.\n");
  });

  it("a dangling symlink at the new name is kept and not written through; the launch warns instead", () => {
    const away = join(root, "elsewhere", "rules.md");
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(away, upper());
    writeFileSync(lower(), `Old rules.\n\n${block("agy-worker", "# Fleet instructions v1")}`);
    backend.writeConfig(config());
    expect(lstatSync(upper()).isSymbolicLink()).toBe(true);
    expect(existsSync(away)).toBe(false);                               // nothing created where it points
    expect(readFileSync(lower(), "utf8")).toBe("Old rules.\n");      // not moved over the link
    expect(backend.consumeLaunchWarning()).toContain(upper());
    expect(backend.consumeLaunchWarning()).toBeNull();
    writeFileSync(away, "Now it points somewhere.\n");                 // control: a live link is written through
    backend.writeConfig(config());
    expect(lstatSync(upper()).isSymbolicLink()).toBe(true);
    expect(readFileSync(away, "utf8")).toContain(block("agy-worker", "# Fleet instructions v2"));
    expect(backend.consumeLaunchWarning()).toBeNull();
  });

  it("cleanup takes this instance's block from both files and leaves a person's text", () => {
    writeFileSync(upper(), `Mine.\n\n${block("agy-worker", "x")}`);
    writeFileSync(lower(), `Old mine.\n\n${block("agy-worker", "y")}`);
    backend.cleanup(config());
    expect(readFileSync(upper(), "utf8")).not.toContain("agy-worker");
    expect(readFileSync(upper(), "utf8")).toContain("Mine.");
    expect(readFileSync(lower(), "utf8")).not.toContain("agy-worker");
    writeFileSync(upper(), block("agy-worker", "x"));
    rmSync(lower());
    backend.cleanup(config());
    expect(existsSync(upper())).toBe(false);
  });

  it("the reload notice names .agents/AGENTS.md", () => {
    expect(buildInstructionReloadNotice("agy", "agy-worker", instanceDir)).toContain("Reload only .agents/AGENTS.md;");
  });
});

describe("General on agy", () => {
  const fm = () => new FleetManager(join(root, "data"));

  it("its old file under the lowercase name becomes the one agy reads, with a person's edits and the core rules", () => {
    writeFileSync(lower(), "# Fleet Coordinator\n\nMy edited coordinator notes.\n");
    (fm() as any).ensureGeneralInstructions(workspace, "antigravity");
    expect(existsSync(lower())).toBe(false);
    const text = readFileSync(upper(), "utf8");
    expect(text).toContain("My edited coordinator notes.");
    expect(text).toContain("agend:core-rules");
  });

  it("a dangling symlink where its file goes is kept, and nothing is created where it points", () => {
    const away = join(root, "elsewhere.md");
    symlinkSync(away, upper());
    (fm() as any).ensureGeneralInstructions(workspace, "antigravity");
    expect(lstatSync(upper()).isSymbolicLink()).toBe(true);
    expect(existsSync(away)).toBe(false);
  });

  it("beside a person's own new file: the core-rules block leaves the legacy file, their text stays", () => {
    writeFileSync(upper(), "Their own.\n");
    const f = fm() as any;
    writeFileSync(lower(), `Old coordinator text.\n\n${(FleetManager as any).STEERING_BLOCK_BEGIN}\nold rules\n${(FleetManager as any).STEERING_BLOCK_END}\n`);
    f.ensureGeneralInstructions(workspace, "antigravity");
    expect(readFileSync(upper(), "utf8")).toContain("agend:core-rules");
    const old = readFileSync(lower(), "utf8");
    expect(old).toContain("Old coordinator text.");
    expect(old).not.toContain("agend:core-rules");
  });
});
