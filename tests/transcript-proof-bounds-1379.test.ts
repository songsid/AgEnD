/**
 * #1380 review: the submission proof's transcript look runs every 250 ms inside the pane lock, so it must be bounded —
 * in bytes (incremental from where it stopped, ≤256 KiB per look, never the whole delta again), in time (a look that
 * does not settle within its budget is abandoned and its late result dropped) — and fenced to the write it serves (a
 * look that lands after a stop, a pause or a respawn neither proves the old write nor retires the new spawn's guard).
 *
 * Nothing here starts a CLI, a fleet or a tmux server; transcripts are scratch files, the fs layer is wrapped to hold
 * a read or count the bytes read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hold the next `open`, count every byte `read`, and record when a held call is entered. */
const fsHold = vi.hoisted(() => ({ open: null as null | Promise<void>, entered: 0, opens: 0, bytesRead: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      fsHold.opens++;
      const wait = fsHold.open;
      if (wait) { fsHold.open = null; fsHold.entered++; await wait; }
      const fh = await real.open(...args);
      const read = fh.read.bind(fh);
      (fh as any).read = async (...a: any[]) => { const r = await (read as any)(...a); fsHold.bytesRead += r.bytesRead; return r; };
      return fh;
    }) as typeof real.open,
  };
});
const holdNextOpen = () => { let release!: () => void; fsHold.open = new Promise<void>(r => { release = r; }); return () => release(); };
const untilEntered = async () => {
  for (let i = 0; i < 2_500 && fsHold.entered === 0; i++) await new Promise(r => setTimeout(r, 2));
  expect(fsHold.entered).toBe(1);
};

import { TranscriptDeltaReader, TRANSCRIPT_PROOF_READ } from "../src/transcript-delta-reader.js";
import { Daemon } from "../src/daemon.js";

