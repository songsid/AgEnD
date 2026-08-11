import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { createLogger } from "../src/logger.js";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

describe("TranscriptMonitor", () => {
  let tmpDir: string;
  let monitor: TranscriptMonitor;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-tm-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    monitor = new TranscriptMonitor(tmpDir, createLogger("silent"));
  });

  afterEach(() => {
    monitor.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits tool_use events from JSONL", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/foo" } }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const events: [string, unknown][] = [];
    monitor.on("tool_use", (name, input) => events.push([name, input]));

    await monitor.pollIncrement();
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("Read");
  });

  it("reads only incremental content on second poll", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry1 = { message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry1) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const events: string[] = [];
    monitor.on("tool_use", (name) => events.push(name));

    await monitor.pollIncrement(); // reads entry1
    expect(events).toHaveLength(1);

    const entry2 = { message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] } };
    appendFileSync(jsonlPath, JSON.stringify(entry2) + "\n");

    await monitor.pollIncrement(); // should only read entry2
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("Edit");
  });

  it("emits assistant_text for text blocks", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    await monitor.pollIncrement();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Hello world");
  });

  it("does not re-emit on poll with no new content", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "once" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    await monitor.pollIncrement();
    await monitor.pollIncrement(); // no new data
    expect(texts).toHaveLength(1);
  });

  it("skips concurrent pollIncrement calls (reentry guard)", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "once" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    // Fire two polls simultaneously; second should bail before reading
    // any bytes, so the entry is emitted exactly once.
    await Promise.all([monitor.pollIncrement(), monitor.pollIncrement()]);
    expect(texts).toHaveLength(1);
  });
});

describe("TranscriptMonitor — active-transcript replacement (#528 trap 1)", () => {
  let tmpDir: string;
  let monitor: TranscriptMonitor;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-tm-trap1-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    monitor?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStatusline(transcriptPath: string): void {
    writeFileSync(join(tmpDir, "statusline.json"), JSON.stringify({ transcript_path: transcriptPath }));
  }
  const toolUseLine = (name: string) =>
    JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] } }) + "\n";

  it("follows statusline to a NEW transcript instead of staying pinned to the persisted one", async () => {
    // The bug: a persisted offset file points at the previous session's JSONL.
    // claude-code resumes into a NEW file after a restart; a monitor that
    // early-returns on "I already have a path" watches a dead file forever —
    // zero events, zero errors.
    const oldPath = join(tmpDir, "old-session.jsonl");
    const newPath = join(tmpDir, "new-session.jsonl");
    writeFileSync(oldPath, toolUseLine("OldWork"));
    writeFileSync(newPath, toolUseLine("ResumedWork"));
    // Persisted state from the previous daemon run: pinned to oldPath at its EOF.
    writeFileSync(join(tmpDir, "transcript-offset"), JSON.stringify({ offset: statSync(oldPath).size, path: oldPath }));
    writeStatusline(newPath);

    monitor = new TranscriptMonitor(tmpDir, createLogger("silent"));
    const events: string[] = [];
    monitor.on("tool_use", (name) => events.push(name));
    await monitor.pollIncrement();

    // The replaced transcript is read from byte 0 so work resumed during our
    // startup is observable.
    expect(events).toContain("ResumedWork");
    expect(events).not.toContain("OldWork");
  });

  it("still baselines a first-ever attach to EOF (history does not replay)", async () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(path, toolUseLine("History"));
    writeStatusline(path);

    monitor = new TranscriptMonitor(tmpDir, createLogger("silent"));
    const events: string[] = [];
    monitor.on("tool_use", (name) => events.push(name));
    await monitor.pollIncrement(); // baselines to EOF
    expect(events).toHaveLength(0);

    appendFileSync(path, toolUseLine("Live"));
    await monitor.pollIncrement();
    expect(events).toEqual(["Live"]);
  });

  it("delegates to a TranscriptSource when one is supplied", async () => {
    const fake = {
      polled: 0,
      async poll() {
        this.polled++;
        return { toolUses: [{ name: "src_tool", input: { a: 1 } }], toolResults: [], assistantTexts: ["hi"] };
      },
      reset() { /* noop */ },
    };
    monitor = new TranscriptMonitor(tmpDir, createLogger("silent"), fake);
    const uses: string[] = [];
    const texts: string[] = [];
    monitor.on("tool_use", (name) => uses.push(name));
    monitor.on("assistant_text", (t) => texts.push(t));
    await monitor.pollIncrement();
    expect(uses).toEqual(["src_tool"]);
    expect(texts).toEqual(["hi"]);
    expect(fake.polled).toBe(1);
  });
});
