/**
 * M-3541 (the user, 11-23): two background subagents the leader started showed nowhere in the web chat. Recorded on
 * Claude Code 2.1.330 (tests/fixtures/subagents-m3541, scrubbed):
 *   A. one diagnostic record past 128,000 characters in the parent's 2 MB tail made the whole tail unreadable, so the
 *      Subagents row had no runs at all;
 *   B. a background launch from a turn that a task notification started was never counted;
 *   2a. the steps list showed a background Agent call as "done" the moment it was acknowledged: it now says "started in
 *      the background", and the Subagents row carries the subagent's own running/done.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { subagentLaunches } from "../src/subagent-records.js";
import { SubagentService, SUBAGENT_LINE_MAX, jsonl } from "../src/subagent-service.js";
import { ClaudeStepParser } from "../src/log-steps.js";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const DIR = join(import.meta.dirname, "fixtures", "subagents-m3541");
const SID = "49347c54-abf7-4d58-a5ab-928deaf3af33", CWD = "/rig/work";
const FIRST = "a8e6fb7bda14b1cca", SECOND = "ac284c031f1115d8e";
const raw = (name: string) => readFileSync(join(DIR, name), "utf8").trim().split("\n");
const T = (iso: string) => Date.parse(iso);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** The session as it stood at `now`, on disk: parent and children cut at `now`; a child's meta `finished` only once notified. */
function disk(now: number, extra: Record<string, object[]> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agend-m3541-")); roots.push(root);
  mkdirSync(join(root, SID, "subagents"), { recursive: true });
  const parent = raw("claude-parent.jsonl").filter((l) => T(JSON.parse(l).timestamp) <= now);
  writeFileSync(join(root, `${SID}.jsonl`), parent.join("\n") + "\n");
  for (const id of [FIRST, SECOND]) {
    const rs = [...raw(`claude-agent-${id}.jsonl`), ...(extra[id] ?? []).map((r) => JSON.stringify(r))].filter((l) => T(JSON.parse(l).timestamp) <= now);
    if (!rs.length) continue;
    writeFileSync(join(root, SID, "subagents", `agent-${id}.jsonl`), rs.join("\n") + "\n");
    const meta = JSON.parse(readFileSync(join(DIR, `claude-agent-${id}.meta.json`), "utf8"));
    if (!parent.some((l) => l.includes(`<task-id>${id}</task-id>`))) delete meta.finished;
    writeFileSync(join(root, SID, "subagents", `agent-${id}.meta.json`), JSON.stringify(meta));
  }
  return root;
}
async function runs(now: number, extra: Record<string, object[]> = {}) {
  const root = disk(now, extra);
  const svc = new SubagentService(() => ({ backend: "claude-code", sessionId: SID, cwd: CWD, path: join(root, `${SID}.jsonl`), root, owner: "o" }), undefined, () => now);
  const answer = await svc.read("leader");
  return { status: answer.status, runs: answer.runs.map((r) => ({ name: r.name, state: r.state })) };
}

describe("A: one oversized record no longer hides every run", () => {
  it("the fixture carries one diagnostic over the limit, and the tail is still read (the diagnostic as a stub)", () => {
    const lines = raw("claude-parent.jsonl");
    expect(lines.filter((l) => l.length > SUBAGENT_LINE_MAX)).toHaveLength(1);
    const records = jsonl(lines.join("\n") + "\n")!;
    expect(records).toHaveLength(lines.length);
    expect(records[1]).toEqual({ type: "api-request-shape", sessionId: SID, timestamp: JSON.parse(lines[1]!).timestamp });
  });
  it("jsonl() admits an oversized line only when it is a diagnostic; any other oversized record still refuses the window", () => {
    const pad = "x".repeat(SUBAGENT_LINE_MAX);
    expect(jsonl(`{"a":1}\n${JSON.stringify({ type: "api-request-blob", sessionId: SID, agentId: SECOND, body: pad })}\n`))
      .toEqual([{ a: 1 }, { type: "api-request-blob", sessionId: SID, agentId: SECOND }]);
    expect(jsonl(`{"a":1}\n${JSON.stringify({ type: "user", sessionId: SID, message: { content: pad } })}\n`)).toBeNull();
    expect(jsonl(`{"a":1}\n${JSON.stringify({ type: "api-request-shape", pad })}x\n`)).toBeNull();   // oversized and broken
    expect(jsonl(`{"a":1}\n{broken\n`)).toBeNull();
    expect(jsonl(`{"a":1}\n{"b":2}`)).toBeNull();
  });
  it("an oversized resumed prompt in a child never lets the old completion stand (#4358 review)", async () => {
    const done = T("2026-11-23T07:36:25Z"), resumed = { type: "user", sessionId: SID, cwd: CWD, agentId: SECOND, isSidechain: true,
      promptId: "00000000-0000-4000-8000-000000000001", timestamp: "2026-11-23T07:36:20.000Z", message: { role: "user", content: "x".repeat(SUBAGENT_LINE_MAX) } };
    expect((await runs(done)).runs).toEqual([{ name: "Describe second screenshot", state: "completed" }]);
    expect((await runs(done, { [SECOND]: [resumed] })).runs).toEqual([{ name: "Describe second screenshot", state: "unknown" }]);
  });
  it("an oversized child diagnostic is admitted with its binding: the right child keeps its completion, another child's does not", async () => {
    const done = T("2026-11-23T07:36:25Z"), diag = (agentId: string) => ({ type: "api-request-shape", sessionId: SID, agentId,
      timestamp: "2026-11-23T07:36:00.000Z", shape: "x".repeat(SUBAGENT_LINE_MAX) });
    expect((await runs(done, { [SECOND]: [diag(SECOND)] })).runs).toEqual([{ name: "Describe second screenshot", state: "completed" }]);
    expect((await runs(done, { [SECOND]: [diag(FIRST)] })).runs).toEqual([{ name: "Describe second screenshot", state: "unknown" }]);
  });
  it("the leader's first subagent is running while it works, from the real service on the recorded files", async () => {
    expect(await runs(T("2026-11-23T07:35:15Z"))).toEqual({ status: "ok", runs: [{ name: "Describe the user's screenshot", state: "running" }] });
  });
});

