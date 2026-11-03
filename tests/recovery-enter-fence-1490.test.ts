import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * #1490 (2.2 audit): `confirmAfterEnter`'s recovery Enters (and the Kiro stranded-text retry) waited for the prompt,
 * then called `sendDeliveryEnter` without a fence. A `recoverWindow` during that wait replaces `this.tmux` with a new
 * window, so the Enter went to the recovered window and the proof that followed judged that window's pane.
 *
 * The real Daemon methods; tmux is a stub per window, and the wait in the middle is where the window is replaced, as
 * recoverWindow would. No tmux, no fleet.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeTmux(windowId: string) {
  return {
    windowId,
    sendSpecialKey: vi.fn(async () => true),
    getWindowId: () => windowId,
    getLastSendSpecialKeyError: () => null,
    capturePane: vi.fn(async () => ""),
  };
}

function makeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-enter-fence-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("fence-test", {
    working_directory: "/tmp", backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, undefined, undefined, { child: () => logger } as any) as any;
  const original = fakeTmux("@7");
  const recovered = fakeTmux("@8");
  daemon.tmux = original;
  daemon.waitForInputTransientToClear = async () => true;
  const proofsOn: string[] = [];
  // Honours the attempt's fence as the real confirmSubmitted does (pinned below against the real one).
  daemon.confirmSubmitted = async (_s: unknown, _b: unknown, owned?: () => boolean) => {
    if (owned && !owned()) return "unproven";
    proofsOn.push(daemon.tmux.getWindowId());
    return "stranded";
  };
  /** recoverWindow, as it lands in the middle of a wait: a new window behind this.tmux. */
  const recover = () => { daemon.tmux = recovered; };
  return { daemon, original, recovered, recover, proofsOn };
}

const SIG = { text: "x" } as any;
const enters = (h: ReturnType<typeof makeDaemon>) => h.original.sendSpecialKey.mock.calls.length + h.recovered.sendSpecialKey.mock.calls.length;

describe("a recovery Enter after a wait goes only to the window it was for (#1490)", () => {
  for (const path of ["structured", "plain"] as const) {
    it(`${path} proof path: a window replaced during the prompt wait gets no Enter and no proof`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => { h.recover(); return true; };
      const proofsBefore = h.proofsOn.length;

      const ok = await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry");
      expect(ok).toBe(false);
      expect(enters(h), "no recovery Enter into either window").toBe(0);
      expect(h.proofsOn.slice(proofsBefore).filter((w) => w === "@8"), "no proof judged on the recovered window").toEqual([]);
    });

    it(`${path} proof path: the same window still gets its one recovery Enter (control)`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => true;
      let proofs = 0;
      h.daemon.confirmSubmitted = async () => (++proofs > 2 ? "submitted" : "stranded");

      expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(true);
      expect(h.original.sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(h.recovered.sendSpecialKey).not.toHaveBeenCalled();
    });
  }

  for (const path of ["structured", "plain"] as const) {
    it(`${path} proof path: a window replaced during the Enter's own transient wait is refused at the write`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => true;
      h.daemon.waitForInputTransientToClear = async () => { h.recover(); return true; };
      expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
      expect(enters(h), "the fence is asked last, right before the key").toBe(0);
    });
  }

  for (const path of ["structured", "plain"] as const) {
    it(`${path} proof path: a window replaced after the recovery Enter is not judged`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => true;
      h.original.sendSpecialKey.mockImplementation(async () => { h.recover(); return true; });   // recovered right after the key
      const before = h.proofsOn.length;
      expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
      expect(h.original.sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(h.proofsOn.slice(before).filter((w) => w === "@8"), "no proof judged on the recovered window").toEqual([]);
    });
  }

  it("busy-signal path (a backend we cannot read): a window replaced during the transient wait gets no Enter", async () => {
    const h = makeDaemon();
    h.daemon.canProveSubmission = () => false;
    h.daemon.confirmBusyAfterEnter = async () => false;
    h.daemon.waitForInputTransientToClear = async () => { h.recover(); return true; };
    expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
    expect(enters(h)).toBe(0);
  });

  it("busy-signal path: the same window gets its recovery Enter (control)", async () => {
    const h = makeDaemon();
    h.daemon.canProveSubmission = () => false;
    let checks = 0;
    h.daemon.confirmBusyAfterEnter = async () => ++checks > 1;
    expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(true);
    expect(h.original.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("a respawn in the same window (a new spawn generation) also fences the Enter", async () => {
    const h = makeDaemon();
    h.daemon.canProveSubmission = () => true;
    h.daemon.structuredInputEvidence = () => false;
    h.daemon.backend = undefined;
    h.daemon.waitForPaneReadyForDelivery = async () => { h.daemon.spawnGeneration++; return true; };
    expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
    expect(enters(h)).toBe(0);
  });
});

describe("a proof is owned by its window too (#1514 review)", () => {
  /** A proof whose capture is held; while it is held the window may be replaced, then it answers. */
  function heldProof(h: ReturnType<typeof makeDaemon>, script: Array<{ answer: string; recoverDuring?: boolean }>) {
    let i = 0;
    h.daemon.confirmSubmitted = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step.recoverDuring) h.recover();
      return step.answer;
    };
  }

  for (const path of ["structured", "plain"] as const) {
    it(`${path}: a proof whose window was replaced during its capture is not accepted, even if it reads "submitted"`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => true;
      // First look: stranded. After the recovery Enter: the capture is held, the window replaced, and it reads submitted.
      heldProof(h, [{ answer: "stranded" }, { answer: "stranded" }, { answer: "submitted", recoverDuring: true }]);
      expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
    });

    it(`${path}: the same proof on the same window is accepted (control)`, async () => {
      const h = makeDaemon();
      h.daemon.canProveSubmission = () => true;
      h.daemon.structuredInputEvidence = () => path === "structured";
      h.daemon.backend = undefined;
      h.daemon.waitForPaneReadyForDelivery = async () => true;
      heldProof(h, [{ answer: "stranded" }, { answer: "stranded" }, { answer: "submitted" }]);
      expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(true);
    });
  }

  it("structured: a replacement during the first poll's delay cannot confirm on the next capture", async () => {
    const h = makeDaemon();
    h.daemon.canProveSubmission = () => true;
    h.daemon.structuredInputEvidence = () => true;
    h.daemon.backend = undefined;
    heldProof(h, [{ answer: "unproven", recoverDuring: true }, { answer: "submitted" }]);
    expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
  });

  it("busy signal after a replacement is not accepted", async () => {
    const h = makeDaemon();
    h.daemon.canProveSubmission = () => false;
    h.daemon.confirmBusyAfterEnter = async () => { h.recover(); return true; };
    expect(await h.daemon.confirmAfterEnter("@7", Date.now(), SIG, null, "fence-retry")).toBe(false);
  });

  it("the real confirmSubmitted does not judge a capture taken across a replacement", async () => {
    const h = makeDaemon();
    const judge = vi.fn(() => "submitted");
    h.daemon.judgeSubmission = judge;
    h.daemon.confirmSubmitted = Object.getPrototypeOf(h.daemon).confirmSubmitted;   // the real one
    h.original.capturePane.mockImplementation(async () => { h.recover(); return "a pane"; });
    const tmux = h.daemon.tmux, generation = h.daemon.spawnGeneration;
    const owned = () => h.daemon.tmux === tmux && h.daemon.spawnGeneration === generation;
    expect(await h.daemon.confirmSubmitted(SIG, null, owned)).toBe("unproven");
    expect(judge, "not judged: judging can retire the spawn's input guard").not.toHaveBeenCalled();
    // control: the same capture without a replacement is judged
    const h2 = makeDaemon();
    const judge2 = vi.fn(() => "submitted");
    h2.daemon.judgeSubmission = judge2;
    h2.daemon.confirmSubmitted = Object.getPrototypeOf(h2.daemon).confirmSubmitted;
    h2.original.capturePane.mockImplementation(async () => "a pane");
    const t2 = h2.daemon.tmux, g2 = h2.daemon.spawnGeneration;
    expect(await h2.daemon.confirmSubmitted(SIG, null, () => h2.daemon.tmux === t2 && h2.daemon.spawnGeneration === g2)).toBe("submitted");
    expect(judge2).toHaveBeenCalledOnce();
  });
});