const FIX = join(__dirname, "fixtures");
const CAPTURED_ID = "7e57bbbb-0000-4000-8000-000000001400";
const ID = "5b0c1d2e-0000-4000-8000-000000001379";
const ownEntries = (id = ID) => readFileSync(join(FIX, "claude-2.1.293-idle-submit-flooded.transcript.jsonl"), "utf8").split(CAPTURED_ID).join(id) + "\n";
const filler = (bytes: number) => {
  const line = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(400) }] } })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
};
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1379-")); roots.push(d); return d; };
afterEach(() => {
  fsHold.open = null; fsHold.entered = 0; fsHold.opens = 0; fsHold.bytesRead = 0;
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const readerOn = (content: string, before = "") => {
  const path = join(scratch(), "session.jsonl");
  writeFileSync(path, before + content);
  return { path, reader: new TranscriptDeltaReader(path, Buffer.byteLength(before), "claude-code", ID) };
};

describe("the reader: this delivery's exact marker, read forward in bounded looks", () => {
  it("finds the delivery's own user entry; another delivery's, or one before the checkpoint, is no match", async () => {
    expect(await readerOn(ownEntries()).reader.look()).toBe("user");
    expect(await readerOn(ownEntries("5b0c1d2e-0000-4000-8000-0000000000ff")).reader.look()).toBe("no-match");
    expect(await readerOn("{\"type\":\"system\"}\n", ownEntries()).reader.look()).toBe("no-match");
  });

  it("a large delta is read once, ≤256 KiB per look, from where the last look stopped — never all again", async () => {
    const backlog = filler(3 * 1024 * 1024);
    const { reader } = readerOn(backlog + ownEntries());
    const total = Buffer.byteLength(backlog + ownEntries());
    let found = "no-match"; let looks = 0; let last = reader.readPosition;
    while (found === "no-match" && looks < 100) {
      found = await reader.look(); looks++;
      expect(reader.readPosition - last).toBeLessThanOrEqual(TRANSCRIPT_PROOF_READ.chunkBytes);
      last = reader.readPosition;
    }
    expect(found).toBe("user");
    expect(looks).toBeGreaterThanOrEqual(Math.ceil(total / TRANSCRIPT_PROOF_READ.chunkBytes) - 1);
    expect(fsHold.bytesRead).toBeLessThanOrEqual(total);   // each byte read once, not once per look
  });

  it("a delta that grows between looks: only the new bytes are read", async () => {
    const { path, reader } = readerOn(filler(100_000));
    expect(await reader.look()).toBe("no-match");
    const afterFirst = fsHold.bytesRead;
    appendFileSync(path, filler(50_000));
    expect(await reader.look()).toBe("no-match");
    expect(fsHold.bytesRead - afterFirst).toBeLessThanOrEqual(Buffer.byteLength(filler(50_000)));
    appendFileSync(path, ownEntries());
    expect(await reader.look()).toBe("user");
  });

  it("a line over the cap is skipped before it is decoded — even this delivery's own entry", async () => {
    const own = ownEntries().split("\n").find(l => l.includes('"type":"user"'))!;
    const entry = JSON.parse(own);
    entry.message.content += "p".repeat(TRANSCRIPT_PROOF_READ.maxLineBytes);
    const { reader } = readerOn(`${JSON.stringify(entry)}\n`);
    let found = "no-match";
    for (let i = 0; i < 5 && found === "no-match"; i++) found = await reader.look();
    expect(found).toBe("no-match");
  });

  it("a read that never settles: the look returns within its budget, the next one does not start a second read", async () => {
    const { reader } = readerOn(ownEntries());
    holdNextOpen();   // never released in this test
    const started = Date.now();
    expect(await reader.look()).toBe("pending");
    expect(Date.now() - started).toBeLessThan(TRANSCRIPT_PROOF_READ.lookBudgetMs + 500);
    expect(await reader.look()).toBe("pending");
    expect(fsHold.opens).toBe(1);
    expect(reader.readPosition).toBe(0);
  });

  it("an abandoned read that lands late is dropped whole: nothing applied; the next look reads it again", async () => {
    const { reader } = readerOn(ownEntries());
    const release = holdNextOpen();
    expect(await reader.look()).toBe("pending");
    release();
    // Let the abandoned read finish on its own.
    for (let i = 0; i < 2_500 && (reader as any).inFlight; i++) await new Promise(r => setTimeout(r, 2));
    expect((reader as any).inFlight).toBe(false);
    expect(reader.readPosition).toBe(0);            // its bytes were not applied…
    expect(await reader.look()).toBe("user");        // …so this look reads them, in time, and finds the marker
    expect(reader.readPosition).toBe(Buffer.byteLength(ownEntries()));
  });
});

describe("the daemon's proof is fenced to its write (a held look, then stop / pause / respawn)", () => {
  const PAINTING = readFileSync(join(FIX, "claude-2.1.293-idle-submit-painting.pane.txt"), "utf8");
  const IDLE = readFileSync(join(FIX, "claude-2.1.293-idle-empty.pane.txt"), "utf8");

  async function daemonWithHeldLook(fence: (daemon: any) => void) {
    const dir = scratch();
    const path = join(dir, "session.jsonl");
    writeFileSync(path, "");
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
    const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
    const backend = Object.assign(Object.create(ClaudeCodeBackend.prototype), { instanceDir: dir });
    const daemon: any = new Daemon("worker", {
      working_directory: dir, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, join(dir, "worker"), false, backend, undefined as any, logger);
    mkdirSync(join(dir, "worker"), { recursive: true });
    daemon.tmux = { capturePane: vi.fn(async () => PAINTING) };
    const signature = daemon.submissionSignature("hello", "xmsg-fence");
    const onProof = vi.fn();
    signature.transcript = daemon.transcriptProofFor({ backend: "claude-code", path, offset: 0 }, ID, daemon.spawnGeneration, undefined, onProof);
    const baseline = daemon.paneEvidence(IDLE, signature);
    // Claude has written this delivery's entry; the look that would read it is held.
    appendFileSync(path, ownEntries());
    const release = holdNextOpen();
    const verdict = daemon.confirmSubmitted(signature, baseline);
    await untilEntered();
    fence(daemon);
    // The replacement spawn installs its own input guard.
    daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
    release();
    return { verdict: await verdict, daemon, onProof, signature };
  }

  for (const [name, fence] of [
    ["stop", (d: any) => d.fenceDeliveryWritesForStop()],
    ["pause (a new launch)", (d: any) => { d.launchFenceEpoch++; }],
    ["respawn", (d: any) => { d.spawnGeneration++; }],
  ] as const) {
    it(`${name}: the held look's marker is not used — the pane verdict stands, the new guard is kept, nothing is recorded`, async () => {
      const r = await daemonWithHeldLook(fence);
      expect(r.verdict).toBe("stranded");
      expect(r.daemon.inputTransientGuardGeneration).toBe(r.daemon.spawnGeneration);
      expect(r.onProof).not.toHaveBeenCalled();
      expect(r.signature.transcript.provenBy).toBeUndefined();
    });
  }

  it("a look that never settles: the proof returns the pane's verdict within the look budget (the lock is not held)", async () => {
    const started = Date.now();
    const dir = scratch();
    const path = join(dir, "session.jsonl");
    writeFileSync(path, ownEntries());
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
    const daemon: any = new Daemon("worker", {
      working_directory: dir, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, join(dir, "worker"), false, { binaryName: "claude", getReadyPattern: () => /❯/, readInputRow: () => ({ text: "[Pasted text #1 +30 lines]", collapsedPastes: 1 }) } as any, undefined as any, logger);
    daemon.tmux = { capturePane: vi.fn(async () => PAINTING) };
    const signature = daemon.submissionSignature("hello", "xmsg-fence");
    signature.transcript = daemon.transcriptProofFor({ backend: "claude-code", path, offset: 0 }, ID, daemon.spawnGeneration, undefined, () => {});
    holdNextOpen();   // never released
    const verdict = await daemon.confirmSubmitted(signature, { queued: 0, payload: 0, strandedInput: false, collapsedPastes: 0, inputReadable: true });
    expect(verdict).toBe("stranded");
    expect(Date.now() - started).toBeLessThan(TRANSCRIPT_PROOF_READ.lookBudgetMs + 1_000);
  });

  it("the control: no fence, the same held look lands → submitted, recorded", async () => {
    const r = await daemonWithHeldLook(() => {});
    expect(r.verdict).toBe("submitted");
    expect(r.onProof).toHaveBeenCalledWith("user");
  });
});
