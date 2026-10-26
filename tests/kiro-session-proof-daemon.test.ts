/**
 * M-2025: after a tui/V3 launch the daemon types `/session-id` then `/title`
 * (Daemon.ensureKiroSessionProof). The pin is compared with kiro's own alert;
 * a mismatch is never repaired from files.
 *
 * #2683: each command goes only into a positively empty composer, Enter only
 * once the box shows exactly the command, and the id only from an alert that
 * was not on the pane before the command was typed. The pane here is a small
 * kiro model drawn from live 2.34.0 captures (tests/fixtures/kiro-session-id-2681)
 * and read with the real KiroBackend readers. Nothing starts a process, tmux or
 * a fleet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { t } from "../src/locale.js";
import { readKiroSessionProof, recordKiroSessionProof } from "../src/kiro-session-proof.js";
import { KiroBackend, readKiroCommandComposer, readKiroSessionIdAlert } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });

const fixture = (rel: string) => readFileSync(join(import.meta.dirname, "fixtures", rel), "utf8");
const sid = (name: string) => fixture(`kiro-session-id-2681/${name}.pane.txt`);
const MENU_ROW = "› /session-id";
const BOX_ROW = "›  ask a question or describe a task ↵";

function kiroUi(ui: "tui" | "v3"): KiroBackend {
  const instanceDir = mkdtempSync(join(tmpdir(), "kiro-proof-ui-"));
  dirs.push(instanceDir);
  const b = new KiroBackend(instanceDir, TEST_KIRO_COMPAT);
  b.buildCommand({ workingDirectory: instanceDir, instanceDir, instanceName: "worker", mcpServers: {}, kiroUi: ui });
  return b;
}

/**
 * kiro's box and its `/session-id` alert. `answer`: the id kiro prints (null: nothing appears). `alertBefore`: an
 * alert is already on the pane before anything is typed. `enterRuns`: Enter runs a command in the box (false: the
 * Enter is ignored and the text stays). `history`: the frame drawn when the box is empty and no alert is shown.
 */
interface Kiro {
  box: string;
  alert: string | null;
  answer: string | null;
  enterRuns: boolean;
  history: string;
  submitted: string[];
}

function draw(k: Kiro): string {
  if (k.box === "/session-id") return sid("tui-session-id-menu");
  if (k.box === "") {
    if (k.alert === null) return k.history;
    const alert = sid("tui-session-id-alert");
    if (k.alert !== "none") return alert.replaceAll("mock-session-id", k.alert);
    return alert.replace("• Session ID: mock-session-id\n  Resume with: kiro-cli --resume-id mock-session-id", "• Session ID: none");
  }
  return sid("tui-ready").replace(BOX_ROW, `› ${k.box}`);
}

