import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildToolPermissionsNotice,
  coordinatorCandidates,
  hasExplicitFullDefault,
  instancesExplicitlyFull,
  type NoticeInput,
} from "../src/tool-permissions-notice.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-notice-"));
  dirs.push(dir);
  return dir;
}

function use(instance: string, tools: Record<string, number>) {
  return { instance, tools: new Map(Object.entries(tools)) };
}

/** Roughly what a month of this fleet's activity looked like. */
const REAL: NoticeInput = {
  defaultsToolSet: "full",
  instances: {
    "doupo-leader": {}, "agend-leader": {}, "claude-fable": {},
    "rd1-a89-dev": {}, "classic-串接": {}, "general": { general_topic: true },
  },
  recent: [
    use("doupo-leader", { restart_instance: 6, wake_instance: 7, create_instance: 1, delegate_task: 327, send_to_instance: 900 }),
    use("agend-leader", { restart_instance: 2, start_instance: 3, wake_instance: 3, delegate_task: 101 }),
    use("claude-fable", { start_instance: 1, report_result: 40 }),
    // Heavy delegators that lose nothing: delegate_task stays with the worker.
    use("rd1-a89-dev", { delegate_task: 23, report_result: 30 }),
    use("classic-串接", { delegate_task: 18 }),
    use("general", { create_instance: 15 }),
  ],
};

describe("who the notice names", () => {
  it("names only the instances that would actually lose something", () => {
    const named = coordinatorCandidates(REAL).map(c => c.instance);

    expect(named).toEqual(["doupo-leader", "agend-leader", "claude-fable"]);
  });

  it("leaves out the heavy delegators, who are not affected at all", () => {
    // `delegate_task` stays with the worker. Listing twenty instances that need
    // no change is how an operator learns to skip the next notice.
    const named = coordinatorCandidates(REAL).map(c => c.instance);

    expect(named).not.toContain("rd1-a89-dev");
    expect(named).not.toContain("classic-串接");
  });

  it("leaves out a general, which keeps its own profile", () => {
    expect(coordinatorCandidates(REAL).map(c => c.instance)).not.toContain("general");
  });

  it("leaves out an instance that is already explicitly widened", () => {
    const named = coordinatorCandidates({
      ...REAL,
      instances: { ...REAL.instances, "doupo-leader": { tool_set: "full" }, "agend-leader": { tool_set: "coordinator" } },
    }).map(c => c.instance);

    expect(named).toEqual(["claude-fable"]);
  });

  it("reports what each one used, and only the parts it would lose", () => {
    const [first] = coordinatorCandidates(REAL);

    expect(first!.instance).toBe("doupo-leader");
    const tools = Object.fromEntries(first!.refusedTools);
    expect(tools).toEqual({ wake_instance: 7, restart_instance: 6, create_instance: 1 });
    // The 327 delegate_task calls and the 900 messages are not losses.
    expect(tools).not.toHaveProperty("delegate_task");
    expect(tools).not.toHaveProperty("send_to_instance");
  });

  it("puts the most affected first, so the list reads as a priority", () => {
    expect(coordinatorCandidates(REAL).map(c => c.instance)).toEqual(["doupo-leader", "agend-leader", "claude-fable"]);
  });
});

describe("what the notice says", () => {
  it("explains that an explicit default is why nothing changed for them", () => {
    const notice = buildToolPermissionsNotice(REAL)!;

    expect(notice).toContain("defaults.tool_set: full");
    expect(notice).toContain("an explicit setting wins");
    expect(notice).toContain("`worker`");
  });

  it("names the instances to mark, with what they used", () => {
    const notice = buildToolPermissionsNotice(REAL)!;

    expect(notice).toContain("tool_set: coordinator");
    expect(notice).toContain("doupo-leader");
    expect(notice).toContain("wake_instance×7");
    expect(notice).not.toContain("rd1-a89-dev");
  });

  it("admits it can only see what has been used recently", () => {
    // The derivation reads one of the three paths a tool call can take, so it
    // is a floor and the wording has to say so.
    expect(buildToolPermissionsNotice(REAL)!).toContain("may still need marking");
  });

  it("says nothing at all to a fleet with nothing to do", () => {
    expect(buildToolPermissionsNotice({
      defaultsToolSet: undefined,
      instances: { "w": {} },
      recent: [use("w", { reply: 10, report_result: 3 })],
    })).toBeNull();
  });

  it("mentions individually widened instances when the default is not the issue", () => {
    const notice = buildToolPermissionsNotice({
      defaultsToolSet: undefined,
      instances: { "w": { tool_set: "full" }, "x": {} },
      recent: [],
    })!;

    expect(notice).toContain("tool_set: full");
    expect(notice).toContain("w");
  });

  it("never rewrites anything — it only has the config to read", () => {
    // The whole module takes a plain object and returns a string. If it ever
    // grows a way to edit fleet.yaml, that is a surprise inside somebody's own
    // file and this is where it would start.
    const source = require("node:fs").readFileSync(new URL("../src/tool-permissions-notice.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/writeFileSync|saveFleetConfig|yaml\.dump/);
  });
});

describe("spotting an explicit full", () => {
  it("sees it in the defaults and on an instance", () => {
    expect(hasExplicitFullDefault({ defaultsToolSet: "full", instances: {}, recent: [] })).toBe(true);
    expect(hasExplicitFullDefault({ defaultsToolSet: "worker", instances: {}, recent: [] })).toBe(false);
    expect(hasExplicitFullDefault({ instances: {}, recent: [] })).toBe(false);
    expect(instancesExplicitlyFull({ instances: { a: { tool_set: "full" }, b: {} }, recent: [] })).toEqual(["a"]);
  });
});

describe("reading the tool use out of the activity log", () => {
  it("counts tool calls per instance and ignores everything else", async () => {
    const { EventLog } = await import("../src/event-log.js");
    const log = new EventLog(join(tempDir(), "events.db"));
    log.logActivity("tool_call", "worker-1", "create_instance(research-b)");
    log.logActivity("tool_call", "worker-1", "create_instance(research-c)");
    log.logActivity("tool_call", "worker-1", "reply(hello)");
    log.logActivity("tool_call", "worker-2", "wake_instance(worker-1)");
    log.logActivity("message", "worker-1", "not a tool call");

    const byInstance = log.toolUseByInstance("1970-01-01 00:00:00");

    expect(Object.fromEntries(byInstance.get("worker-1")!)).toEqual({ create_instance: 2, reply: 1 });
    expect(Object.fromEntries(byInstance.get("worker-2")!)).toEqual({ wake_instance: 1 });
    expect(byInstance.size).toBe(2);
  });

  it("honours the window, so a long-dead habit does not name someone forever", async () => {
    const { EventLog } = await import("../src/event-log.js");
    const log = new EventLog(join(tempDir(), "events.db"));
    log.logActivity("tool_call", "worker-1", "create_instance(x)");

    expect(log.toolUseByInstance("2999-01-01 00:00:00").size).toBe(0);
  });
});
