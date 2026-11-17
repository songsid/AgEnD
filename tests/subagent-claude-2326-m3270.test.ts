/**
 * M-3270 (the user, 11-17: the chat's "Subagents" row no longer appears). Recorded on Claude Code 2.1.326
 * (tests/fixtures/subagents-m3270, manifest.json): a parent that launches one background child without naming a type, while
 * the parent is busy — so the child's notifications arrive as queued attachments, the later ones without a tool-use-id —
 * and a child that waits on its own background command between them. Every one of these made the row "unconfirmed" (or
 * nothing, after 2 minutes):
 *   - no subagent_type: the child runs as the built-in general-purpose agent, which its meta names;
 *   - the notifications: `attachment.type: "queued_command"`, `commandMode: "task-notification"` (not a user record);
 *   - an interim notification ("… is waiting on its own background work") is not the end;
 *   - a child transcript past 512 KB (attachments and API diagnostics: ~350 KB at its first turn) was refused unread.
 * The 2.1.319 captures (subagents-m2739) keep their own tests.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectSubagents, type SubagentProjection } from "../src/subagent-records.js";
import { SubagentService } from "../src/subagent-service.js";

const DIR = new URL("./fixtures/subagents-m3270/", import.meta.url);
const SID = "43cb84b6-3551-4db6-84de-5edd5a712315", AID = "a2d43408cbd62385c", CWD = "/rig/work";
const lines = (name: string) => readFileSync(new URL(name, DIR), "utf8").trim().split("\n").map((s) => JSON.parse(s));
const T = (iso: string) => Date.parse(iso);
function fixture(now: number): SubagentProjection {
  return { backend: "claude-code", sessionId: SID, cwd: CWD, parent: lines("claude-parent.jsonl"), now, live: true,
    children: new Map([[AID, { records: lines(`claude-agent-${AID}.jsonl`), meta: JSON.parse(readFileSync(new URL(`claude-agent-${AID}.meta.json`, DIR), "utf8")) }]]) };
}
/** The fixture as it stood at `now`: parent and child records written by then; the meta's `finished` once it was. */
function at(now: number): SubagentProjection {
  const f = fixture(now);
  f.parent = f.parent.filter((r: any) => T(r.timestamp) <= now);
  const c = f.children.get(AID)!;
  c.records = c.records.filter((r: any) => !r.timestamp || T(r.timestamp) <= now);
  // The meta is marked finished when the child first stops (its first notification); not before.
  if (!f.parent.some((r: any) => r.type === "attachment" || r.type === "queue-operation")) { const m = { ...(c.meta as object) } as any; delete m.finished; c.meta = m; }
  return f;
}
const states = (f: SubagentProjection) => projectSubagents(f).map((r) => ({ state: r.state, name: r.name, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) }));

