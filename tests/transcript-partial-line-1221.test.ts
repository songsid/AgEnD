import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CodexRolloutSource, KiroSessionSource, type TranscriptEvents } from "../src/transcript-sources.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import { createLogger } from "../src/logger.js";

// Only private temp JSONL/metadata files: no daemon, CLI, tmux or real stores.
let root: string;
let close: (() => void) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-transcript-1221-"));
  resetSharedRolloutIndexesForTests(0);
});
afterEach(() => {
  close?.();
  close = undefined;
  resetSharedRolloutIndexesForTests();
  rmSync(root, { recursive: true, force: true });
});

function claudeTool(name: string, input: unknown = {}): string {
  return JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
}

function harness(backend: "claude" | "codex" | "kiro") {
  let path: string;
  let encode: (name: string, input?: unknown) => string;
  let poll: () => Promise<TranscriptEvents>;
  if (backend === "claude") {
    path = join(root, "claude.jsonl");
    writeFileSync(path, "");
    const monitor = new TranscriptMonitor(root, createLogger("silent"));
    monitor.setTranscriptPath(path);
    close = () => monitor.stop();
    encode = claudeTool;
    poll = async () => {
      const events: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };
      const use = (name: string, input: unknown) => events.toolUses.push({ name, input });
      monitor.on("tool_use", use);
      try { await monitor.pollIncrement(); } finally { monitor.off("tool_use", use); }
      return events;
    };
  } else if (backend === "codex") {
    const sessions = join(root, "codex-sessions");
    const source = new CodexRolloutSource(root, sessions);
    const day = join(sessions, "2026", "10", "06");
    mkdirSync(day, { recursive: true });
    path = join(day, "rollout-owned.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { cwd: root } }) + "\n");
    encode = (name, input = {}) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify(input) } });
    poll = () => source.poll();
  } else {
    const sessions = join(root, "kiro-sessions");
    const source = new KiroSessionSource(root, sessions, 1, join(root, "missing.sqlite3"));
    mkdirSync(sessions, { recursive: true });
    path = join(sessions, "owned.jsonl");
    writeFileSync(join(sessions, "owned.json"), JSON.stringify({ cwd: root, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z" }));
    writeFileSync(path, "");
    encode = (name, input = {}) => JSON.stringify({ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { name, input } }] } });
    poll = () => source.poll();
    close = () => source.close();
  }
  return { path, encode, poll };
}

