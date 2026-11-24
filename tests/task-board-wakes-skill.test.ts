/**
 * What an agent is told about waking and following: the `task` tool's description names the rule in a clause and the
 * actions, and the task-board skill spells it out (the tool description is in every agent's prompt, the skill is read when
 * the agent needs it).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { TaskBoardArgs } from "../src/outbound-schemas.js";
import { AGENT_COMMENT_CHAIN, AGENT_PROGRESS_CHAIN, MAX_COMMENT_WAKES, MAX_WATCHERS } from "../src/scheduler/task-board.js";

const skill = readFileSync(join(process.cwd(), "src/general-knowledge/skills/task-board/SKILL.md"), "utf8");
const task = TOOLS.find((t) => t.name === "task")!;

describe("the task tool and its skill say how comments wake and how a card is followed", () => {
  it("the description has one clause for each and points to the skill; watch and unwatch are actions of the schema", () => {
    expect(task.description).toContain("wakes you");
    expect(task.description).toContain("@<instance>");
    expect(task.description).toContain("watch / unwatch");
    expect(task.description).toContain("task-board skill");
    const actions = (task.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum!;
    expect(actions).toEqual(expect.arrayContaining(["watch", "unwatch"]));
    expect(Object.keys((task.inputSchema.properties as object))).toContain("watcher");
    expect(TaskBoardArgs.safeParse({ action: "watch", id: "M-1", watcher: "dev-a" }).success).toBe(true);
  });
  it("the skill keeps the rules and the limits the code enforces", () => {
    for (const words of ["wakes you with a `[task board]` notice", "no `@` is needed to answer them", "a comment never\n  wakes its writer", "the instance that handed a card out", "never the one who did it", "step in"])
      expect(skill.toLowerCase().replace(/\s+/g, " "), words).toContain(words.toLowerCase().replace(/\s+/g, " "));
    expect(skill).toContain(`at most ${AGENT_COMMENT_CHAIN} turns`);
    expect(skill).toContain(`wakes at most ${MAX_COMMENT_WAKES} instances`);
    expect(skill).toContain(`after ${AGENT_PROGRESS_CHAIN} changes in 30 minutes`);
    expect(skill).toContain(`at most ${MAX_WATCHERS} per card`);
  });
});