describe("a fenced confirmation is not revived by the caller's late proof (#1514 review)", () => {
  function deliveryHarness(path: "structured" | "plain", replaceDuringWait: boolean) {
    const h = makeDaemon();
    const control = {
      lastOutputAt: undefined as number | undefined, observationResetAt: 0,
      getLastOutputAt() { return this.lastOutputAt; }, getObservationResetAt() { return this.observationResetAt; },
      hasOutputSince() { return false; }, isIdle: () => true, waitUntilIdle: async () => true,
    };
    h.daemon.controlClient = control;
    Object.assign(h.original, { pasteBuffer: vi.fn(async () => true) });
    Object.assign(h.recovered, { pasteBuffer: vi.fn(async () => true) });
    h.daemon.canProveSubmission = () => true;
    h.daemon.structuredInputEvidence = () => path === "structured";
    h.daemon.capturePaneEvidence = async () => null;
    h.daemon.waitForPaneReadyForDelivery = async () => { if (replaceDuringWait) h.recover(); return true; };
    // The pane answers by window: the original keeps the paste stranded, the replacement reads "submitted".
    h.daemon.confirmSubmitted = async (_s: unknown, _b: unknown, owned?: () => boolean) =>
      (owned && !owned()) ? "unproven" : (h.daemon.tmux === h.recovered ? "submitted" : "stranded");
    h.daemon.lateCodexSubmissionProof = async (s: unknown, b: unknown, _w: boolean, owned?: () => boolean) => h.daemon.confirmSubmitted(s, b, owned);
    const confirmed: unknown[] = [];
    h.daemon.on("message_confirmed", (s: unknown) => confirmed.push(s));
    return { h, confirmed };
  }

  for (const path of ["structured", "plain"] as const) {
    it(`${path}: the window replaced during the recovery wait — no ✅ from the replacement's pane`, async () => {
      vi.useFakeTimers();
      try {
        const { h, confirmed } = deliveryHarness(path, true);
        const verdict: any = { reached: false };
        const pending = h.daemon.writeMessageToPane("hello", "@7", false, { chatId: "c", messageId: "m" }, undefined, verdict);
        for (let i = 0; i < 400 && !(await Promise.race([pending.then(() => true), Promise.resolve(false)])); i++) await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toBe(false);
        expect(confirmed, "the old delivery is not confirmed by the new window").toEqual([]);
        expect(verdict.proof).toBe("window-replaced");
        expect(h.recovered.sendSpecialKey, "no Enter into the replacement").not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
  }
});
