/**
 * Board 907c7899: a /compact in a kiro instance's own pane, followed to its end (src/kiro-compact-pane.ts), against the
 * real kiro-cli 2.30.0 captures in tests/fixtures/kiro-2.30.0-compact-pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroCompactPaneFollower } from "../src/kiro-compact-pane.js";
import { COMPACT_WATCH_TIMEOUT_MS, CompactWatch, launchIdentity } from "../src/compact-watch.js";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import { FleetManager } from "../src/fleet-manager.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pane = (name: string) => readFileSync(new URL(`./fixtures/kiro-2.30.0-compact-pane/${name}.pane.txt`, import.meta.url), "utf8");
const follow = (ui: "legacy" | "tui", before: string, ...looks: string[]) => {
  const f = new KiroCompactPaneFollower(ui, pane(before));
  return looks.map(l => f.look(pane(l)));
};

describe("classic (--legacy-ui, V1)", () => {
  it("running, then kiro's own line: done", () => {
    expect(follow("legacy", "classic-idle", "classic-idle", "classic-compacting", "classic-compacted")).toEqual([null, null, "done"]);
  });

  it("an empty conversation: \"too short\", nothing compacted", () => {
    // Its own launch: the pane before is the start screen, with no /compact on it.
    const start = pane("classic-too-short").split("\n").slice(0, 36).join("\n");
    const f = new KiroCompactPaneFollower("legacy", start);
    expect(f.look(pane("classic-too-short"))).toBe("not_compacted");
    // A look between kiro's answer and the prompt coming back: the answer alone says so.
    const answerOnly = pane("classic-too-short").split("\n");
    const g = new KiroCompactPaneFollower("legacy", start);
    expect(g.look(answerOnly.slice(0, answerOnly.findIndex(l => l.includes("too short")) + 1).join("\n"))).toBe("not_compacted");
  });

  it("stopped with Ctrl-C: the prompt comes back with nothing said, nothing compacted", () => {
    expect(follow("legacy", "classic-compacted", "classic-recompacting", "classic-ctrlc-stopped")).toEqual([null, "not_compacted"]);
  });

  it("an earlier /compact's ending on the pane is not this one's", () => {
    // Before the second /compact the pane already says the first one replaced the history.
    expect(follow("legacy", "classic-compacted", "classic-compacted")).toEqual([null]);
    expect(follow("legacy", "classic-compacted", "classic-recompacting")).toEqual([null]);
  });

  it("the command not on the pane yet: unknown", () => {
    expect(follow("legacy", "classic-idle", "classic-idle")).toEqual([null]);
  });
});

describe("TUI (--tui, V2)", () => {
  it("the running line comes and goes: done", () => {
    expect(follow("tui", "tui-idle", "tui-idle", "tui-compacting", "tui-compacted")).toEqual([null, null, "done"]);
  });

  it("Esc or Ctrl-C does not stop it: it still ends as done", () => {
    expect(follow("tui", "tui-compacted", "tui-recompacting", "tui-ctrlc-still-compacted")).toEqual([null, "done"]);
    expect(follow("tui", "tui-ctrlc-still-compacted", "tui-esc-compacting", "tui-esc-still-compacted")).toEqual([null, "done"]);
  });

  it("an empty conversation: \"too short\" while it shows, nothing compacted", () => {
    expect(follow("tui", "tui-too-short-gone", "tui-too-short")).toEqual(["not_compacted"]);
  });

  it("never seen running: unknown, not done (a look that came too late can't tell)", () => {
    expect(follow("tui", "tui-idle", "tui-compacted")).toEqual([null]);
    expect(follow("tui", "tui-too-short", "tui-too-short-gone")).toEqual([null]);
  });

  it("a running line already on the pane before the write is not this one's", () => {
    expect(follow("tui", "tui-compacting", "tui-compacting", "tui-compacted")).toEqual([null, null]);
  });

  it("review P2-1: the running line wrapped by a narrower pane is not an ending; the real ending still is", () => {
    const f = new KiroCompactPaneFollower("tui", pane("tui-idle"));
    expect(f.look(pane("tui-compacting"))).toBeNull();
    const wrapped = pane("tui-compacting").replace("• Compacting conversation...", "• Compacting\nconversation...");
    expect(f.look(wrapped)).toBeNull();
    expect(f.look(pane("tui-compacting").replace("• Compacting conversation...", "• Compacting conversa\ntion..."))).toBeNull();
    expect(f.look(pane("tui-compacted"))).toBe("done");
  });

  it("review r2 P2-1: an older piece leaving the bounded look cannot stand in for this one's: any piece in view is unknown", () => {
    // Prism's replay: the old piece at the top of the history, gone from the next look; this one still running, wrapped.
    const f = new KiroCompactPaneFollower("tui", `conversation...\n${pane("tui-idle")}`);
    expect(f.look(pane("tui-compacting"))).toBeNull();
    expect(f.look(pane("tui-compacting").replace("• Compacting conversation...", "• Compacting conversa\ntion..."))).toBeNull();
    expect(f.look(pane("tui-compacted"))).toBe("done");                        // control: this one's real ending
    // An old piece still in view is not told apart from this one's: unknown (the deadline ends it), never done.
    const g = new KiroCompactPaneFollower("tui", `${pane("tui-idle")}\nconversation...`);
    expect(g.look(`${pane("tui-compacting")}\nconversation...`)).toBeNull();
    expect(g.look(`${pane("tui-compacted")}\nconversation...`)).toBeNull();
  });

  it("review P2-1: without kiro's idle composer in view (a dialog over it, another layout): unknown, not done", () => {
    const f = new KiroCompactPaneFollower("tui", pane("tui-idle"));
    expect(f.look(pane("tui-compacting"))).toBeNull();
    const covered = pane("tui-compacted").split("\n").filter(l => !l.includes("ask a question or describe a task")).join("\n");
    expect(f.look(covered)).toBeNull();
    expect(f.look(pane("tui-compacted"))).toBe("done");
  });

  it("an earlier \"too short\" still showing when this one is written is not this one's", () => {
    expect(follow("tui", "tui-too-short", "tui-too-short")).toEqual([null]);
  });
});

describe("one layout's lines are not read as the other's", () => {
  it("classic lines on a TUI follower, and TUI lines on a classic one, stay unknown", () => {
    expect(follow("tui", "classic-idle", "classic-compacting", "classic-compacted")).toEqual([null, null]);
    expect(follow("legacy", "tui-idle", "tui-compacting", "tui-compacted")).toEqual([null, null]);
  });
});

describe("the fleet's watch for a kiro /compact (CompactWatch)", () => {
  const OWNER = launchIdentity({ bootId: "b", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 });
  function rig(opts: { pane?: boolean } = {}) {
    let clock = 1000;
    const daemon = { current: OWNER as string | null };
    const changed = vi.fn();
    const watch = new CompactWatch({
      source: () => ({ path: null, format: null }), owner: () => daemon.current, paneFollow: () => opts.pane ?? true, changed,
      now: () => clock, setInterval: () => 1, clearInterval: () => {},
    });
    const start = () => { const id = watch.begin("k")!; watch.pasted("k", id, true, { owner: daemon.current, checkpoint: null, pane: true }); return id; };
    return { watch, daemon, changed, start, tick: (ms: number) => { clock += ms; } };
  }

  it("followed only when the daemon reads its pane; no transcript and no pane: not followed", () => {
    expect(rig({ pane: false }).watch.begin("k")).toBeNull();
    expect(rig().watch.begin("k")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("running until the daemon says how it ended: done, or not compacted — said once", () => {
    for (const outcome of ["done", "not_compacted"] as const) {
      const r = rig(); const id = r.start();
      expect(r.watch.view("k")).toEqual({ id, state: "running" });
      r.watch.paneResult("k", id, OWNER, outcome);
      expect(r.watch.view("k")).toEqual({ id, state: outcome });
      r.watch.paneResult("k", id, OWNER, outcome === "done" ? "not_compacted" : "done");
      expect(r.watch.view("k")).toEqual({ id, state: outcome });
      expect(r.changed).toHaveBeenCalledTimes(1);
    }
  });

  it("a word about another watch, before the write, or an unknown outcome changes nothing", () => {
    const r = rig(); const id = r.watch.begin("k")!;
    r.watch.paneResult("k", id, OWNER, "done");                               // not written yet
    expect(r.watch.view("k")!.state).toBe("running");
    r.watch.pasted("k", id, true, { owner: OWNER, checkpoint: null, pane: true });
    r.watch.paneResult("k", "f".repeat(16), OWNER, "done");
    r.watch.paneResult("k", id, OWNER, "compacted");
    expect(r.watch.view("k")!.state).toBe("running");
  });

  it("written without the daemon reading its pane, never written, or under another launch: lost", () => {
    const a = rig(); const ia = a.watch.begin("k")!; a.watch.pasted("k", ia, true, { owner: OWNER, checkpoint: null });
    expect(a.watch.view("k")!.state).toBe("lost");
    const b = rig(); const ib = b.watch.begin("k")!; b.watch.pasted("k", ib, false);
    expect(b.watch.view("k")!.state).toBe("lost");
    const c = rig(); const ic = c.watch.begin("k")!; c.watch.pasted("k", ic, true, { owner: "another", checkpoint: null, pane: true });
    expect(c.watch.view("k")!.state).toBe("lost");
  });

  it("the launch changing afterwards: lost at the next look, and a result from the old launch is not taken", async () => {
    const r = rig(); const id = r.start();
    r.daemon.current = "respawned";
    await r.watch.poll("k", id);
    expect(r.watch.view("k")!.state).toBe("lost");
    const s = rig(); const is = s.start();
    s.daemon.current = "respawned";
    s.watch.paneResult("k", is, OWNER, "done");
    expect(s.watch.view("k")!.state).toBe("lost");
  });

  it("review P3-1: a result at or after the deadline is too late, even before the timer has looked", () => {
    for (const [late, want] of [[COMPACT_WATCH_TIMEOUT_MS - 1, "done"], [COMPACT_WATCH_TIMEOUT_MS, "timeout"], [COMPACT_WATCH_TIMEOUT_MS + 1, "timeout"]] as const) {
      const r = rig(); const id = r.start();
      r.tick(late);
      r.watch.paneResult("k", id, OWNER, "done");
      expect(r.watch.view("k")!.state, String(late)).toBe(want);
    }
  });

  it("no word within the deadline: timed out", async () => {
    const r = rig(); const id = r.start();
    r.tick(COMPACT_WATCH_TIMEOUT_MS);
    await r.watch.poll("k", id);
    expect(r.watch.view("k")!.state).toBe("timeout");
  });
});

describe("the daemon reads its own pane just before this attempt's paste (the real deliverMessage)", () => {
  const ID = "0123456789abcdef";
  const OLD_ENDING = "1% > /compact\nThe conversation history has been replaced with this summary.\n1% >";
  /** A real daemon on an inert pane: handleRawPasteIpcMessage → queueRawPaste → deliverMessage → writeMessageToPane. */
  function realDaemon(ui: "legacy" | "tui" | null, hooks: { capture?: () => void; paste?: () => void; enter?: () => void } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-compact-")); dirs.push(dir);
    mkdirSync(join(dir, "inst"));
    writeFileSync(join(dir, "inst", "window-id"), "@1");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
    const backend: any = { getReadyPattern: () => /READY/, getErrorPatterns: () => [], getRuntimeDialogs: () => [] };
    if (ui) backend.compactPaneUi = () => ui;
    const d: any = new Daemon("k", { working_directory: dir, log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 } } as any,
      join(dir, "inst"), false, backend, undefined, logger);
    d.logTranscriptPath = () => null;
    const broadcast: any[] = [];
    d.ipcServer = { broadcast: (m: unknown) => broadcast.push(m), send: () => {} };
    d.wake = async () => {};
    const r = { d, broadcast, order: [] as string[], screen: "" };
    d.tmux = {
      getWindowId: () => "@1", isWindowAlive: async () => true,
      capturePane: async () => { hooks.capture?.(); return "READY"; },
      capturePaneWithHistory: async (lines: number) => { r.order.push(`look:${lines}`); return r.screen; },
      sendSpecialKey: async (k: string) => { if (k === "Enter") hooks.enter?.(); return true; },
      sendKeys: async () => true, pasteText: async () => true,
      pasteBuffer: async (text: string) => { r.order.push(`paste:${text}`); hooks.paste?.(); return true; },
    };
    return r;
  }
  const written = (r: { broadcast: any[] }) => vi.waitFor(() => expect(r.broadcast.some(m => m.type === "raw_paste_written")).toBe(true), { timeout: 15_000 });

  it("classic: looked at just before the paste; one result when kiro's line for THIS /compact shows", async () => {
    const r: any = realDaemon("legacy", { enter: () => { r.screen = pane("classic-compacting"); } });
    r.screen = pane("classic-idle");
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
      await written(r);
      const owner = launchIdentity(r.d.interactionOwner());
      expect(r.broadcast[0]).toEqual({ type: "raw_paste_written", id: ID, outcome: "written", owner, checkpoint: null, pane: true });
      expect(r.order.slice(0, 2)).toEqual(["look:1000", "paste:/compact"]);
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(r.broadcast).toHaveLength(1);                                     // still compacting
      r.screen = pane("classic-compacted");
      await vi.waitFor(() => expect(r.broadcast[1]).toEqual({ type: "compact_pane_result", id: ID, owner, outcome: "done" }), { timeout: 5_000 });
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("review P2-2: an older /compact that ends while this one waits for the pane is not this one's ending", async () => {
    let pasted = false;
    const r: any = realDaemon("legacy", {
      // While this write waits (readiness, last capture), an earlier /compact's echo and ending land on the pane.
      capture: () => { if (!pasted) r.screen = `${pane("classic-idle")}\n${OLD_ENDING}`; },
      paste: () => { pasted = true; },
    });
    r.screen = pane("classic-idle");
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
      await written(r);
      await new Promise(resolve => setTimeout(resolve, 2300));
      expect(r.broadcast).toHaveLength(1);                                     // this one has not shown yet: unknown
      r.screen = `${pane("classic-idle")}\n${OLD_ENDING}\n${OLD_ENDING}`;    // control: this one's own ending
      await vi.waitFor(() => expect(r.broadcast[1]).toMatchObject({ type: "compact_pane_result", id: ID, outcome: "done" }), { timeout: 5_000 });
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("review P2-2: the look is fenced too — another launch during it: nothing is written", async () => {
    const r: any = realDaemon("legacy");
    r.screen = pane("classic-idle");
    const look = r.d.tmux.capturePaneWithHistory;
    r.d.tmux.capturePaneWithHistory = async (lines: number) => { r.d.spawnGeneration += 1; return look(lines); };
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
      await written(r);
      expect(r.broadcast[0]).toMatchObject({ type: "raw_paste_written", outcome: "not_written" });
      expect(r.order.filter((o: string) => o.startsWith("paste"))).toEqual([]);
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("review P3-1: the daemon's follow says nothing once its deadline has passed (monotonic, asked after each await)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const r: any = realDaemon("legacy");
    r.screen = pane("classic-compacting");
    const owner = launchIdentity(r.d.interactionOwner());
    let late = false;
    const look = r.d.tmux.capturePaneWithHistory;
    // The look that would see the ending returns only after the deadline.
    r.d.tmux.capturePaneWithHistory = async (lines: number) => { if (late) vi.advanceTimersByTime(COMPACT_WATCH_TIMEOUT_MS); return look(lines); };
    try {
      const follow = r.d.followCompactPane(ID, owner, new KiroCompactPaneFollower("legacy", pane("classic-idle")));
      await vi.advanceTimersByTimeAsync(3000);
      r.screen = pane("classic-compacted"); late = true;
      await vi.advanceTimersByTimeAsync(1000);
      await follow;
      expect(r.broadcast).toEqual([]);
    } finally { r.d.freezeRuntimeMonitors(); }
  });

  it("TUI: \"too short\" is said as not compacted", async () => {
    const r: any = realDaemon("tui", { enter: () => { r.screen = pane("tui-too-short"); } });
    r.screen = pane("tui-too-short-gone");
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
      await written(r);
      await vi.waitFor(() => expect(r.broadcast[1]).toMatchObject({ type: "compact_pane_result", id: ID, outcome: "not_compacted" }), { timeout: 5_000 });
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("another launch after the write: nothing more is said (the fleet calls it lost)", async () => {
    const r: any = realDaemon("legacy", { enter: () => { r.screen = pane("classic-compacted"); r.d.spawnGeneration += 1; } });
    r.screen = pane("classic-idle");
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
      await written(r);
      await new Promise(resolve => setTimeout(resolve, 2300));
      expect(r.broadcast).toHaveLength(1);
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("a backend that does not read its pane, or a pane that can't be read: no look, no pane follow", async () => {
    const a: any = realDaemon(null);
    const b: any = realDaemon("legacy");
    b.d.tmux.capturePaneWithHistory = async () => { throw new Error("no pane"); };
    try {
      for (const r of [a, b]) {
        r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
        await written(r);
        expect(r.broadcast[0]).not.toHaveProperty("pane");
      }
      expect(a.order.filter((o: string) => o.startsWith("look"))).toEqual([]);
    } finally { a.d.freezeRuntimeMonitors(); b.d.freezeRuntimeMonitors(); }
  }, 30_000);

  it("a paste with no watch id (not a web /compact): the pane is not looked at", async () => {
    const r: any = realDaemon("legacy");
    try {
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact" });
      await vi.waitFor(() => expect(r.order).toContain("paste:/compact"), { timeout: 15_000 });
      expect(r.order.filter((o: string) => o.startsWith("look"))).toEqual([]);
    } finally { r.d.freezeRuntimeMonitors(); }
  }, 30_000);
});

describe("kiro's layouts", () => {
  it("classic and TUI V2 are read from the pane; V3 is not", () => {
    const b: any = new KiroBackend("/tmp/test", TEST_KIRO_COMPAT);
    for (const [ui, want] of [["legacy", "legacy"], ["tui", "tui"], ["v3", null]] as const) { b.activeUi = ui; expect(b.compactPaneUi()).toBe(want); }
  });
});

describe("the fleet's wiring", () => {
  it("a kiro daemon that reads its pane gets a watch; the daemon's two words reach it over the real IPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-fleet-")); dirs.push(dir);
    const fm: any = new FleetManager(dir);
    fm.logSource = () => ({ path: null, format: null });
    fm.lifecycle.daemons.set("k", { compactPaneUi: () => "legacy", getInteractionSnapshot: () => ({ owner: { bootId: "b", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 } }) });
    fm.lifecycle.daemons.set("v3", { compactPaneUi: () => null, getInteractionSnapshot: () => ({ owner: null }) });
    expect(fm.compactWatch.begin("v3")).toBeNull();
    expect(fm.compactWatch.begin("k")).toMatch(/^[0-9a-f]{16}$/);
    fm.compactWatch.stopAll();

    const instanceDir = fm.getInstanceDir("k");
    mkdirSync(instanceDir, { recursive: true });
    const server = new IpcServer(join(instanceDir, "channel.sock"));
    await server.listen();
    try {
      fm.compactWatchService = { pasted: vi.fn(), paneResult: vi.fn(), forget: vi.fn(), stopAll: vi.fn(), view: () => null };
      await fm.connectIpcToInstance("k");
      await vi.waitFor(() => expect((server as any).clients.size).toBe(1));
      server.broadcast({ type: "raw_paste_written", id: "0123456789abcdef", outcome: "written", owner: "o", checkpoint: null, pane: true });
      server.broadcast({ type: "compact_pane_result", id: "0123456789abcdef", owner: "o", outcome: "not_compacted" });
      await vi.waitFor(() => expect(fm.compactWatchService.paneResult).toHaveBeenCalledWith("k", "0123456789abcdef", "o", "not_compacted"));
      expect(fm.compactWatchService.pasted).toHaveBeenCalledWith("k", "0123456789abcdef", true, { owner: "o", checkpoint: null, pane: true });
    } finally {
      await fm.instanceIpcClients.get("k")?.close();
      await server.close();
    }
  });
});
