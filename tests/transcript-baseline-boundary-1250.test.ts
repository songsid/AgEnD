/**
 * #1250: every baseline / checkpoint offset is the last line boundary at or before the file's size, not the size.
 * #1221 made the incremental reads stop at the last complete line; the offsets they start from went straight to
 * `stat.size`, so a record the CLI was half-way through writing at that moment was cut: the next read began with
 * its tail, skipped it as malformed, and the record was lost.
 *
 * One test per site. Each file holds one complete history record and one half-written record when the offset is
 * taken; the record is then completed. It must be read exactly once, and the history never.
 * Private temp files only: no daemon, CLI, tmux or real store.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CodexRolloutSource, KiroSessionSource, type TranscriptEvents } from "../src/transcript-sources.js";
import { lastLineBoundary, readNewLines } from "../src/transcript-jsonl.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import { createLogger } from "../src/logger.js";

let root: string;
const closers: Array<() => void> = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-1250-")); resetSharedRolloutIndexesForTests(0); });
afterEach(() => { closers.splice(0).forEach(close => close()); resetSharedRolloutIndexesForTests(); rmSync(root, { recursive: true, force: true }); });

const names = (events: TranscriptEvents) => events.toolUses.map(use => use.name);
/** A record split where the CLI's write stopped: the first part is on disk, the rest comes later. */
const split = (record: string) => [record.slice(0, 25), `${record.slice(25)}\n`] as const;

describe("lastLineBoundary", () => {
  it("just after the last LF at or before the size; 0 when there is none; scans across chunks", async () => {
    const path = join(root, "f.jsonl");
    writeFileSync(path, "aa\nbbbb\ncc");
    expect(await lastLineBoundary(path)).toBe(8);
    expect(await lastLineBoundary(path, 7)).toBe(3);
    expect(await lastLineBoundary(path, 8)).toBe(8);
    expect(await lastLineBoundary(path, 2)).toBe(0);
    writeFileSync(path, "x\n" + "y".repeat(200_000));          // the LF is three 64 KiB chunks back
    expect(await lastLineBoundary(path)).toBe(2);
    writeFileSync(path, "no newline at all");
    expect(await lastLineBoundary(path)).toBe(0);
    writeFileSync(path, "中文\n記錄");                           // bytes, not characters
    expect(await lastLineBoundary(path)).toBe(Buffer.byteLength("中文\n"));
  });
});

describe("Claude (TranscriptMonitor)", () => {
  const tool = (name: string) => JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] } });
  function monitorOn(path: string) {
    const monitor = new TranscriptMonitor(root, createLogger("silent"));
    (monitor as unknown as { resolveTranscriptPath(): Promise<string> }).resolveTranscriptPath = async () => path;
    closers.push(() => monitor.stop());
    const poll = async () => {
      const seen: string[] = [];
      const on = (name: string) => seen.push(name);
      monitor.on("tool_use", on);
      try { await monitor.pollIncrement(); } finally { monitor.off("tool_use", on); }
      return seen;
    };
    return { monitor, poll };
  }

  it("first attach (transcript-monitor.ts:135): the record being written is read once complete", async () => {
    const path = join(root, "claude.jsonl");
    const [head, rest] = split(tool("InProgress"));
    writeFileSync(path, `${tool("History")}\n${head}`);
    const { poll } = monitorOn(path);
    expect(await poll()).toEqual([]);                          // the attach poll baselines, reads nothing
    appendFileSync(path, rest);
    expect(await poll()).toEqual(["InProgress"]);
    expect(await poll()).toEqual([]);
  });

  it("reconciliation checkpoint (transcript-monitor.ts:84): the offset is the record boundary", async () => {
    const path = join(root, "claude.jsonl");
    const [head, rest] = split(tool("InProgress"));
    writeFileSync(path, `${tool("History")}\n${head}`);
    const { monitor } = monitorOn(path);
    const checkpoint = await monitor.reconciliationCheckpoint();
    expect(checkpoint?.offset).toBe(Buffer.byteLength(`${tool("History")}\n`));
    appendFileSync(path, rest);
    const { lines } = await readNewLines(path, checkpoint!.offset);
    expect(lines.map(line => JSON.parse(line).message.content[0].name)).toEqual(["InProgress"]);
  });
});

describe("Codex (CodexRolloutSource)", () => {
  const tool = (name: string) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: "{}" } });
  function rollout() {
    const sessions = join(root, "codex-sessions");
    const day = join(sessions, "2026", "10", "07");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-owned.jsonl");
    return { sessions, path, meta: JSON.stringify({ type: "session_meta", payload: { cwd: root } }) + "\n" };
  }

  it("checkpoint (transcript-sources.ts:115-116): offset and read position are the record boundary", async () => {
    const { sessions, path, meta } = rollout();
    writeFileSync(path, meta);
    const source = new CodexRolloutSource(root, sessions);
    const [head, rest] = split(tool("InProgress"));
    appendFileSync(path, `${tool("History")}\n${head}`);
    const checkpoint = await source.checkpoint();
    expect(checkpoint?.offset).toBe(Buffer.byteLength(`${meta}${tool("History")}\n`));
    appendFileSync(path, rest);
    expect(names(await source.poll())).toEqual(["InProgress"]);
    expect(names(await source.poll())).toEqual([]);
  });

  it("the rollout that existed when the source was created (transcript-sources.ts:123): its mid-write record is kept", async () => {
    const { sessions, path, meta } = rollout();
    const [head, rest] = split(tool("InProgress"));
    writeFileSync(path, `${meta}${tool("History")}\n${head}`);
    const source = new CodexRolloutSource(root, sessions);       // snapshots the size here
    appendFileSync(path, rest);
    expect(names(await source.poll())).toEqual(["InProgress"]);
    expect(names(await source.poll())).toEqual([]);
  });
});

describe("Kiro (KiroSessionSource)", () => {
  const tool = (name: string) => JSON.stringify({ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { name, input: {} } }] } });

  it("attaching to an older session (transcript-sources.ts:575): the record being written is read once complete", async () => {
    const sessions = join(root, "kiro-sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "owned.jsonl");
    writeFileSync(join(sessions, "owned.json"), JSON.stringify({ cwd: root, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z" }));
    const [head, rest] = split(tool("InProgress"));
    writeFileSync(path, `${tool("History")}\n${head}`);
    // Created now, after the session: an older session is attached at its end, not read from the start.
    const source = new KiroSessionSource(root, sessions, Date.now(), join(root, "missing.sqlite3"));
    closers.push(() => source.close());
    expect(names(await source.poll())).toEqual([]);            // the attach poll baselines, reads nothing
    appendFileSync(path, rest);
    expect(names(await source.poll())).toEqual(["InProgress"]);
    expect(names(await source.poll())).toEqual([]);
  });
});
