/**
 * M-3529 (instruction inventory rec 13): General's role text is a managed block in its host instructions file, replaced
 * on every sync like the core-rules block, so a wording change reaches Generals created before it. AgEnD's own earlier
 * unmarked copy is adopted into the block; a person's own coordinator text is kept as it is. The native (Windows)
 * General gets the role once, from its dedicated workspace's CLAUDE.md / AGENTS.md, not also in its fleet instructions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { GENERAL_ROLE_INSTRUCTIONS } from "../src/general-role.js";
import { GENERAL_ROLE_BLOCK_BEGIN, GENERAL_ROLE_BLOCK_END, placeGeneralRole } from "../src/general-role-block.js";
import { buildFleetInstructions, buildNativeFleetInstructions } from "../src/instructions.js";
import { loadGeneralKnowledge } from "../src/runtime-general-workspace.js";

const OLDEST_ROLE = readFileSync(join(__dirname, "fixtures", "general-role-2026-04.md"), "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;

describe("placeGeneralRole", () => {
  it("writes the block alone for a new file", () => {
    const { text, placement } = placeGeneralRole(null);
    expect(placement).toBe("created");
    expect(text).toBe(`${GENERAL_ROLE_BLOCK_BEGIN}\n${GENERAL_ROLE_INSTRUCTIONS.trim()}\n${GENERAL_ROLE_BLOCK_END}\n`);
  });

  it("replaces only what is between the markers, and is byte-stable when nothing changed", () => {
    const first = placeGeneralRole(null).text + "\n## Mine\nkeep me\n";
    const same = placeGeneralRole(first);
    expect(same).toEqual({ text: first, placement: "unchanged" });
    const updated = placeGeneralRole("# Before\n\n" + first, "# Fleet Coordinator\n\nNew wording.\n");
    expect(updated.placement).toBe("updated");
    expect(updated.text).toBe(`# Before\n\n${GENERAL_ROLE_BLOCK_BEGIN}\n# Fleet Coordinator\n\nNew wording.\n${GENERAL_ROLE_BLOCK_END}\n\n## Mine\nkeep me\n`);
  });

  it.each([
    ["the current role text", GENERAL_ROLE_INSTRUCTIONS],
    ["the oldest role text (2026-04)", OLDEST_ROLE],
  ])("adopts %s that AgEnD wrote without markers, keeping everything after it", (_label, role) => {
    const tail = "\n\n<!-- >>> agend:core-rules — managed by AgEnD; edits inside this block are overwritten -->\nrules\n<!-- <<< agend:core-rules -->\n\nMy notes.\n";
    const { text, placement } = placeGeneralRole(role.trimEnd() + tail);
    expect(placement).toBe("adopted");
    expect(text).toBe(`${GENERAL_ROLE_BLOCK_BEGIN}\n${GENERAL_ROLE_INSTRUCTIONS.trim()}\n${GENERAL_ROLE_BLOCK_END}${tail}`);
  });

  it("keeps a person's own edited coordinator text as it is", () => {
    for (const own of ["# Fleet Coordinator\n\nMy edited coordinator notes.\n", GENERAL_ROLE_INSTRUCTIONS.replace("route tasks", "route work"), OLDEST_ROLE.trimEnd() + "extra"]) {
      expect(placeGeneralRole(own)).toEqual({ text: own, placement: "customized" });
    }
  });

  it("puts the block first in any other file, such as a project's own CLAUDE.md", () => {
    const { text, placement } = placeGeneralRole("# Project notes\n\nBuild with make.\n");
    expect(placement).toBe("added");
    expect(text).toBe(`${GENERAL_ROLE_BLOCK_BEGIN}\n${GENERAL_ROLE_INSTRUCTIONS.trim()}\n${GENERAL_ROLE_BLOCK_END}\n\n# Project notes\n\nBuild with make.\n`);
  });
});

describe("existing Generals receive role updates on sync", () => {
  let dataDir: string, workDir: string;
  const original = (FleetManager as any).GENERAL_INSTRUCTIONS as string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "agend-role-data-"));
    workDir = mkdtempSync(join(tmpdir(), "agend-role-work-"));
  });
  afterEach(() => {
    (FleetManager as any).GENERAL_INSTRUCTIONS = original;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["codex", "AGENTS.md"],
    ["antigravity", ".agents/AGENTS.md"],
  ])("%s: a file from before the markers is adopted, then follows a newer role text", (backend, file) => {
    const path = join(workDir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, GENERAL_ROLE_INSTRUCTIONS + "\n## My section\nkeep me\n");
    const fm = new FleetManager(dataDir) as any;

    fm.ensureGeneralInstructions(workDir, backend);
    const adopted = readFileSync(path, "utf8");
    expect(count(adopted, GENERAL_ROLE_BLOCK_BEGIN)).toBe(1);
    expect(count(adopted, "# Fleet Coordinator")).toBe(1);
    expect(adopted).toContain("keep me");
    fm.ensureGeneralInstructions(workDir, backend);
    expect(readFileSync(path, "utf8")).toBe(adopted);

    (FleetManager as any).GENERAL_INSTRUCTIONS = "# Fleet Coordinator\n\nA newer role text.\n";
    fm.ensureGeneralInstructions(workDir, backend);
    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("A newer role text.");
    expect(updated).not.toContain("You route tasks");
    expect(updated).toContain("keep me");
    expect(count(updated, GENERAL_ROLE_BLOCK_BEGIN)).toBe(1);
    expect(count(updated, "agend:core-rules")).toBe(2);
  });

  it("a person's own coordinator text is never replaced", () => {
    const path = join(workDir, "CLAUDE.md");
    writeFileSync(path, "# Fleet Coordinator\n\nMy own routing rules.\n");
    (new FleetManager(dataDir) as any).ensureGeneralInstructions(workDir, "claude-code");
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("# Fleet Coordinator\n\nMy own routing rules.\n")).toBe(true);
    expect(text).not.toContain(GENERAL_ROLE_BLOCK_BEGIN);
    expect(text).toContain("agend:core-rules");
  });
});

describe("native General: the role once", () => {
  const params = { instanceName: "general", workingDirectory: "C:\\owned", workflow: false as const };
  it("its fleet instructions carry the Windows boundary but not the role text", () => {
    const general = buildNativeFleetInstructions(params, true);
    expect(general).not.toContain(GENERAL_ROLE_INSTRUCTIONS);
    expect(general).not.toContain("# Fleet Coordinator");
    expect(general).toContain("## Windows execution boundary");
    expect(general.endsWith(buildFleetInstructions(params))).toBe(true);
  });
  it.each(["codex", "claude-code"] as const)("its %s workspace pack carries the role text exactly once", cli => {
    const { files } = loadGeneralKnowledge(cli);
    const file = files[cli === "codex" ? "AGENTS.md" : "CLAUDE.md"];
    expect(count(file, GENERAL_ROLE_INSTRUCTIONS)).toBe(1);
  });
});