describe("B: a launch from a task-notification turn is counted", () => {
  it("both launches are found; the notification turn gives no parent task (its text is another subagent's report)", () => {
    const parent = raw("claude-parent.jsonl").filter((l) => l.length <= SUBAGENT_LINE_MAX).map((l) => JSON.parse(l));
    const specs = subagentLaunches({ backend: "claude-code", sessionId: SID, cwd: CWD, parent });
    expect(specs.map((s) => [s.id, s.name, s.parentTask ?? ""])).toEqual([
      [FIRST, "Describe the user's screenshot", "Please look at the attached picture."],
      [SECOND, "Describe second screenshot", ""],
    ]);
  });
  it("the second subagent is running after the first one's notification, then finished", async () => {
    expect((await runs(T("2026-11-23T07:35:45Z"))).runs).toEqual([{ name: "Describe second screenshot", state: "running" }]);
    expect((await runs(T("2026-11-23T07:36:25Z"))).runs).toEqual([{ name: "Describe second screenshot", state: "completed" }]);
  });
});

describe("2a: the steps list says a background call started, not that the work is done", () => {
  const steps = () => { const p = new ClaudeStepParser(); for (const l of raw("claude-parent.jsonl")) p.push(l); return p.steps; };
  it("each background Agent call is done with background set; other tool calls are unchanged", () => {
    const tools = steps().filter((s) => s.kind === "tool");
    const agents = tools.filter((s) => s.cat === "agent");
    expect(agents.map((s) => [s.subject, s.status, s.background])).toEqual([
      ["Describe the user's screenshot", "done", true], ["Describe second screenshot", "done", true],
    ]);
    expect(tools.filter((s) => s.cat !== "agent").every((s) => s.background === undefined)).toBe(true);
  });

  let row: any, i18n: any, pg: AppPage | null = null;
  beforeAll(async () => {
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-render.js");
    const base = installDom({ storage: { agend_tour_done: "1" } });
    row = await import("/ui/js/log-row.js"); i18n = await import("/assets/app-i18n.js");
    base.restore();
  });
  afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; });
  it("the row reads 'started in the background' in the chat (compact) and in the Log tab; an ordinary Agent call stays 'done'", async () => {
    pg = page();
    const { render, html } = await import("/assets/app-html.js");
    const host = (pg.document as any).createElement("ol"); (pg.document as any).body.append(host);
    const bg = { id: "1", kind: "tool", turn: "t", ts: 0, tool: "Agent", cat: "agent", subject: "Describe second screenshot", status: "done", background: true };
    const plain = { ...bg, id: "2", background: undefined };
    render(html`<${row.LogRow} x=${bg} compact=${true} /><${row.LogRow} x=${bg} /><${row.LogRow} x=${plain} />`, host);
    await settle();
    const marks = host.querySelectorAll(".log-status").map((e: any) => [e.className, e.textContent]);
    expect(marks).toEqual([
      ["log-status background", "started in the background"], ["log-status background", "started in the background"], ["log-status done", "done"],
    ]);
  });
});
