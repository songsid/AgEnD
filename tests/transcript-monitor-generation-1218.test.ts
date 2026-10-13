/**
 * #1786 review (Fable P3): a whole-line read is awaited; a reset of the monitor while it runs (a new transcript, the
 * instance stopped) must drop what it read — nothing from the old file is emitted after the reset. The read is held
 * open here (transcript-jsonl's resolveLongLines, which does it, mocked to wait) so the reset lands inside it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";

const gate = vi.hoisted(() => ({ release: null as null | (() => void), entered: null as null | (() => void) }));
vi.mock("../src/transcript-jsonl.js", async (original) => {
  const real = await original<typeof import("../src/transcript-jsonl.js")>();
  return {
    ...real,
    // The monitor awaits this (the whole-line read inside it); held open so a reset lands while it runs.
    resolveLongLines: async (...a: Parameters<typeof real.resolveLongLines>) => {
      gate.entered?.();
      await new Promise<void>((r) => { gate.release = r; });
      return real.resolveLongLines(...a);
    },
  };
});
const { TranscriptMonitor } = await import("../src/transcript-monitor.js");

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1218-gen-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const logger = pino({ level: "silent" }) as unknown as Logger;

describe("the claude monitor: a reset during a whole-line read emits nothing from the old file", () => {
  it("reset while the long reply is being read: no assistant_text afterwards", async () => {
    const f = join(temp(), "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old " + "w".repeat(300 * 1024) }] } }) + "\n");
    const m = new TranscriptMonitor(temp(), logger);
    m.setTranscriptPath(f);
    const texts: string[] = [];
    m.on("assistant_text", (t: string) => texts.push(t.slice(0, 3)));
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const poll = m.pollIncrement();
    await entered;
    m.resetOffset();
    gate.release!();
    await poll;
    expect(texts).toEqual([]);
  });

  it("control: without a reset the same reply is emitted", async () => {
    const f = join(temp(), "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "new " + "w".repeat(300 * 1024) }] } }) + "\n");
    const m = new TranscriptMonitor(temp(), logger);
    m.setTranscriptPath(f);
    const texts: string[] = [];
    m.on("assistant_text", (t: string) => texts.push(t.slice(0, 3)));
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const poll = m.pollIncrement();
    await entered;
    gate.release!();
    await poll;
    expect(texts).toEqual(["new"]);
  });
});
