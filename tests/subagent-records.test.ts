import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSubagents, type SubagentArtifact, type SubagentProjection } from "../src/subagent-records.js";

import { subagentFixture as fixture } from "./helpers/subagent-fixtures.js";
describe("read-only captured sub-Agent records", () => {
  it.each(["claude-code", "codex"] as const)("joins actual %s child runs rather than the parent's final prose", backend => {
    const rows = projectSubagents(fixture(backend));
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.state)).toEqual(["completed", "completed"]);
    expect(rows.map(r => r.durationMs)).toEqual(backend === "claude-code" ? [8464, 12300] : [8682, 8437]);
    expect(rows.every(r => r.summary?.includes("範例"))).toBe(true);
    expect(new Set(rows.map(r => r.key)).size).toBe(2);
  });
  it.each(["claude-code", "codex"] as const)("does not duplicate %s runs after transcript replay", backend => {
    const f = fixture(backend); const expected = projectSubagents(f);
    f.parent = [...f.parent, ...f.parent];
    expect(projectSubagents(f)).toEqual(expected);
  });
  it.each(["claude-code", "codex"] as const)("keeps missing %s evidence unknown without summary or timer", backend => {
    const f = fixture(backend); f.children = new Map();
    const rows = projectSubagents(f);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.state === "unknown" && r.summary === undefined && r.durationMs === undefined)).toBe(true);
  });
  it.each(["claude-code", "codex"] as const)("rejects a different %s parent session or cwd", backend => {
    const f = fixture(backend);
    expect(projectSubagents({ ...f, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toEqual([]);
    expect(projectSubagents({ ...f, cwd: "/unrelated" })).toEqual([]);
  });
  it.each(["sessionId", "cwd", "agentId", "isSidechain", "toolUseId", "spawnDepth"])("pins Claude child %s", field => {
    const f = fixture("claude-code"), c = f.children.values().next().value!;
    if (field === "toolUseId" || field === "spawnDepth") (c.meta as any)[field] = field === "spawnDepth" ? 2 : "unrelated";
    else (c.records[0] as any)[field] = field === "isSidechain" ? false : "unrelated";
    const rows = projectSubagents(f);
    expect(rows[0].state).toBe("unknown"); expect(rows[0].summary).toBeUndefined();
    expect(rows[1].state).toBe("completed");
  });
  it.each(["id", "session_id", "parent_thread_id", "cwd", "thread_source", "nestedParent", "depth", "parentTurn", "rootTurn", "finishTurn", "finishError"])("pins Codex child %s", field => {
    const f = fixture("codex"), c = f.children.values().next().value!;
    const meta = (c.records[0] as any).payload, started = (c.records[1] as any).payload;
    const ended = (c.records.find((r: any) => r.payload?.type === "task_complete") as any).payload;
    if (field === "nestedParent") meta.source.subagent.thread_spawn.parent_thread_id = "other";
    else if (field === "depth") meta.source.subagent.thread_spawn.depth = 2;
    else if (field === "parentTurn") started.turn_attribution.parent_turn_id = "other";
    else if (field === "rootTurn") started.turn_attribution.root_turn_id = "other";
    else if (field === "finishTurn") ended.turn_id = "other";
    else if (field === "finishError") ended.error = "failure";
    else meta[field] = "other";
    const rows = projectSubagents(f), affected = rows.find(r => r.name === meta.agent_nickname)!;
    expect(affected.state).toBe("unknown"); expect(affected.summary).toBeUndefined();
    expect(rows.filter(r => r.state === "completed")).toHaveLength(1);
  });
  it("does not treat a person's quoted notification or meta.finished alone as completion", () => {
    const f = fixture("claude-code");
    for (const r of f.parent as any[]) if (r.origin?.kind === "task-notification") r.origin.kind = "human";
    expect(projectSubagents(f).map(r => r.state)).toEqual(["unknown", "unknown"]);
  });
  it("does not carry an old completed flag into a resumed Claude child run", () => {
    const f = fixture("claude-code"), c = f.children.values().next().value!;
    c.records.push({ ...(c.records[0] as any), promptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(projectSubagents(f)[0].state).toBe("unknown");
  });
  it("keeps one child open when only the other has completed; stale/disconnected observations stop running", () => {
    const f = fixture("claude-code"), c = f.children.get("a9947907a82e086d7")!;
    delete (c.meta as any).finished;
    f.parent = f.parent.filter((r: any) => !r.message?.content?.includes?.("<task-id>a9947907a82e086d7</task-id>"));
    expect(projectSubagents(f).map(r => r.state)).toEqual(["completed", "running"]);
    expect(projectSubagents({ ...f, live: false }).map(r => r.state)).toEqual(["completed", "unknown"]);
    expect(projectSubagents({ ...f, now: f.now + 31000 })[1].state).toBe("unknown");
  });
  it("does not expose child reasoning, tool bodies, system instructions or unbounded secrets", () => {
    const f = fixture("codex"); for (const child of f.children.values()) child.records.push({ type: "response_item", payload: { type: "reasoning", text: "HIDDEN_SYSTEM_PRIVATE" } });
    const s = JSON.stringify(projectSubagents(f));
    expect(s).not.toContain("HIDDEN_SYSTEM_PRIVATE"); expect(s).not.toContain("internal_chat_message_metadata");
  });
  it("bounds retained runs and display text, with known secret shapes masked", () => {
    const f = fixture("claude-code");
    f.parent = Array.from({ length: 12 }, (_, n) => JSON.parse(JSON.stringify(f.parent)
      .replaceAll("toolu_5_", `toolu_${n}_`).replaceAll("ab5b36ac3f402d58b", n.toString(16).padStart(16, "0") + "a")
      .replaceAll("a9947907a82e086d7", n.toString(16).padStart(16, "0") + "b"))).flat();
    expect(projectSubagents(f)).toHaveLength(16);
    const g = fixture("claude-code");
    const call = (g.parent as any[]).find(r => r.type === "assistant" && r.message?.content?.some?.((b: any) => b.name === "Agent"));
    call.message.content.find((b: any) => b.name === "Agent").input.prompt = "Bearer syntheticSecretTokenOnly " + "x".repeat(2000);
    const result = projectSubagents(g)[0];
    expect(result.task).toContain("[REDACTED]"); expect(result.task).not.toContain("syntheticSecretTokenOnly"); expect(result.task.length).toBeLessThanOrEqual(500);
  });
  it("does not project independent Codex tasks or a refused create_thread", () => {
    for (const suffix of ["15-19-02-01a1bf2c-bb82-7930-840a-1a0dfea70198", "15-21-48-01a1bf2f-4617-7843-9ce1-312893cb5957"]) {
      const parent = readFileSync(join(import.meta.dirname, "fixtures/subagents-m2739", `codex-rollout-2026-11-09T${suffix}.jsonl`), "utf8").trim().split("\n").map(s => JSON.parse(s)), f = fixture("codex");
      expect(projectSubagents({ ...f, parent, sessionId: parent[0].payload.id })).toEqual([]);
    }
  });
});