describe.each(["claude", "codex", "kiro"] as const)("%s JSONL partial writes (#1221)", backend => {
  it("consumes the complete prefix only, then recovers a split record exactly once", async () => {
    const { path, encode, poll } = harness(backend);
    const partial = encode("Second", { file_path: "/private/fixture" });
    const split = Math.floor(partial.length / 2);
    appendFileSync(path, encode("First") + "\n" + partial.slice(0, split));
    expect((await poll()).toolUses).toEqual([{ name: "First", input: {} }]);
    expect((await poll()).toolUses).toEqual([]);
    appendFileSync(path, partial.slice(split) + "\n");
    expect((await poll()).toolUses).toEqual([{ name: "Second", input: { file_path: "/private/fixture" } }]);
    expect((await poll()).toolUses).toEqual([]);
    appendFileSync(path, encode("Third") + "\n");
    expect((await poll()).toolUses).toEqual([{ name: "Third", input: {} }]);
  });

  it("does not consume even valid JSON until its terminating newline arrives", async () => {
    const { path, encode, poll } = harness(backend);
    appendFileSync(path, encode("Waiting"));
    expect((await poll()).toolUses).toEqual([]);
    expect((await poll()).toolUses).toEqual([]);
    appendFileSync(path, "\n");
    expect((await poll()).toolUses).toEqual([{ name: "Waiting", input: {} }]);
    expect((await poll()).toolUses).toEqual([]);
  });

  it("emits all newline-terminated records immediately, including the last one", async () => {
    const { path, encode, poll } = harness(backend);
    appendFileSync(path, encode("One") + "\n" + encode("Two") + "\n");
    expect((await poll()).toolUses.map(use => use.name)).toEqual(["One", "Two"]);
    expect((await poll()).toolUses).toEqual([]);
  });

  it("keeps byte offsets across multibyte text and a write split inside a UTF-8 character", async () => {
    const { path, encode, poll } = harness(backend);
    const first = encode("中文🛠", { text: "完整" }) + "\n";
    const second = Buffer.from(encode("Later", { text: "中文🛠" }) + "\n");
    const split = second.indexOf(Buffer.from("中")) + 1;
    appendFileSync(path, Buffer.concat([Buffer.from(first), second.subarray(0, split)]));
    expect((await poll()).toolUses).toEqual([{ name: "中文🛠", input: { text: "完整" } }]);
    expect((await poll()).toolUses).toEqual([]);
    appendFileSync(path, second.subarray(split));
    expect((await poll()).toolUses).toEqual([{ name: "Later", input: { text: "中文🛠" } }]);
    expect((await poll()).toolUses).toEqual([]);
  });

  it("skips malformed complete lines and blanks without stranding the following record", async () => {
    const { path, encode, poll } = harness(backend);
    appendFileSync(path, "not-json\n \n" + encode("AfterMalformed") + "\r\n");
    expect((await poll()).toolUses).toEqual([{ name: "AfterMalformed", input: {} }]);
    expect((await poll()).toolUses).toEqual([]);
  });
});

describe("Claude persisted complete-line offset", () => {
  it("persists only the complete byte prefix and recovers the tail after monitor recreation", async () => {
    const path = join(root, "claude.jsonl");
    const first = claudeTool("Read", { file_path: "中文" }) + "\n";
    const tail = claudeTool("Edit");
    const split = 35;
    writeFileSync(path, first + tail.slice(0, split));
    const monitor = new TranscriptMonitor(root, createLogger("silent"));
    monitor.setTranscriptPath(path);
    const firstUses: string[] = [];
    monitor.on("tool_use", name => firstUses.push(name));
    await monitor.pollIncrement();
    expect(firstUses).toEqual(["Read"]);
    expect(JSON.parse(readFileSync(join(root, "transcript-offset"), "utf8"))).toEqual({ path, offset: Buffer.byteLength(first) });
    monitor.stop();

    const resumed = new TranscriptMonitor(root, createLogger("silent"));
    close = () => resumed.stop();
    const resumedUses: string[] = [];
    resumed.on("tool_use", name => resumedUses.push(name));
    appendFileSync(path, tail.slice(split) + "\n");
    await resumed.pollIncrement();
    await resumed.pollIncrement();
    expect(resumedUses).toEqual(["Edit"]);
  });

  it("delays split assistant_text and tool_result events until newline completion", async () => {
    const path = join(root, "claude.jsonl");
    const monitor = new TranscriptMonitor(root, createLogger("silent"));
    close = () => monitor.stop();
    monitor.setTranscriptPath(path);
    const texts: string[] = [];
    const results: unknown[][] = [];
    monitor.on("assistant_text", text => texts.push(text));
    monitor.on("tool_result", (...args) => results.push(args));
    const text = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "完成🛠" }] } });
    const result = JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } });
    writeFileSync(path, text);
    await monitor.pollIncrement();
    expect(texts).toEqual([]);
    appendFileSync(path, "\n" + result.slice(0, 25));
    await monitor.pollIncrement();
    expect(texts).toEqual(["完成🛠"]);
    expect(results).toEqual([]);
    appendFileSync(path, result.slice(25) + "\n");
    await monitor.pollIncrement();
    await monitor.pollIncrement();
    expect(texts).toEqual(["完成🛠"]);
    expect(results).toEqual([["tool-1", "ok"]]);
  });
});
