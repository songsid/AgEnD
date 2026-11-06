import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { FollowLog, resolveFollowSteps } from "../src/workspace-follow.js";
import { workspaceRoot } from "../src/agent-workspace.js";
import { TranscriptTurnLedger } from "../src/transcript-turns.js";
import { CodexRolloutSource, type TranscriptSource } from "../src/transcript-sources.js";
import { RolloutIndex } from "../src/rollout-index.js";
import { claudeFollowRecords, type FollowObservation } from "../src/workspace-follow-records.js";

const roots: string[] = [];
const temp = () => { const r = mkdtempSync(join(tmpdir(), "agend-follow-stream-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
/** Construct only the monitor's owner; never construct/start a daemon, pane or fleet. */
function owner(source: TranscriptSource | null, binaryName = "codex") {
  const d: any = Object.create(Daemon.prototype);
  Object.assign(d, { instanceDir: temp(), logger: pino({ level: "silent" }), config: {}, backend: { binaryName }, followLog: new FollowLog(), transcriptTurns: new TranscriptTurnLedger() });
  d.transcriptMonitor = d.buildTranscriptMonitor(source);
  return d;
}
const event = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + "\n";
const call = (id: string, path: string) => event("response_item", { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `cat ${path}` }) });

describe("Follow's ordered observations through the production source, monitor and daemon wiring", () => {
  it.each(["claude", "codex"] as const)("replays the real %s CLI recording through the production monitor, with no pattern/content/outside leak", async backend => {
    const root = temp(), work = join(root, "work"), sessions = join(root, "sessions"), day = join(sessions, "2026", "11", "07");
    mkdirSync(join(work, "src"), { recursive: true }); mkdirSync(day, { recursive: true });
    writeFileSync(join(work, "src/a.ts"), "// NEEDLE fixture\nconst value = 2;\nconsole.log(value);\n// fourth line\n");
    writeFileSync(join(work, ".env"), "FOLLOW_PRIVATE_CANARY_3160"); writeFileSync(join(root, "outside.txt"), "FOLLOW_OUTSIDE_CANARY_3160");
    const name = backend === "claude" ? "claude-2.1.319.jsonl" : "codex-0.164.0.jsonl";
    const records = readFileSync(join(import.meta.dirname, "fixtures/workspace-follow-3160", name), "utf8").replaceAll("__WORK__", work).replaceAll("__BASE__", root);
    const file = join(day, "rollout-recorded.jsonl"); writeFileSync(file, "");
    let source: TranscriptSource | null = null;
    if (backend === "codex") { source = new CodexRolloutSource(work, sessions, Date.now(), new RolloutIndex(sessions, { ttlMs: 0 })); source.reset(); }
    const d = owner(source, backend === "claude" ? "claude" : "codex");
    if (backend === "claude") { d.transcriptMonitor.resolveTranscriptPath = async () => file; await d.transcriptMonitor.pollIncrement(); }
    appendFileSync(file, records); await d.transcriptMonitor.pollIncrement();
    const snapshot = d.workspaceFollow();
    expect(snapshot.steps.length).toBe(5);
    expect(snapshot.steps.every((s: any) => s.phase === "done")).toBe(true);
    const safe = await resolveFollowSteps(await workspaceRoot(work, join(root, "state")), snapshot.steps);
    expect(safe.map(s => s.kind)).toEqual(["read", "search", "edit", "read"]);
    expect(safe[3]!.paths).toEqual([{ path: ".env", hidden: true, dir: false }]);
    expect(safe[0]!.range).toEqual({ from: 2, to: 4 });
    expect(safe[1]!.exact).toBe(false);
    if (backend === "claude") expect(safe[2]!.editLines).toEqual([2]);
    expect(JSON.stringify(safe)).not.toMatch(/NEEDLE|FOLLOW_PRIVATE_CANARY|FOLLOW_OUTSIDE_CANARY|old_string|new_string|outside\.txt/);
    expect(JSON.stringify(safe)).not.toContain(root);
    d.transcriptMonitor.stop();
  });
  it("retains the first tool in a poll and assigns multiple turns in one poll in their actual order", async () => {
    const root = temp(), sessions = join(root, "sessions"), day = join(sessions, "2026", "11", "07"), work = join(root, "work");
    mkdirSync(day, { recursive: true }); mkdirSync(work);
    const file = join(day, "rollout-follow.jsonl");
    writeFileSync(file, event("session_meta", { id: "follow-session", cwd: work }));
    const source = new CodexRolloutSource(work, sessions, Date.now(), new RolloutIndex(sessions, { ttlMs: 0 }));
    source.reset();
    const d = owner(source);
    appendFileSync(file, event("event_msg", { type: "task_started", turn_id: "turn-1" }) + call("call-1", "first.ts"));
    await d.transcriptMonitor.pollIncrement();
    expect(d.workspaceFollow().steps.map((s: any) => s.paths)).toEqual([["first.ts"]]);
    appendFileSync(file, call("call-old", "old-turn.ts") + event("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" })
      + event("event_msg", { type: "task_started", turn_id: "turn-2" }) + call("call-2", "second.ts"));
    await d.transcriptMonitor.pollIncrement();
    expect(d.workspaceFollow().steps.map((s: any) => s.paths)).toEqual([["second.ts"]]);
    appendFileSync(file, event("response_item", { type: "function_call_output", call_id: "call-2", output: "fixture" }));
    await d.transcriptMonitor.pollIncrement();
    expect(d.workspaceFollow().steps).toMatchObject([{ id: "call-2", phase: "done" }]);
    d.transcriptMonitor.stop();
  });

  it("rotates the scope on monitor replacement/stop and ignores an old monitor's late observations", () => {
    const d = owner(null), old = d.transcriptMonitor;
    const use: FollowObservation = { type: "call", id: "same-id", step: { kind: "read", tool: "Read", paths: ["old.ts"], exact: true } };
    old.emit("workspace_follow", use);
    const previous = d.workspaceFollow();
    d.transcriptMonitor = d.buildTranscriptMonitor(null);
    expect(d.workspaceFollow().scope).not.toBe(previous.scope);
    old.emit("workspace_follow", use);
    expect(d.workspaceFollow().steps).toEqual([]);
    d.transcriptMonitor.emit("workspace_follow", { ...use, step: { ...use.step, paths: ["new.ts"] } });
    const current = d.workspaceFollow();
    expect(d.workspaceFollow(previous.last + 1000, current.turn, previous.scope).steps.map((s: any) => s.paths)).toEqual([["new.ts"]]);
    d.transcriptMonitor.stop();
    expect(d.workspaceFollow().steps).toEqual([]);
    expect(d.workspaceFollow().scope).not.toBe(current.scope);
  });

  it("does not collect unsupported backends even if their tool name happens to match", () => {
    const d = owner(null, "grok");
    d.transcriptMonitor.emit("workspace_follow", { type: "call", id: "x", step: { kind: "read", tool: "Read", paths: ["a"], exact: true } });
    expect(d.workspaceFollow().steps).toEqual([]);
  });

  it("drops copied Claude history on transcript replacement while retaining new work", async () => {
    const d = owner(null, "claude"), root = temp(), a = join(root, "a.jsonl"), b = join(root, "b.jsonl");
    writeFileSync(a, "");
    let path = a;
    d.transcriptMonitor.resolveTranscriptPath = async () => path;
    await d.transcriptMonitor.pollIncrement();
    const now = Date.now() + 100;
    const use = (id: string, file: string, at: number) => JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] } }) + "\n";
    const history = use("old-call", "old.ts", now);
    appendFileSync(a, history);
    await d.transcriptMonitor.pollIncrement();
    expect(d.workspaceFollow().steps[0].paths).toEqual(["old.ts"]);
    const scope = d.workspaceFollow().scope;
    const unstamped = JSON.parse(use("unstamped-copy", "unproven-old.ts", now)); delete unstamped.timestamp;
    writeFileSync(b, history + JSON.stringify(unstamped) + "\n" + use("new-call", "new.ts", now + 100)); path = b;
    await d.transcriptMonitor.pollIncrement();
    expect(d.workspaceFollow().scope).not.toBe(scope);
    expect(d.workspaceFollow().steps.map((s: any) => s.paths)).toEqual([["new.ts"]]);
    d.transcriptMonitor.stop();
  });

  it("correlates completions without retaining result contents or patterns", () => {
    const log = new FollowLog();
    const use = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "SECRET_LITERAL", path: "src" } }] } };
    for (const o of claudeFollowRecords(use)) log.observe(o);
    for (const o of claudeFollowRecords({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "grep-1", content: "SECRET_CONTENT" }] }, toolUseResult: { filenames: ["src/a.ts"] } })) log.observe(o);
    expect(log.snapshot().steps).toMatchObject([{ id: "grep-1", phase: "done", paths: ["src/a.ts"] }]);
    expect(JSON.stringify(log.snapshot())).not.toMatch(/SECRET_LITERAL|SECRET_CONTENT/);
  });
  it("an explicit shell cwd takes precedence over the transcript's cwd", () => {
    const records = claudeFollowRecords({ type: "assistant", cwd: "/agent", message: { role: "assistant", content: [{ type: "tool_use", id: "cwd-test", name: "Bash", input: { command: "cat a.ts", workdir: "/other" } }] } });
    expect(records).toMatchObject([{ type: "call", step: { cwd: "/other" } }]);
  });
});
