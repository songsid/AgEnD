/**
 * M-3523 / S-215 (instruction inventory rec 10): every Fleet agent's instructions carry one Memory section about
 * soul.md: optional and never auto-loaded, three parts with the current state rewritten in place, about 30 KB and why,
 * when to update, and a one-time question with a remembered decline. General's core rules point to it and keep only
 * their own part (fleet decisions, skills), so General reads the soul.md guidance once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFleetInstructions, buildNativeFleetInstructions, type FleetInstructionsParams } from "../src/instructions.js";
import { MEMORY_SECTION } from "../src/memory-guidance.js";

const RULES = readFileSync(join(__dirname, "..", "src", "general-knowledge", "steering", "core-rules.md"), "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;
const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "grok", "muse", "antigravity"];

describe("the Memory section", () => {
  it("states the soul.md guidance", () => {
    for (const part of ["`soul.md`", "AgEnD does not load it", "**Current state**", "rewrite it to describe now",
      "**Rules**", "**History index**", "30 KB", "every line costs context", "stale cautions",
      "multi-step work that taught you something reusable", "before compaction", "routine work needs none",
      "ask the user once", "with buttons", "`soul.declined`", "consider it answered", "Propose a skill"]) {
      expect(MEMORY_SECTION, part).toContain(part);
    }
  });
  it("is written as things to do", () => {
    expect(MEMORY_SECTION).not.toMatch(/\b(NOT|NEVER|Don't|Do not|never)\b/);
  });

  const cases: [string, FleetInstructionsParams][] = [];
  for (const backend of BACKENDS) {
    for (const kind of ["fleet-topic", "classic"] as const) {
      cases.push([`${kind} on ${backend}`, { instanceName: "a", workingDirectory: "/w", runtimeIdentity: { kind, backend, model: "m" } }]);
    }
  }
  cases.push(["CLI mode", { instanceName: "a", workingDirectory: "/w", cliInstructions: "# CLI reference" }]);
  cases.push(["no workflow template", { instanceName: "a", workingDirectory: "/w", workflow: false }]);
  it.each(cases)("appears exactly once for %s, after the workflow and before the decisions", (_label, params) => {
    const text = buildFleetInstructions({ ...params, decisions: [{ title: "T", content: "C." }] });
    expect(count(text, MEMORY_SECTION)).toBe(1);
    expect(text.indexOf(MEMORY_SECTION)).toBeLessThan(text.indexOf("## Active Decisions"));
    if (params.workflow !== false) expect(text.indexOf("## Communication Protocol")).toBeLessThan(text.indexOf(MEMORY_SECTION));
  });
  it("reaches the native General and worker too", () => {
    const params = { instanceName: "general", workingDirectory: "C:\\owned", workflow: false as const };
    expect(count(buildNativeFleetInstructions(params, true), MEMORY_SECTION)).toBe(1);
    expect(count(buildNativeFleetInstructions(params, false), MEMORY_SECTION)).toBe(1);
  });
});

describe("General's core rules keep only their own part", () => {
  const memory = RULES.slice(RULES.indexOf("## Memory & Knowledge Management"));
  it("points to the Memory section instead of repeating it", () => {
    expect(memory).toContain("**Memory** section of your fleet instructions");
    for (const repeated of ["soul.declined", "30 KB", "History index", "Current state"]) expect(memory, repeated).not.toContain(repeated);
  });
  it("keeps fleet decisions short and the skills directories", () => {
    expect(memory).toContain("**Fleet decisions**");
    expect(memory).toContain("resent with every request");
    for (const dir of [".kiro/skills/", ".claude/skills/", ".agents/skills/", ".grok/skills/"]) expect(memory).toContain(dir);
  });
});
