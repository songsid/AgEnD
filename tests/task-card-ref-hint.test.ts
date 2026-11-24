/**
 * Every agent that has the `task` tool is told how to point at a card in a reply — `#M-3`, not a URL it builds (the
 * web chat draws the chip; a `localhost` link does not open from another machine or a phone). Written once
 * (TASK_CARD_REF_HINT, src/dashboard-permissions.ts) and shown wherever the tool is described, whatever the mode:
 *   MCP mode          → the `task` tool's description;
 *   CLI mode          → the Task Board section of agent-cli-instructions.md (a slot the prompt fills; gone with the board's commands);
 *   a running session → the what's-new notice, once, for an agent that loaded the old description.
 * Each agent reads one of the first two, so the steady cost is the one sentence. Nowhere else: not the skill, not the workflow template.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { TASK_CARD_REF_HINT, TASK_CARD_REF_SLOT, withTaskCardRef, withoutTaskCommands } from "../src/dashboard-permissions.js";
import { buildFleetInstructions } from "../src/instructions.js";
import { AGENT_WHATS_NEW, planWhatsNew } from "../src/agent-whats-new.js";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const CLI = read("src/agent-cli-instructions.md");
const count = (text: string, part: string) => text.split(part).length - 1;
const params = { instanceName: "worker", workingDirectory: "/work/project" };

describe("the sentence", () => {
  it("names the form and the thing not to do", () => {
    expect(TASK_CARD_REF_HINT).toBe("In a reply, write a card as #M-3, not a URL: the web chat shows it as a chip.");
  });
});

describe("MCP mode: the task tool's description", () => {
  const description = TOOLS.find((t) => t.name === "task")!.description!;
  it("has it once, and is still short", () => {
    expect(count(description, TASK_CARD_REF_HINT)).toBe(1);
    expect(count(description, "#M-3")).toBe(1);
    expect(Buffer.byteLength(description)).toBeLessThan(1000);   // 852 bytes before the sentence's 78
  });
  it("the fleet prompt of an MCP agent does not say it again", () => {
    expect(buildFleetInstructions({ ...params })).not.toContain("#M-3");
    expect(buildFleetInstructions({ ...params, taskBoard: false })).not.toContain("#M-3");
  });
});

describe("CLI mode: the reference the agent reads in place of the tool's description", () => {
  it("holds the slot once, as a comment at the end of the Task Board commands (not beside a command line another change edits)", () => {
    expect(count(CLI, TASK_CARD_REF_SLOT)).toBe(1);
    const lines = CLI.split("\n"), slot = lines.findIndex((l) => l.includes(TASK_CARD_REF_SLOT));
    expect(lines[slot]).toMatch(/^# /);
    expect(lines[slot - 1]).toMatch(/^agend-agent task unwatch /);
    expect(lines.findIndex((l) => l.startsWith("# Task Board "))).toBeLessThan(slot);
    expect(lines.slice(slot + 1).find((l) => l.trim() !== "")).toBe("# Decisions");
    expect(CLI).not.toContain("#M-3");                                // the words live in code, once
  });
  it("the prompt has the sentence once (the slot filled, none left over) when the agent may use the board", () => {
    for (const taskBoard of [undefined, true]) {
      const prompt = buildFleetInstructions({ ...params, cliInstructions: CLI, taskBoard });
      expect(count(prompt, TASK_CARD_REF_HINT), String(taskBoard)).toBe(1);
      expect(prompt).not.toContain("{{");
      expect(prompt).toContain(`agend-agent task unwatch M-3 [INSTANCE]           # Stop following it\n# ${TASK_CARD_REF_HINT}\n`);
    }
    expect(withTaskCardRef(CLI)).toContain(`# ${TASK_CARD_REF_HINT}\n`);
  });
  it("an agent with the board switched off is told neither the commands nor the sentence", () => {
    const prompt = buildFleetInstructions({ ...params, cliInstructions: CLI, taskBoard: false });
    expect(prompt).not.toContain(TASK_CARD_REF_HINT);
    expect(prompt).not.toContain("TASK_CARD_REF");
    expect(prompt).not.toMatch(/^\s*agend-agent task\b/m);
    expect(withoutTaskCommands(CLI)).not.toContain(TASK_CARD_REF_SLOT);
  });
});

describe("a running session is told once", () => {
  const entry = AGENT_WHATS_NEW.find((e) => e.id === "2.4-card-refs")!;
  const told = AGENT_WHATS_NEW.filter((e) => e.id !== entry.id && e.since !== entry.since).map((e) => e.id);
  it("is an entry about the task tool that carries the same sentence", () => {
    expect([entry.since, entry.tools, entry.audience]).toEqual(["2.4.0-beta.20", ["task"], undefined]);
    expect(entry.text).toContain(TASK_CARD_REF_HINT);
  });
  it("an instance that has the task tool hears it on reaching 2.4.0-beta.20, not before; one without the tool (board off, minimal) is only recorded", () => {
    const record = { announced: told };
    expect(planWhatsNew({ record, fresh: false, version: "2.4.0-beta.19", tools: new Set(["task"]) }), "beta.19 is published without it").toBeNull();
    const plan = planWhatsNew({ record, fresh: false, version: "2.4.0-beta.20", tools: new Set(["task", "reply"]) });
    expect(plan && "notice" in plan ? plan.notice : plan).toContain(`- Task cards: ${TASK_CARD_REF_HINT}`);
    const without = planWhatsNew({ record, fresh: false, version: "2.4.0-beta.20", tools: new Set(["reply"]) });
    expect(without).toEqual({ silent: expect.arrayContaining([entry.id]), version: "2.4.0-beta.20" });
  });
  it("a new instance starts with the current description: told nothing", () => {
    expect(planWhatsNew({ record: null, fresh: true, version: "2.4.0-beta.20", tools: new Set(["task"]) })).toEqual({ silent: expect.arrayContaining([entry.id]), version: "2.4.0-beta.20" });
  });
});

describe("said nowhere else", () => {
  it("not in the task-board skill (read on demand) nor the built-in workflow template", () => {
    for (const file of ["src/general-knowledge/skills/task-board/SKILL.md", "src/workflow-templates/default.md"]) expect(read(file), file).not.toContain("#M-3");
  });
});
