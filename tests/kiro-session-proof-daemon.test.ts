/**
 * M-2025: after a tui/V3 launch the daemon types `/session-id` then `/title`
 * into an idle composer (Daemon.ensureKiroSessionProof). The pin is compared
 * with kiro's pane announcement; a mismatch is never repaired from files.
 * Nothing here starts a process, tmux or a fleet: the backend, the pane and
 * readiness are stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { t } from "../src/locale.js";
import { readKiroSessionProof, recordKiroSessionProof } from "../src/kiro-session-proof.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });

const idle = "›  ask a question or describe a task ↵";
const announced = (id: string) => `Session ID: ${id}\nResume with: kiro-cli --resume-id ${id}\n\n${idle}`;
const announcedNone = `Session ID: none\n\n${idle}`;

function rig(opts: {
  panes: Array<string | null | Error>;
  proof?: { pinned: string | null; sessionIdCommand: string; titleCommand: string | null } | null;
  readiness?: () => string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2025-daemon-")); dirs.push(dir);
  const logger = { info: vi.fn(), warn: vi.fn(), error() {}, debug() {}, child() { return this; } } as any;
  const proof = opts.proof === undefined
    ? { pinned: "conv-1", sessionIdCommand: "/session-id", titleCommand: "/title worker" }
    : opts.proof;
  const backend = {
    binaryName: "kiro-cli",
    sessionProof: proof === null ? () => null : () => proof,
    getReadyPattern: () => /ask a question or describe a task/,
    getBusyPattern: () => /Kiro is working/,
  };
  const daemon: any = new Daemon("worker", {
    working_directory: dir, log_level: "error", backend: "kiro-cli",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, join(dir, "worker"), false, backend as any, undefined as any, logger);
  const queue = [...opts.panes];
  let last: string | null = null;
  const capturePane = vi.fn(async () => {
    const next = queue.length ? queue.shift()! : last;
    if (next instanceof Error) throw next;
    last = next;
    return next ?? "";
  });
  const pasteBuffer = vi.fn(async (_text: string, _opts?: { guard?: () => boolean; timeoutMs?: number }) => true);
  const sendSpecialKey = vi.fn(async () => true);
  const deleteBackward = vi.fn(async () => true);
  daemon.tmux = { getWindowId: () => "@1", capturePane, pasteBuffer, sendSpecialKey, deleteBackward };
  daemon.paneReadinessForDelivery = vi.fn(async () => opts.readiness?.() ?? "ready");
  const warnings: string[] = [];
  const events: Array<{ name: string; message: string; quiet?: boolean }> = [];
  daemon.on("backend_launch_warning", (w: { name: string; message: string; quiet?: boolean }) => {
    warnings.push(w.message); events.push(w);
  });
  return { daemon, capturePane, pasteBuffer, sendSpecialKey, deleteBackward, warnings, events, logger, instanceDir: join(dir, "worker") };
}

async function run(daemon: any): Promise<void> {
  const done = daemon.ensureKiroSessionProof();
  await vi.advanceTimersByTimeAsync(20_000);
  await done;
}

describe("kiro /session-id and /title after a tui/V3 launch", () => {
  it("match: types /session-id then /title into an idle composer, no warning", async () => {
    const r = rig({ panes: [idle, announced("conv-1")] });
    await run(r.daemon);
    expect(r.pasteBuffer.mock.calls.map((c) => c[0])).toEqual(["/session-id", "/title worker"]);
    expect(r.pasteBuffer).toHaveBeenCalledWith("/session-id", expect.objectContaining({ timeoutMs: 1_000 }));
    expect(r.sendSpecialKey).toHaveBeenCalledWith("Enter", 1_000);
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toMatchObject({ sessionId: "conv-1", kind: "match", source: "/session-id" });
  });

  it("fresh: no pin, kiro named an id — logged, not a file-store guess, title still sent", async () => {
    const r = rig({
      panes: [idle, announced("fresh-id")],
      proof: { pinned: null, sessionIdCommand: "/session-id", titleCommand: "/title worker" },
    });
    await run(r.daemon);
    expect(r.pasteBuffer.mock.calls.map((c) => c[0])).toEqual(["/session-id", "/title worker"]);
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toMatchObject({ sessionId: "fresh-id", kind: "fresh" });
  });

  it("mismatch: the pin and the pane disagree — warning is not quiet, title still sent, pin not rewritten", async () => {
    const r = rig({ panes: [idle, announced("other-b")] });
    await run(r.daemon);
    expect(r.pasteBuffer.mock.calls.map((c) => c[0])).toEqual(["/session-id", "/title worker"]);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_mismatch", "conv-1", "other-b") }]);
    expect(r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: "conv-1", observed: "other-b" }),
      "kiro /session-id does not match the pinned conversation",
    );
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("unread: /session-id typed, no announcement — warning is not quiet, files not guessed, title still sent", async () => {
    const r = rig({ panes: [idle] });
    await run(r.daemon);
    expect(r.pasteBuffer.mock.calls.map((c) => c[0])).toEqual(["/session-id", "/title worker"]);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_unread") }]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("Session ID: none with a pin is a mismatch", async () => {
    const r = rig({ panes: [idle, announcedNone] });
    await run(r.daemon);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_mismatch", "conv-1", "none") }]);
  });

  it("legacy (sessionProof null): nothing typed", async () => {
    const r = rig({ panes: [idle], proof: null });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  for (const state of ["busy", "dialog", "transient", "unknown"]) {
    it(`a pane that is not ready (${state}) is never written to; unread is not claimed`, async () => {
      const r = rig({ panes: [idle], readiness: () => state });
      await run(r.daemon);
      expect(r.pasteBuffer).not.toHaveBeenCalled();
      expect(r.warnings).toEqual([]);
    });
  }

  it("no titleCommand: /session-id still typed, /title is not", async () => {
    const r = rig({
      panes: [idle, announced("conv-1")],
      proof: { pinned: "conv-1", sessionIdCommand: "/session-id", titleCommand: null },
    });
    await run(r.daemon);
    expect(r.pasteBuffer.mock.calls.map((c) => c[0])).toEqual(["/session-id"]);
    expect(r.warnings).toEqual([]);
  });

  it("a respawn while the write is in flight: nothing confirmed, no warning", async () => {
    const r = rig({ panes: [idle, announced("conv-1")] });
    r.pasteBuffer.mockImplementation(async () => { r.daemon.spawnGeneration++; return true; });
    await run(r.daemon);
    expect(r.warnings).toEqual([]);
  });

  it("a stop while a capture is awaited: nothing written, no unread warning", async () => {
    const r = rig({ panes: [idle] });
    r.capturePane.mockImplementation(async () => { r.daemon.deliveryWritesStopping = true; return idle; });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("a pause (launch fence) during the readiness check under the lock: no write", async () => {
    const r = rig({ panes: [idle] });
    r.daemon.paneReadinessForDelivery = vi.fn(async () => { r.daemon.launchFenceEpoch++; return "ready"; });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("mismatch clears a stale proof rather than leaving the old id proven", async () => {
    const r = rig({ panes: [idle, announced("other-b")] });
    recordKiroSessionProof(r.instanceDir, { sessionId: "conv-1", kind: "match", provenAt: 1 });
    await run(r.daemon);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });
});

describe("holds: trust, question, MCP, takeover — never typed even if readiness says ready", () => {
  function kiroUi(ui: "tui" | "v3"): KiroBackend {
    const instanceDir = mkdtempSync(join(tmpdir(), "kiro-proof-hold-"));
    dirs.push(instanceDir);
    const b = new KiroBackend(instanceDir, TEST_KIRO_COMPAT);
    b.buildCommand({ workingDirectory: instanceDir, instanceDir, instanceName: "worker", mcpServers: {}, kiroUi: ui });
    return b;
  }
  const fixture = (rel: string) => readFileSync(join(import.meta.dirname, "fixtures", rel), "utf8");

  for (const [label, rel] of [
    ["question card", "kiro-question-2592/2.34.0-120-40-question.pane.txt"],
    ["MCP input card", "kiro-2.34.0-audit/mcp-120-10-form-2.34.0.pane.txt"],
    ["trust-all-tools", "kiro-2.34.0-audit/t2-trust-120-2.34.0.pane.txt"],
    ["tui editor", "kiro-2.34.0-takeover-2682/tui-editor-vi.pane.txt"],
    ["focused /kvim", "kiro-2.34.0-takeover-2682/tui-kvim-focused.pane.txt"],
    ["tui !vim", "kiro-2.34.0-takeover-2682/tui-bang-vi-insert.pane.txt"],
  ] as const) {
    it(`${label} is not written`, async () => {
      const kb = kiroUi("tui");
      const r = rig({ panes: [fixture(rel)], readiness: () => "ready" });
      r.daemon.backend.getRuntimeDialogs = () => kb.getRuntimeDialogs();
      r.daemon.backend.getReadyPattern = () => kb.getReadyPattern();
      r.daemon.backend.getBusyPattern = () => kb.getBusyPattern();
      await run(r.daemon);
      expect(r.pasteBuffer).not.toHaveBeenCalled();
      expect(r.warnings).toEqual([]);
      expect(readKiroSessionProof(r.instanceDir)).toBeNull();
    });
  }

  it("V3 editor takeover is not written", async () => {
    const kb = kiroUi("v3");
    const r = rig({ panes: [fixture("kiro-2.34.0-takeover-2682/v3-editor-vi.pane.txt")], readiness: () => "ready" });
    r.daemon.backend.getRuntimeDialogs = () => kb.getRuntimeDialogs();
    r.daemon.backend.getReadyPattern = () => kb.getReadyPattern();
    r.daemon.backend.getBusyPattern = () => kb.getBusyPattern();
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });
});
