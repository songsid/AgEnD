import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { projectSubagents } from "../src/subagent-records.js";
import { subagentFixture } from "./helpers/subagent-fixtures.js";

const first = "ab5b36ac3f402d58b", second = "a9947907a82e086d7";
function full() {
  const f = subagentFixture("claude-code");
  for (const [id, c] of f.children) c.records = readFileSync(new URL(`./fixtures/subagents-m2739/claude-full-agent-${id}.jsonl`, import.meta.url), "utf8").trim().split("\n").map(s => JSON.parse(s));
  return f;
}
function open() {
  const f = full();
  f.parent = f.parent.filter((r: any) => r.origin?.kind !== "task-notification");
  for (const c of f.children.values()) { delete (c.meta as any).finished; c.records = c.records.filter((r: any) => Date.parse(r.timestamp) <= Date.parse("2026-11-09T07:12:29Z") || !r.timestamp); }
  f.now = Date.parse("2026-11-09T07:12:31Z");
  return f;
}
describe("Claude 2.1.319 full mixed background stream and immutable visibility", () => {
  it("recognizes running and completion with every captured child record type present", () => {
    expect(projectSubagents(open()).map(r => r.state)).toEqual(["running", "running"]);
    expect(projectSubagents(full()).map(r => r.state)).toEqual(["completed", "completed"]);
  });
  it.each(["sessionId", "cwd", "agentId", "isSidechain", "promptId"])("retains message binding despite diagnostic rows: %s", field => {
    const f = full(), c = f.children.get(first)!;
    (c.records[0] as any)[field] = field === "isSidechain" ? false : "unrelated";
    expect(projectSubagents(f).map(r => r.state)).toEqual(["unknown", "completed"]);
  });
  it("ignores only the three identified diagnostic types, never similarly named or unbound messages", () => {
    for (const type of ["api-request-extra", "assistant", "user", "attachment"]) {
      const f = full(); f.children.get(first)!.records.push({ type, sessionId: f.sessionId, agentId: first });
      expect(projectSubagents(f)[0].state, type).toBe("unknown");
    }
  });
  it.each(["sessionId", "agentId"])("retains available diagnostic identity: %s", field => {
    const f = full(); const r = f.children.get(first)!.records.find((r: any) => r.type === "api-request") as any; r[field] = "unrelated";
    expect(projectSubagents(f).map(r => r.state)).toEqual(["unknown", "completed"]);
  });
  it("Codex completion also leaves with its exact parent turn, not another turn", () => {
    const f = subagentFixture("codex"), end = (f.parent as any[]).find(r => r.payload?.type === "task_complete");
    f.now = Date.parse(end.timestamp); expect(projectSubagents(f)).toEqual([]);
    end.payload.turn_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(projectSubagents(f).map(r => r.state)).toEqual(["completed", "completed"]);
  });
  it("diagnostic timestamps and payloads do not rejuvenate silence or unknown expiry", () => {
    const f = open(); f.now += 31_000;
    const before = projectSubagents(f);
    for (const [id,c] of f.children) c.records.push({ type: "api-request", agentId: id, timestamp: new Date(f.now).toISOString(), sessionId: f.sessionId, message: { content: "completed" } });
    expect(projectSubagents(f)).toEqual(before);
    f.now += 120_000; expect(projectSubagents(f)).toEqual([]);
  });
  it("initial child written milliseconds before async result is current, then silence is uncertain", () => {
    const f = open(); for (const c of f.children.values()) c.records = c.records.slice(0, 1);
    expect(projectSubagents(f).map(r => r.state)).toEqual(["running", "running"]);
    f.now += 31_000; expect(projectSubagents(f).map(r => r.state)).toEqual(["unknown", "unknown"]);
  });
  it("parent yield does not clear a still-running background child", () => {
    const f = open(); expect(f.parent.some((r: any) => r.subtype === "turn_duration")).toBe(true);
    expect(projectSubagents(f).map(r => r.state)).toEqual(["running", "running"]);
  });
  it("late background completion shows for 15 seconds from CLI notification, not the observation", () => {
    const f = full(); f.now = Date.parse("2026-11-09T07:12:51.944Z");
    expect(projectSubagents(f).map(r => r.state)).toEqual(["completed", "completed"]);
    f.now++; expect(projectSubagents(f).map(r => r.name)).toEqual(["核對第二份範例資料"]);
    f.now = Date.parse("2026-11-09T07:12:55.788Z"); expect(projectSubagents(f)).toEqual([]);
    expect(projectSubagents(full()).length).toBe(2); // independently constructed current snapshot, not a hidden global cache
    expect(projectSubagents({ ...full(), now: f.now })).toEqual([]); // reopening cannot restart the clock
  });
  it("completed before parent ends leaves at that proven original turn end", () => {
    const f = full(), end = (f.parent as any[]).find(r => r.subtype === "turn_duration");
    end.timestamp = "2026-11-09T07:12:45Z";
    f.now = Date.parse("2026-11-09T07:12:44.999Z"); expect(projectSubagents(f)).toHaveLength(2);
    f.now++; expect(projectSubagents(f)).toEqual([]);
  });
  it.each(["parentUuid", "sessionId", "cwd", "isSidechain"])("an unbound parent end (%s) cannot clear the original task", field => {
    const f = full(), end = (f.parent as any[]).find(r => r.subtype === "turn_duration");
    end.timestamp = "2026-11-09T07:12:45Z"; end[field] = field === "isSidechain" ? true : "unrelated";
    f.now = Date.parse("2026-11-09T07:12:46Z"); expect(projectSubagents(f)).toHaveLength(2);
  });
  it("missing evidence expires from launch, with no poll or reopen revival", () => {
    const f = full(); f.children = new Map();
    f.now = Date.parse("2026-11-09T07:14:28.428Z"); expect(projectSubagents(f)).toHaveLength(2);
    f.now++; expect(projectSubagents(f)).toHaveLength(1);
    f.now = Date.parse("2026-11-09T07:14:28.458Z"); expect(projectSubagents(f)).toEqual([]);
    expect(projectSubagents(structuredClone(f))).toEqual([]);
  });
  it("future-dated launches cannot turn a missing child into permanent Unknown", () => {
    const f = full(); f.children = new Map();
    for (const r of f.parent as any[]) if (r.toolUseResult?.status === "async_launched") r.timestamp = new Date(f.now + 86400000).toISOString();
    expect(projectSubagents(f)).toEqual([]);
  });
  it("only valid advancing child evidence renews unknown visibility, never invalid identity or future time", () => {
    const f = open(); f.now = Date.parse("2026-11-09T07:14:00Z");
    const c = f.children.get(first)!; const extra = structuredClone(c.records[0]) as any; extra.timestamp = new Date(f.now).toISOString(); c.records.push(extra);
    expect(projectSubagents(f)[0].state).toBe("running");
    f.now += 60_000; expect(projectSubagents(f).map(r => r.state)).toEqual(["unknown"]);
    extra.cwd = "unrelated"; expect(projectSubagents(f)).toEqual([]);
    extra.cwd = f.cwd; extra.timestamp = new Date(f.now + 60_000).toISOString(); expect(projectSubagents(f)).toEqual([]);
  });
  it("completion without a proven end has a finite fallback, not permanent progress history", () => {
    const f = full(); f.parent = f.parent.filter((r: any) => r.subtype !== "turn_duration");
    f.now += 121_000; expect(projectSubagents(f)).toEqual([]);
  });
  it.each(["claude-code", "codex"] as const)("a future %s terminal record cannot anchor completion/expiry", backend => {
    const f = backend === "claude-code" ? full() : subagentFixture(backend);
    const future = f.now + 86400000;
    if (backend === "claude-code") {
      const n = (f.parent as any[]).find(r => r.origin?.kind === "task-notification"); n.timestamp = new Date(future).toISOString();
    } else {
      const c = f.children.values().next().value!;
      const n = c.records.find((r: any) => r.payload?.type === "task_complete") as any; n.timestamp = new Date(future).toISOString();
    }
    const rows = projectSubagents(f);
    expect(rows.map(r => r.state)).toContain("unknown");
    expect(rows.every(r => r.expiresAt! < future)).toBe(true);
    f.now += 121000; expect(projectSubagents(f)).toEqual([]);
  });
  it("an unrecognized new prompt retires turn attribution before its later assistant/end", () => {
    const f = full(), rs = f.parent as any[], index = rs.findIndex(r => r.subtype === "turn_duration"), end = rs[index];
    const later = { ...rs[0], promptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", origin: { kind: "unrecognized-system-input" }, timestamp: "2026-11-09T07:12:28.700Z" };
    const assistant = { ...rs[1], uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", parentUuid: later.uuid, timestamp: "2026-11-09T07:12:28.800Z" };
    rs.splice(index, 1, later, assistant, { ...end, parentUuid: assistant.uuid, timestamp: "2026-11-09T07:12:28.900Z" });
    f.now = Date.parse("2026-11-09T07:13:00Z");
    expect(projectSubagents(f).map(r => r.state)).toEqual(["completed", "completed"]); // no proven original end: finite terminal+120s fallback
  });
  it("a future parent duration cannot extend a completed row's deadline", () => {
    const f = full(), end = (f.parent as any[]).find(r => r.subtype === "turn_duration");
    end.timestamp = new Date(f.now + 86400000).toISOString();
    const rows = projectSubagents(f);
    expect(rows.map(r => r.expiresAt)).toEqual([Date.parse("2026-11-09T07:14:36.945Z"), Date.parse("2026-11-09T07:14:40.788Z")]);
  });
  it("a second duration for the same original assistant cannot move the first end", () => {
    const f = full(), end = (f.parent as any[]).find(r => r.subtype === "turn_duration"); f.now = Date.parse("2026-11-09T07:12:46Z");
    const before = projectSubagents(f); expect(before).toHaveLength(2);
    f.parent.push({ ...end, uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff", timestamp: "2026-11-09T07:12:45Z" });
    expect(projectSubagents(f)).toEqual(before);
  });
});