describe("M-3270: Claude Code 2.1.326 — a background child launched without a type, notified while the parent is busy", () => {
  it("running while it works, still running while it waits on its own background command, completed at its final notification", () => {
    const name = "Fixture: short background subagent";
    expect(states(at(T("2026-11-17T05:11:27.000Z")))).toEqual([{ state: "running", name }]);           // just launched, working
    expect(states(at(T("2026-11-17T05:11:50.000Z")))).toEqual([{ state: "running", name }]);           // interim 1: waiting
    expect(states(at(T("2026-11-17T05:12:05.000Z")))).toEqual([{ state: "running", name }]);           // 36 s of silence, still waiting
    expect(states(at(T("2026-11-17T05:12:30.000Z")))).toEqual([{ state: "running", name }]);           // interim 2 (no tool-use-id)
    expect(states(at(T("2026-11-17T05:12:51.000Z")))).toEqual([{ state: "completed", name, durationMs: 85411 }]);
  });
  it("while the parent is still busy, the queue's enqueue record (written at once; the attachment comes when the turn takes it in) already tells", () => {
    const busy = (now: number) => { const f = at(now); f.parent = f.parent.filter((r: any) => r.type !== "attachment"); return f; };
    const name = "Fixture: short background subagent";
    expect(states(busy(T("2026-11-17T05:12:05.000Z")))).toEqual([{ state: "running", name }]);
    expect(states(busy(T("2026-11-17T05:12:51.000Z")))).toEqual([{ state: "completed", name, durationMs: 85411 }]);
    // An enqueued text that is not a task notification from its start (a typed prompt quoting one) is never one.
    const f = busy(T("2026-11-17T05:12:51.000Z"));
    for (const r of f.parent as any[]) if (r.type === "queue-operation") r.content = "quoted: " + r.content;
    expect(projectSubagents(f).map((r) => r.state)).not.toEqual(["completed"]);
    // Another session's queue never tells this one.
    const g = busy(T("2026-11-17T05:12:51.000Z"));
    for (const r of g.parent as any[]) if (r.type === "queue-operation") r.sessionId = "00000000-0000-4000-8000-000000000000";
    expect(projectSubagents(g).map((r) => r.state)).not.toEqual(["completed"]);
  });
  it("the default type is accepted only as the built-in general-purpose agent; any other meta stays unconfirmed", () => {
    for (const [patch, want] of [[{}, "completed"], [{ agentType: "explore" }, "unknown"], [{ isBuiltIn: false }, "unknown"], [{ toolUseId: "toolu_other" }, "unknown"]] as const) {
      const f = fixture(T("2026-11-17T05:12:51.000Z")), c = f.children.get(AID)!;
      c.meta = { ...(c.meta as object), ...patch };
      expect(projectSubagents(f).map((r) => r.state), JSON.stringify(patch)).toEqual([want]);
    }
  });
  it("a queued notification counts only with its own binding: this session and cwd, the parent stream, its task-id, and its call's tool-use-id when it names one", () => {
    const final = (mutate: (r: any) => void) => {
      const f = fixture(T("2026-11-17T05:12:51.000Z"));
      f.parent = f.parent.filter((r: any) => r.type !== "queue-operation");   // the attachment's own binding, alone
      mutate(f.parent.filter((r: any) => r.type === "attachment").at(-1));
      return projectSubagents(f).map((r) => r.state)[0];
    };
    expect(final(() => {})).toBe("completed");
    expect(final((r) => { r.sessionId = "other"; })).not.toBe("completed");
    expect(final((r) => { r.cwd = "/elsewhere"; })).not.toBe("completed");
    expect(final((r) => { r.isSidechain = true; })).not.toBe("completed");
    expect(final((r) => { r.attachment.commandMode = "prompt"; })).not.toBe("completed");
    expect(final((r) => { r.attachment.origin = { kind: "human" }; })).not.toBe("completed");
    expect(final((r) => { r.attachment.prompt = r.attachment.prompt.replace(`<task-id>${AID}</task-id>`, "<task-id>a000000000000000</task-id>"); })).not.toBe("completed");
    expect(final((r) => { r.attachment.prompt = r.attachment.prompt.replace("<task-id>", "<tool-use-id>toolu_other</tool-use-id>\n<task-id>"); })).not.toBe("completed");
  });
});

describe("M-3270: the service reads a child transcript past 512 KB (its recent window, as the parent's)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it("a 2.1.326 child that grew past 512 KB still reports its state", async () => {
    const root = mkdtempSync(join(tmpdir(), "m3270-")); dirs.push(root);
    const parentPath = join(root, `${SID}.jsonl`), childDir = join(root, SID, "subagents");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(parentPath, readFileSync(new URL("claude-parent.jsonl", DIR)));
    // The recorded child, with its attachment rows grown back to a real child's size (their payloads are omitted in the
    // fixture): over 512 KB, as 53 of 57 children of the recording session were.
    const records = lines(`claude-agent-${AID}.jsonl`);
    const filler = "x".repeat(40_000);
    const grown = records.map((r: any) => r.type === "attachment" ? { ...r, attachment: { ...r.attachment, payload: filler } } : r);
    const text = grown.map((r: any) => JSON.stringify(r)).join("\n") + "\n";
    expect(text.length).toBeGreaterThan(512 * 1024);
    writeFileSync(join(childDir, `agent-${AID}.jsonl`), text);
    writeFileSync(join(childDir, `agent-${AID}.meta.json`), readFileSync(new URL(`claude-agent-${AID}.meta.json`, DIR)));
    const service = new SubagentService(() => ({ backend: "claude-code", sessionId: SID, cwd: CWD, path: parentPath, root, owner: "o" }),
      undefined, () => T("2026-11-17T05:12:51.000Z"));
    const answer = await service.read("fixture");
    expect([answer.status, answer.runs.map((r) => r.state)]).toEqual(["ok", ["completed"]]);
  });
});
