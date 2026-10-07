/**
 * #1250, #1283 review: the line-boundary baseline under read faults.
 *  - A short read (the OS returns fewer bytes than asked) is continued, never taken as "no LF in this chunk".
 *  - A read that makes no progress, or fails, gives no baseline: nothing is adopted or saved, the next poll
 *    retries, and the history is never replayed. Codex retries from the size it captured at creation.
 *
 * node:fs/promises `open` is wrapped so its handles can return at most `maxRead` bytes per read, or fail / make
 * no progress for the next N reads. Private temp files only: no daemon, CLI, tmux or real store.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ maxRead: Infinity, failReads: 0, zeroReads: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof real.open>) => {
    const fh = await real.open(...args);
    return new Proxy(fh, {
      get(target, key) {
        if (key === "read") {
          return async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (faults.failReads > 0) { faults.failReads--; throw Object.assign(new Error("EIO: injected"), { code: "EIO" }); }
            if (faults.zeroReads > 0) { faults.zeroReads--; return { bytesRead: 0, buffer }; }
            return target.read(buffer, offset, Math.min(length, faults.maxRead), position);
          };
        }
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CodexRolloutSource, KiroSessionSource, type TranscriptEvents } from "../src/transcript-sources.js";
import { lastLineBoundary } from "../src/transcript-jsonl.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import { createLogger } from "../src/logger.js";

let root: string;
const closers: Array<() => void> = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-1250-faults-")); resetSharedRolloutIndexesForTests(0); Object.assign(faults, { maxRead: Infinity, failReads: 0, zeroReads: 0 }); });
afterEach(() => { closers.splice(0).forEach(close => close()); resetSharedRolloutIndexesForTests(); rmSync(root, { recursive: true, force: true }); });

const names = (events: TranscriptEvents) => events.toolUses.map(use => use.name);
const split = (record: string) => [record.slice(0, 25), `${record.slice(25)}\n`] as const;
const claudeTool = (name: string) => JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] } });

describe("lastLineBoundary reads every byte before judging", () => {
  it("short reads (7 bytes at a time): a 93-byte LF-terminated record ends at 93, not 0", async () => {
    const path = join(root, "f.jsonl");
    const record = `${"x".repeat(92)}\n`;
    writeFileSync(path, record);
    faults.maxRead = 7;
    expect(await lastLineBoundary(path)).toBe(93);
    writeFileSync(path, `${record}${"y".repeat(40)}`);        // the LF sits where a single 7-byte read would not reach
    expect(await lastLineBoundary(path)).toBe(93);
  });

  it("a read that makes no progress throws rather than reporting no LF", async () => {
    const path = join(root, "f.jsonl");
    writeFileSync(path, "aa\nbb\n");
    faults.zeroReads = 1;
    await expect(lastLineBoundary(path)).rejects.toThrow(/no progress/);
  });
});

describe("Claude first attach (TranscriptMonitor)", () => {
  function monitorOn(path: string) {
    const monitor = new TranscriptMonitor(root, createLogger("silent"));
    (monitor as unknown as { resolveTranscriptPath(): Promise<string> }).resolveTranscriptPath = async () => path;
    closers.push(() => monitor.stop());
    return async () => {
      const seen: string[] = [];
      const on = (name: string) => seen.push(name);
      monitor.on("tool_use", on);
      try { await monitor.pollIncrement(); } finally { monitor.off("tool_use", on); }
      return seen;
    };
  }

  it("under short reads the history is still skipped (it used to be replayed as new)", async () => {
    const path = join(root, "claude.jsonl");
    writeFileSync(path, `${claudeTool("History")}\n`);
    faults.maxRead = 7;
    const poll = monitorOn(path);
    expect(await poll()).toEqual([]);                        // attach, under short reads
    faults.maxRead = Infinity;                               // (readNewLines is fine with short reads too, just slower)
    expect(await poll()).toEqual([]);                        // the history is not news
    appendFileSync(path, `${claudeTool("Next")}\n`);
    expect(await poll()).toEqual(["Next"]);
  });

  it("a failed boundary read attaches nothing; the next poll attaches, and nothing old is replayed", async () => {
    const path = join(root, "claude.jsonl");
    const [head, rest] = split(claudeTool("InProgress"));
    writeFileSync(path, `${claudeTool("History")}\n${head}`);
    const poll = monitorOn(path);
    faults.failReads = 1;
    expect(await poll()).toEqual([]);                        // boundary read failed: no baseline, nothing saved
    expect(await poll()).toEqual([]);                        // attached now, at the boundary
    appendFileSync(path, rest);
    expect(await poll()).toEqual(["InProgress"]);
  });
});

describe("Codex: the lazy anchor of the size captured at creation", () => {
  const tool = (name: string) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: "{}" } });

  it("a failed boundary read is retried from the same captured size, so the mid-write record is not lost (P2-2)", async () => {
    const sessions = join(root, "codex-sessions");
    const day = join(sessions, "2026", "10", "07");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-owned.jsonl");
    const [head, rest] = split(tool("InProgress"));
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { cwd: root } })}\n${tool("History")}\n${head}`);
    const source = new CodexRolloutSource(root, sessions);  // captures the size here, mid-record
    appendFileSync(path, rest);
    faults.failReads = 1;
    expect(names(await source.poll())).toEqual([]);          // anchor failed: nothing adopted
    expect(names(await source.poll())).toEqual(["InProgress"]);
    expect(names(await source.poll())).toEqual([]);
    appendFileSync(path, `${tool("Following")}\n`);
    expect(names(await source.poll())).toEqual(["Following"]);
  });
});

describe("Kiro: attaching to an older session", () => {
  const tool = (name: string) => JSON.stringify({ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { name, input: {} } }] } });

  it("a failed boundary read attaches nothing and never replays the session from 0", async () => {
    const sessions = join(root, "kiro-sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "owned.jsonl");
    writeFileSync(join(sessions, "owned.json"), JSON.stringify({ cwd: root, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z" }));
    writeFileSync(path, `${tool("History")}\n`);
    const source = new KiroSessionSource(root, sessions, Date.now(), join(root, "missing.sqlite3"));
    closers.push(() => source.close());
    faults.failReads = 1;
    expect(names(await source.poll())).toEqual([]);          // failed: not attached
    expect(names(await source.poll())).toEqual([]);          // attached at the boundary
    expect(names(await source.poll())).toEqual([]);          // History is not replayed
    appendFileSync(path, `${tool("Next")}\n`);
    expect(names(await source.poll())).toEqual(["Next"]);
  });
});