function rig(opts: {
  kiro?: Partial<Kiro>;
  pinned?: string | null;
  proof?: "none";
  titleCommand?: string | null;
  readiness?: () => string;
  frame?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2683-daemon-")); dirs.push(dir);
  const logger = { info: vi.fn(), warn: vi.fn(), error() {}, debug() {}, child() { return this; } } as any;
  const kb = kiroUi("tui");
  const proof = opts.proof === "none" ? null : {
    pinned: opts.pinned === undefined ? "conv-1" : opts.pinned,
    sessionIdCommand: "/session-id",
    titleCommand: opts.titleCommand === undefined ? "/title worker" : opts.titleCommand,
    readComposer: readKiroCommandComposer,
    readSessionIdAlert: readKiroSessionIdAlert,
  };
  const backend = {
    binaryName: "kiro-cli",
    sessionProof: () => proof,
    getReadyPattern: () => kb.getReadyPattern(),
    getBusyPattern: () => kb.getBusyPattern(),
    getRuntimeDialogs: () => kb.getRuntimeDialogs(),
  };
  const daemon: any = new Daemon("worker", {
    working_directory: dir, log_level: "error", backend: "kiro-cli",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, join(dir, "worker"), false, backend as any, undefined as any, logger);
  const k: Kiro = {
    box: "", alert: null, answer: "conv-1", enterRuns: true, history: sid("tui-ready"), submitted: [], ...opts.kiro,
  };
  const capturePane = vi.fn(async () => opts.frame ?? draw(k));
  const pasteBuffer = vi.fn(async (text: string, _opts?: { guard?: () => boolean; timeoutMs?: number }) => {
    k.box += text; return true;
  });
  const sendSpecialKey = vi.fn(async (_key: string, _ms?: number) => {
    if (!k.enterRuns) return true;
    k.submitted.push(k.box);
    if (k.box === "/session-id" && k.answer !== null) k.alert = k.answer;
    k.box = "";
    return true;
  });
  const deleteBackward = vi.fn(async (n: number, _ms?: number) => { k.box = k.box.slice(0, -n); return true; });
  daemon.tmux = { getWindowId: () => "@1", capturePane, pasteBuffer, sendSpecialKey, deleteBackward };
  daemon.paneReadinessForDelivery = vi.fn(async () => opts.readiness?.() ?? "ready");
  const warnings: string[] = [];
  const events: Array<{ name: string; message: string; quiet?: boolean }> = [];
  daemon.on("backend_launch_warning", (w: { name: string; message: string; quiet?: boolean }) => {
    warnings.push(w.message); events.push(w);
  });
  return { daemon, k, capturePane, pasteBuffer, sendSpecialKey, deleteBackward, warnings, events, logger, instanceDir: join(dir, "worker") };
}

async function run(daemon: any): Promise<void> {
  const done = daemon.ensureKiroSessionProof();
  await vi.advanceTimersByTimeAsync(20_000);
  await done;
}

const pasted = (r: ReturnType<typeof rig>) => r.pasteBuffer.mock.calls.map((c) => c[0]);

describe("kiro /session-id and /title after a tui/V3 launch", () => {
  it("match: /session-id then /title, each into an empty box; the proof is recorded", async () => {
    const r = rig({});
    await run(r.daemon);
    expect(pasted(r)).toEqual(["/session-id", "/title worker"]);
    expect(r.k.submitted).toEqual(["/session-id", "/title worker"]);
    expect(r.pasteBuffer).toHaveBeenCalledWith("/session-id", expect.objectContaining({ timeoutMs: 1_000 }));
    expect(r.sendSpecialKey).toHaveBeenCalledWith("Enter", 1_000);
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toMatchObject({ sessionId: "conv-1", kind: "match", source: "/session-id" });
  });

  it("fresh: no pin, kiro named an id — recorded as fresh, title still sent", async () => {
    const r = rig({ pinned: null, kiro: { answer: "fresh-id" } });
    await run(r.daemon);
    expect(r.k.submitted).toEqual(["/session-id", "/title worker"]);
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toMatchObject({ sessionId: "fresh-id", kind: "fresh" });
  });

  it("mismatch: the pin and kiro's answer disagree — a warning, no proof, title still sent", async () => {
    const r = rig({ kiro: { answer: "other-b" } });
    await run(r.daemon);
    expect(r.k.submitted).toEqual(["/session-id", "/title worker"]);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_mismatch", "conv-1", "other-b") }]);
    expect(r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: "conv-1", observed: "other-b" }),
      "kiro /session-id does not match the pinned conversation",
    );
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("unread: /session-id ran and kiro printed nothing — a warning, no proof, title still sent", async () => {
    const r = rig({ kiro: { answer: null } });
    await run(r.daemon);
    expect(r.k.submitted).toEqual(["/session-id", "/title worker"]);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_unread") }]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("Session ID: none with a pin is a mismatch", async () => {
    const r = rig({ kiro: { answer: "none" } });
    await run(r.daemon);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_mismatch", "conv-1", "none") }]);
  });

  it("legacy (sessionProof null): nothing typed", async () => {
    const r = rig({ proof: "none" });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  for (const state of ["busy", "dialog", "transient", "unknown"]) {
    it(`a pane that is not ready (${state}) is never written to; unread is not claimed`, async () => {
      const r = rig({ readiness: () => state });
      await run(r.daemon);
      expect(r.pasteBuffer).not.toHaveBeenCalled();
      expect(r.warnings).toEqual([]);
    });
  }

  it("no titleCommand: /session-id still typed, /title is not", async () => {
    const r = rig({ titleCommand: null });
    await run(r.daemon);
    expect(pasted(r)).toEqual(["/session-id"]);
    expect(r.warnings).toEqual([]);
  });

  it("a respawn while the write is in flight: no Enter, no warning", async () => {
    const r = rig({});
    r.pasteBuffer.mockImplementation(async (text: string) => { r.k.box += text; r.daemon.spawnGeneration++; return true; });
    await run(r.daemon);
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("a stop while a capture is awaited: nothing written, no unread warning", async () => {
    const r = rig({});
    r.capturePane.mockImplementation(async () => { r.daemon.deliveryWritesStopping = true; return draw(r.k); });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("a pause (launch fence) during the readiness check under the lock: no write", async () => {
    const r = rig({});
    r.daemon.paneReadinessForDelivery = vi.fn(async () => { r.daemon.launchFenceEpoch++; return "ready"; });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("an earlier launch's proof never stands for this one: cleared on a mismatch", async () => {
    const r = rig({ kiro: { answer: "other-b" } });
    recordKiroSessionProof(r.instanceDir, { sessionId: "conv-1", kind: "match", provenAt: 1 });
    await run(r.daemon);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("an earlier launch's proof never stands for this one: cleared when nothing could be typed", async () => {
    const r = rig({ readiness: () => "busy" });
    recordKiroSessionProof(r.instanceDir, { sessionId: "conv-1", kind: "match", provenAt: 1 });
    await run(r.daemon);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });
});

describe("#2683 P2 (Prism): housekeeping commands go only into an EMPTY composer", () => {
  it("a person's draft under kiro's ready banner: nothing pasted, no Enter, the draft untouched", async () => {
    const r = rig({ kiro: { box: "draft from the person" } });
    expect(r.daemon.paneAuthoritativelyIdle(draw(r.k))).toBe(true);    // the gate that admitted it before
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.deleteBackward).not.toHaveBeenCalled();
    expect(r.k.box).toBe("draft from the person");
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("the live V3 draft and a person's `/se` with its menu open: nothing pasted", async () => {
    for (const name of ["v3-draft", "v3-menu-partial"]) {
      const r = rig({ frame: sid(name) });
      await run(r.daemon);
      expect(r.pasteBuffer, name).not.toHaveBeenCalled();
      expect(r.sendSpecialKey, name).not.toHaveBeenCalled();
    }
  });

  it("an ignored Enter leaves /session-id in the box: it is taken back and /title is never typed", async () => {
    const r = rig({ kiro: { enterRuns: false } });
    await run(r.daemon);
    expect(pasted(r)).toEqual(["/session-id"]);
    expect(r.sendSpecialKey).toHaveBeenCalledTimes(1);
    expect(r.deleteBackward).toHaveBeenCalledWith("/session-id".length, 1_000);
    expect(r.k.box).toBe("");
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("the box does not show exactly our command after the paste: no Enter, nothing erased, nothing more typed", async () => {
    const r = rig({});
    r.pasteBuffer.mockImplementation(async (text: string) => { r.k.box += "x" + text; return true; });
    await run(r.daemon);
    expect(pasted(r)).toEqual(["/session-id"]);
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.deleteBackward).not.toHaveBeenCalled();
    expect(r.k.box).toBe("x/session-id");
  });

  it("the box never empties after Enter (another text took its place): /title is not typed", async () => {
    const r = rig({});
    r.sendSpecialKey.mockImplementation(async () => { r.k.box = "someone else"; return true; });
    await run(r.daemon);
    expect(pasted(r)).toEqual(["/session-id"]);
    expect(r.deleteBackward).not.toHaveBeenCalled();
    expect(r.k.box).toBe("someone else");
    expect(r.warnings).toEqual([]);
  });

  it("a fence lost after the paste: no Enter, our command taken back", async () => {
    const r = rig({});
    r.pasteBuffer.mockImplementation(async (text: string) => { r.k.box += text; r.daemon.launchFenceEpoch++; return true; });
    await run(r.daemon);
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    // fenced() is false too, so nothing is typed or erased at all after the fence moved
    expect(r.deleteBackward).not.toHaveBeenCalled();
  });

  it("the deadline passing after the paste (fence intact): no Enter, our command taken back", async () => {
    const r = rig({});
    r.pasteBuffer.mockImplementation(async (text: string) => {
      r.k.box += text; vi.advanceTimersByTime(15_500); return true;
    });
    await run(r.daemon);
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.deleteBackward).toHaveBeenCalledWith("/session-id".length, 1_000);
    expect(r.k.box).toBe("");
  });
});

describe("#2683 P2 (Prism): an announcement that was already there is never proof", () => {
  it("Prism's repro: `Session ID: conv-1` on the pane before, unchanged after, no answer — unread, no proof", async () => {
    const r = rig({ kiro: { alert: "conv-1", answer: null } });
    await run(r.daemon);
    expect(r.k.submitted[0]).toBe("/session-id");
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_unread") }]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
    expect(r.logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "match" }), "kiro /session-id on the pane");
  });

  it("an alert before the command cannot be told from kiro's answer: no proof even when kiro answers the same", async () => {
    const r = rig({ kiro: { alert: "conv-1", answer: "conv-1" } });
    await run(r.daemon);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_unread") }]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("a quoted user turn naming the pin (live V3 history): unread, no proof", async () => {
    const quoted = sid("v3-quoted-history").replaceAll("quoted-1", "conv-1");
    const r = rig({ kiro: { history: quoted, answer: null } });
    await run(r.daemon);
    expect(r.events).toEqual([{ name: "worker", message: t("kiro.session_id_unread") }]);
    expect(readKiroSessionProof(r.instanceDir)).toBeNull();
  });

  it("the same quoted history, then kiro's own alert: proven", async () => {
    const quoted = sid("v3-quoted-history").replaceAll("quoted-1", "conv-1");
    const r = rig({ kiro: { history: quoted } });
    await run(r.daemon);
    expect(r.warnings).toEqual([]);
    expect(readKiroSessionProof(r.instanceDir)).toMatchObject({ sessionId: "conv-1", kind: "match" });
  });
});

describe("holds: trust, question, MCP, takeover — never typed even if readiness says ready", () => {
  for (const [label, rel, ui] of [
    ["question card", "kiro-question-2592/2.34.0-120-40-question.pane.txt", "tui"],
    ["MCP input card", "kiro-2.34.0-audit/mcp-120-10-form-2.34.0.pane.txt", "tui"],
    ["trust-all-tools", "kiro-2.34.0-audit/t2-trust-120-2.34.0.pane.txt", "tui"],
    ["tui editor", "kiro-2.34.0-takeover-2682/tui-editor-vi.pane.txt", "tui"],
    ["focused /kvim", "kiro-2.34.0-takeover-2682/tui-kvim-focused.pane.txt", "tui"],
    ["tui !vim", "kiro-2.34.0-takeover-2682/tui-bang-vi-insert.pane.txt", "tui"],
    ["V3 editor", "kiro-2.34.0-takeover-2682/v3-editor-vi.pane.txt", "v3"],
  ] as const) {
    it(`${label} is not written`, async () => {
      const kb = kiroUi(ui);
      const r = rig({ frame: fixture(rel), readiness: () => "ready" });
      r.daemon.backend.getRuntimeDialogs = () => kb.getRuntimeDialogs();
      await run(r.daemon);
      expect(r.pasteBuffer).not.toHaveBeenCalled();
      expect(r.warnings).toEqual([]);
      expect(readKiroSessionProof(r.instanceDir)).toBeNull();
    });
  }
});

it("the model draws the live frames it claims to", () => {
  expect(draw({ box: "/session-id", alert: null, answer: null, enterRuns: true, history: "", submitted: [] })).toContain(MENU_ROW);
  expect(readKiroCommandComposer(draw({ box: "/title worker", alert: null, answer: null, enterRuns: true, history: sid("tui-ready"), submitted: [] })))
    .toBe("/title worker");
});
