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
  daemon.confirmSubmitted = async () => { proofsOn.push(daemon.tmux.getWindowId()); return "stranded"; };
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
