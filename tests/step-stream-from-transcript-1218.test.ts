/**
 * #1218 spike, end to end below the fleet: a real TranscriptMonitor reading a Claude Code JSONL file feeds a
 * StepBatcher exactly as the daemon wires it. No tmux, no pane, no process of any kind is involved — child_process is
 * mocked so that any spawn, exec or execFile would be counted (the red line: observing steps must not add captures).
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const count = (name: string) => (...args: unknown[]) => { spawned.calls.push(`${name} ${String(args[0])}`); throw new Error(`${name} must not be called`); };
  return { ...real, exec: count("exec"), execFile: count("execFile"), execSync: count("execSync"), execFileSync: count("execFileSync"), spawn: count("spawn"), spawnSync: count("spawnSync") };
});

import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { StepBatcher, type Step } from "../src/step-stream.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o) + "\n";
const assistant = (...content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content } });
const user = (...content: unknown[]) => line({ type: "user", message: { role: "user", content } });

describe("Claude Code transcript → steps", () => {
  it("each tool call, its result and what the agent said, in order — with no process spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1218-tr-")); dirs.push(dir);
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, assistant({ type: "text", text: "history before attach — not replayed" }));
    writeFileSync(join(dir, "statusline.json"), JSON.stringify({ transcript_path: transcript }));
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
    const monitor = new TranscriptMonitor(dir, logger);

    vi.useFakeTimers();
    const sent: Step[][] = [];
    const steps = new StepBatcher(s => sent.push(s), { intervalMs: 1000 });
    // The daemon's wiring (daemon.ts transcript handlers), with a stand-in for its summarizeTool label.
    monitor.on("tool_use", (name: string, input: { command?: string }) => steps.tool(name, input.command ? `$ ${input.command}` : name));
    monitor.on("tool_result", (name: string, output: unknown) => steps.result(name, output));
    monitor.on("assistant_text", (text: string) => steps.text(text));

    await monitor.pollIncrement();                       // first attach: baseline at the end, history is not replayed
    appendFileSync(transcript,
      assistant({ type: "thinking", thinking: "…" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test -- --token=sk-abcdefghijklmnopqrstu" } })
      + user({ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Tests 12 passed" }] })
      + user("a plain user message is not a step")
      + assistant({ type: "text", text: "All 12 pass." }));
    await monitor.pollIncrement();
    vi.advanceTimersByTime(1000);

    expect(sent.flat().map(s => [s.kind, s.name, s.text])).toEqual([
      ["tool", "Bash", "$ npm test -- --token=[REDACTED]"],
      ["result", "toolu_1", "Tests 12 passed"],
      ["text", undefined, "All 12 pass."],
    ]);
    expect(spawned.calls).toEqual([]);
  });

  it("KNOWN GAP (pinned, not fixed here): a line the CLI is still writing when a poll lands is lost", async () => {
    // TranscriptMonitor moves its offset to the end of the file even when the last line is incomplete; that line fails
    // to parse and is never read again. For a step stream that is a missing step. Fix before shipping: keep the offset
    // at the last newline. This test flips when that is done.
    const dir = mkdtempSync(join(tmpdir(), "agend-1218-tr-")); dirs.push(dir);
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, "");
    writeFileSync(join(dir, "statusline.json"), JSON.stringify({ transcript_path: transcript }));
    const monitor = new TranscriptMonitor(dir, { debug() {}, info() {}, warn() {}, error() {} } as never);
    const seen: string[] = [];
    monitor.on("tool_use", (name: string) => seen.push(name));
    await monitor.pollIncrement();
    const whole = assistant({ type: "tool_use", id: "t", name: "Bash", input: {} });
    appendFileSync(transcript, whole.slice(0, 20));
    await monitor.pollIncrement();
    appendFileSync(transcript, whole.slice(20));
    await monitor.pollIncrement();
    expect(seen).toEqual([]);
  });
});
