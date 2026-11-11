import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
// Advance the proof clock only after actual filesystem work has completed, never against shard-load timing.
const io = vi.hoisted(() => ({ pending: 0, waiters: [] as Array<() => void> }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const tracked =
    (fn: (...args: any[]) => Promise<any>) =>
    async (...args: any[]) => {
      io.pending++;
      try {
        return await fn(...args);
      } finally {
        if (--io.pending === 0)
          for (const resolve of io.waiters.splice(0)) resolve();
      }
    };
  return {
    ...real,
    realpath: tracked(real.realpath),
    lstat: tracked(real.lstat),
    stat: tracked(real.stat),
    open: tracked(async (...args: any[]) => {
      const fh = await (real.open as any)(...args);
      for (const name of ["read", "stat", "close"] as const)
        (fh as any)[name] = tracked((fh as any)[name].bind(fh));
      return fh;
    }),
  };
});
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { TranscriptDeltaReader } from "../src/transcript-delta-reader.js";
const roots: string[] = [];
const daemons: any[] = [];
const boxes: DeliveryOutbox[] = [];
const immediate = setImmediate;
afterEach(async () => {
  for (const d of daemons.splice(0)) d.fenceDeliveryWritesForStop?.();
  await drainIO();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const box of boxes.splice(0)) box.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function drainIO() {
  for (;;) {
    await new Promise<void>((r) => immediate(r));
    if (io.pending === 0) return;
    await new Promise<void>((r) => io.waiters.push(r));
  }
}
function temp() {
  const r = mkdtempSync(join(tmpdir(), "codex-owner2301-"));
  roots.push(r);
  return r;
}
const log: any = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};
const ID = "01a1c81a-35be-7fc0-9a6d-f53f7d6c4c07";
const TEXT =
  "[quiet-heartbeat-2301] Check the inert task board; if nothing changed, stay silent.";
const fixture = (name: string) =>
  readFileSync(
    new URL("./fixtures/codex-pane-owner-2301/" + name, import.meta.url),
    "utf8",
  );
// Unmodified pinned Codex 0.167.0 mock-only pane captures; rollout metadata cwd is normalized in the fixture.
const ownedFrame = fixture;
function harness() {
  vi.useFakeTimers();
  const root = temp(),
    instance = join(root, "instances", "worker"),
    sessions = join(root, "sessions");
  mkdirSync(instance, { recursive: true });
  mkdirSync(sessions);
  writeFileSync(join(instance, "window-id"), "@worker");
  const path = join(sessions, `rollout-2026-10-21T04-37-30-${ID}.jsonl`);
  const rows = fixture("rollout.selected.jsonl").trimEnd().split("\n");
  const meta = JSON.parse(rows[0]);
  meta.payload.cwd = root;
  writeFileSync(path, JSON.stringify(meta) + "\n");
  const backend = new CodexBackend(instance);
  (backend as any).isolatedCodexHome = root;
  const box = new DeliveryOutbox(join(root, "outbox.db"), "manager");
  boxes.push(box);
  const d: any = new Daemon(
    "worker",
    {
      working_directory: root,
      backend: "codex",
      context_guardian: { max_age_hours: 4, grace_period_ms: 600000 },
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    } as any,
    instance,
    false,
    backend,
    {
      getObservationResetAt: () => 0,
      getLastOutputAt: () => undefined,
      isIdle: () => true,
      waitUntilIdle: vi.fn(async () => true),
      hasOutputSince: () => false,
    } as any,
    log,
  );
  daemons.push(d);
  d.setDeliveryOutboxPort(box);
  let sent = false;
  const tmux = {
    getWindowId: () => "@worker",
    capturePane: vi.fn(async () =>
      ownedFrame(sent ? "after-fast.pane.txt" : "after-ready-120.pane.txt"),
    ),
    pasteBuffer: vi.fn(async () => {
      sent = true;
      appendFileSync(path, rows.slice(1).join("\n") + "\n");
      return true;
    }),
    sendSpecialKey: vi.fn(async () => true),
    sendKey: vi.fn(async () => true),
  };
  d.tmux = tmux;
  d.transcriptMonitor = {
    reconciliationCheckpoint: async () => ({
      path,
      offset: Buffer.byteLength(JSON.stringify(meta) + "\n"),
      sessionId: path,
    }),
  };
  vi.spyOn(d, "wake").mockResolvedValue(undefined);
  vi.spyOn(d, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(d, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(d, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(d, "hasPositiveDeliveryInput").mockResolvedValue(true);
  vi.spyOn(d, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  const row = box.admit({
    operationId: "owned2301",
    sourceKey: "schedule:2301:worker:raw_paste",
    sourceInstance: "fleet",
    sourceDaemonBootId: "source",
    targetInstance: "worker",
    kind: "raw_paste",
    payload: { type: "raw_paste", content: TEXT },
  }).delivery;
  const claim = box.claimNext("test", () => d.bootId, new Set())!;
  const state = () => box.get(row.deliveryId)?.state;
  const run = () =>
    d.queueRawPaste(TEXT, d.deliveryEpoch, false, {
      deliveryId: row.deliveryId,
      attemptNo: claim.attemptNo,
      submissionMode: "raw_paste",
    });
  const pump = async () => {
    for (
      let i = 0;
      i < 1000 && ["delivering", "submission_started"].includes(state() ?? "");
      i++
    ) {
      await drainIO();
      await vi.advanceTimersByTimeAsync(50);
    }
    await drainIO();
  };

  return { root, path, rows, d, backend, box, row, tmux, state, run, pump };
}
describe("#2301 pane/session ownership", () => {
  it("puts UUID and Context first in the private footer; shared config and other items survive", () => {
    const root = temp(),
      shared = join(root, "shared");
    mkdirSync(shared);
    const text =
      '[tui]\nstatus_line=["model-with-reasoning","context-used","git-branch"]\n';
    writeFileSync(join(shared, "config.toml"), text);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = shared;
    try {
      const b: any = new CodexBackend(join(root, "instance"));
      b.writeConfig({
        workingDirectory: root,
        instanceDir: join(root, "instance"),
        instanceName: "worker",
        mcpServers: {},
        skipResume: true,
      });
      expect(
        (
          parse(
            readFileSync(join(b.isolatedCodexHome, "config.toml"), "utf8"),
          ) as any
        ).tui.status_line,
      ).toEqual([
        "session-id",
        "context-used",
        "model-with-reasoning",
        "git-branch",
      ]);
      expect(readFileSync(join(shared, "config.toml"), "utf8")).toBe(text);
      expect(b.getSessionId()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });
  it("confirms the recorded fast-answer raw paste from its pre-write owned rollout, without another input", async () => {
    const h = harness();
    const started = Date.now();
    h.run();
    await h.pump();
    expect(h.state()).toBe("delivered");
    // A completed owned read confirms in the normal proof phase, without waiting for the detached late watch.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });
});

describe("#2301 binding refuses guesses and never revives", () => {
  it.each([
    [
      "truncated UUID",
      (p: string) => p.replace(ID, ID.slice(0, 20) + "…"),
      false,
    ],
    [
      "truncated Context",
      (p: string) => p.replace(/Context \d+% (left|used)/, "Context …"),
      true,
    ],
    [
      "UUID only in history",
      (p: string) => ID + "\n" + p.replace(ID + " · ", ""),
      true,
    ],
    ["quoted footer", (p: string) => p.replace(ID, "│ " + ID), false],
    ["missing footer", (p: string) => p.replace(/^.*Context.*$/m, ""), false],
  ] as const)("%s cannot bind a transcript", async (_label, edit, written) => {
    const h = harness();
    expect(
      h.backend.readRawPasteSession(
        edit(ownedFrame("after-ready-120.pane.txt")),
      ),
    ).toBeNull();
    const get = h.tmux.capturePane.getMockImplementation()!;
    h.tmux.capturePane.mockImplementation(async () => edit(await get()));
    h.run();
    await h.pump();
    expect(h.state()).toBe(written ? "uncertain" : "retry_wait");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(written ? 1 : 0);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(written ? 1 : 0);
  });
  it("a matching old user row before the pre-write checkpoint cannot prove a new paste", async () => {
    const h = harness();
    appendFileSync(h.path, h.rows.slice(1).join("\n") + "\n");
    h.tmux.pasteBuffer.mockImplementation(async () => true);
    const get = h.tmux.capturePane.getMockImplementation()!;
    h.tmux.capturePane.mockImplementation(async () =>
      h.tmux.pasteBuffer.mock.calls.length
        ? ownedFrame("after-fast.pane.txt")
        : get(),
    );
    h.run();
    await h.pump();
    expect(h.state()).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledOnce();
  });
  it("a different newer same-cwd rollout cannot prove this pane consumed the paste", async () => {
    const h = harness();
    const other = ID.replace(/^01/, "02");
    const rows = h.rows.map((r, i) =>
      i
        ? r
        : JSON.stringify({
            ...JSON.parse(r),
            payload: { ...JSON.parse(r).payload, id: other, cwd: h.root },
          }),
    );
    writeFileSync(
      join(h.root, "sessions", `rollout-newer-${other}.jsonl`),
      rows.join("\n") + "\n",
    );
    h.tmux.pasteBuffer.mockImplementation(async () => true);
    h.tmux.capturePane.mockImplementation(async () =>
      ownedFrame(
        h.tmux.pasteBuffer.mock.calls.length
          ? "after-fast.pane.txt"
          : "after-ready-120.pane.txt",
      ),
    );
    h.run();
    await h.pump();
    expect(h.state()).toBe("uncertain");
  });
  it("a switched session retires the lease; restoring the UUID does not revive it", async () => {
    const h = harness();
    const cp = await h.d.bindCodexRawPaste("@worker", () => true);
    expect(cp).not.toBeNull();
    h.tmux.capturePane.mockResolvedValue(
      ownedFrame("after-fast.pane.txt").replace(ID, ID.replace(/^01/, "02")),
    );
    expect(await cp.ownedCodex.validate()).toBe(false);
    h.tmux.capturePane.mockResolvedValue(ownedFrame("after-fast.pane.txt"));
    expect(await cp.ownedCodex.validate()).toBe(false);
  });
  it.each(["launchAttempt", "spawnGeneration", "launchFenceEpoch"] as const)(
    "a changed %s after the transcript look cannot settle",
    async (field) => {
      const h = harness();
      const cp = await h.d.bindCodexRawPaste("@worker", () => true);
      expect(cp).not.toBeNull();
      h.tmux.capturePane.mockResolvedValue(ownedFrame("after-fast.pane.txt"));
      const signature = h.d.submissionSignature(TEXT);
      signature.transcript = h.d.transcriptProofFor(
        cp,
        { rawText: TEXT },
        h.d.spawnGeneration,
        () => true,
        () => {},
      );
      signature.transcript.reader.look = async () => {
        h.d[field]++;
        return "user";
      };
      expect(await h.d.confirmSubmitted(signature, null)).toBe("unproven");
      expect(signature.transcript.provenBy).toBeUndefined();
    },
  );
  it("file replacement after the paste stays uncertain, with no resend", async () => {
    const h = harness();
    const paste = h.tmux.pasteBuffer.getMockImplementation()!;
    h.tmux.pasteBuffer.mockImplementation(async () => {
      await paste();
      const bytes = readFileSync(h.path);
      renameSync(h.path, h.path + ".old");
      writeFileSync(h.path, bytes);
      return true;
    });
    h.run();
    await h.pump();
    expect(h.state()).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledOnce();
  });
});

describe("#2301 proof continuations", () => {
  it.each(["window", "tmux", "caller", "dialog", "capture"] as const)(
    "retires a %s change after a positive read",
    async (change) => {
      const h = harness();
      let live = true;
      const cp = await h.d.bindCodexRawPaste("@worker", () => live);
      expect(cp).not.toBeNull();
      const original = h.d.tmux;
      h.tmux.capturePane.mockResolvedValue(ownedFrame("after-fast.pane.txt"));
      const signature = h.d.submissionSignature(TEXT);
      signature.transcript = h.d.transcriptProofFor(
        cp,
        { rawText: TEXT },
        h.d.spawnGeneration,
        () => true,
        () => {},
      );
      signature.transcript.reader.look = async () => {
        if (change === "window") h.tmux.getWindowId = () => "@other";
        if (change === "tmux") h.d.tmux = { ...h.tmux };
        if (change === "caller") live = false;
        if (change === "dialog") {
          vi.spyOn(h.d, "deliveryBlockingDialogs").mockReturnValue([
            {
              pattern: /BLOCK2301/,
              keys: [],
              description: "inert hold",
              blocksDelivery: true,
            },
          ]);
          h.tmux.capturePane.mockResolvedValue(
            "BLOCK2301\n" + ownedFrame("after-fast.pane.txt"),
          );
        }
        if (change === "capture")
          h.tmux.capturePane.mockRejectedValue(Error("unreadable"));
        return "user";
      };
      expect(await h.d.confirmSubmitted(signature, null)).toBe("unproven");
      expect(signature.transcript.provenBy).toBeUndefined();
      h.d.tmux = original;
      h.tmux.getWindowId = () => "@worker";
      live = true;
      h.tmux.capturePane.mockResolvedValue(ownedFrame("after-fast.pane.txt"));
      expect(await cp.ownedCodex.validate()).toBe(false);
    },
  );
  it("a launch change during pre-write binding cannot begin or paste into its replacement", async () => {
    const h = harness();
    const read = h.backend.readRawPasteSession.bind(h.backend);
    let calls = 0;
    h.backend.readRawPasteSession = (pane: string) => {
      if (++calls === 2) h.d.launchAttempt++;
      return read(pane);
    };
    h.run();
    await h.pump();
    expect(h.state()).toBe("retry_wait");
    expect(h.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(h.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });
  it("both the real 80-column Context truncation and 45-column UUID truncation refuse ownership", () => {
    const h = harness();
    for (const width of [80, 45, 30])
      expect(
        h.backend.readRawPasteSession(fixture(`after-ready-${width}.pane.txt`)),
      ).toBeNull();
    expect(
      h.backend.readRawPasteSession(fixture("after-ready-100.pane.txt"))
        ?.sessionId,
    ).toBe(ID);
  });
});


describe("#2301 post-paste fallback keeps the session lease", () => {
  it.each(["before read", "during empty read", "before settlement"] as const)(
    "binding loss %s retires the fallback without another paste or poll",
    async (phase) => {
      const h = harness();
      // Force the real post-paste path: pane submission proof failed, so only the
      // bounded transcript fallback can settle this already-written delivery.
      vi.spyOn(h.d, "confirmSubmitted").mockResolvedValue("unproven");
      h.tmux.pasteBuffer.mockResolvedValue(true);
      h.tmux.capturePane.mockImplementation(async () =>
        ownedFrame(h.tmux.pasteBuffer.mock.calls.length
          ? "after-fast.pane.txt" : "after-ready-120.pane.txt"),
      );
      const lose = () => h.tmux.capturePane.mockResolvedValue(
        ownedFrame("after-fast.pane.txt").replace(ID, ID.replace(/^01/, "02")),
      );
      const append = () => appendFileSync(h.path, h.rows.slice(1).join("\n") + "\n");
      const realLook = TranscriptDeltaReader.prototype.look;
      const looks: string[] = [];
      const look = vi.spyOn(TranscriptDeltaReader.prototype, "look")
        .mockImplementation(async function (this: TranscriptDeltaReader) {
          const result = await realLook.call(this);
          looks.push(result);
          if (phase === "during empty read") {
            // The read observed no marker. Before its continuation, the pane
            // switches, then the old rollout receives the exact pasted text.
            lose();
            append();
          }
          return result;
        });
      const realProve = h.d.proveDeliveryFromTranscript.bind(h.d);
      let entered = false;
      vi.spyOn(h.d, "proveDeliveryFromTranscript").mockImplementation(
        async (...args: any[]) => {
          const bound = args[1].ownedCodex;
          expect(bound).toBeDefined();
          if (phase === "before read") { lose(); append(); }
          if (phase === "before settlement") {
            append();
            const validate = bound.validate.bind(bound);
            let checks = 0;
            bound.validate = async () => {
              // Pre-read and post-read checks are still valid. The footer
              // changes only at the final settlement continuation.
              if (++checks === 3) lose();
              return validate();
            };
          }
          entered = true;
          return realProve(...args);
        },
      );
      h.run();
      for (let i = 0; i < 1000 && !entered; i++) {
        await drainIO();
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(entered).toBe(true);
      // Let filesystem continuations finish while holding the fake clock. A
      // retired post-read lease must not sleep until the next transcript poll.
      await drainIO();
      expect(h.state()).toBe("uncertain");
      const evidence = (h.box as any).db.prepare(
        "SELECT evidence FROM delivery_attempts WHERE delivery_id=?",
      ).get(h.row.deliveryId)?.evidence;
      expect(evidence).toBe(
        "raw-paste-submit-proof:codex-session-binding-lost; not re-pasted",
      );
      expect(readFileSync(h.path, "utf8")).toContain(TEXT);
      expect(look).toHaveBeenCalledTimes(phase === "before read" ? 0 : 1);
      expect(looks).toEqual(phase === "before read" ? [] :
        [phase === "during empty read" ? "no-match" : "user"]);
      expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
      expect(h.tmux.sendSpecialKey).toHaveBeenCalledOnce();
      await h.pump();
      expect(h.state()).toBe("uncertain");
      expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    },
  );
});
