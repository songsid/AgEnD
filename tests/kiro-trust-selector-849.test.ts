import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbiddenProcess = vi.hoisted(() => vi.fn((): never => { throw new Error("No processes in trust selector sandbox"); }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: forbiddenProcess, execFile: forbiddenProcess, execSync: forbiddenProcess, execFileSync: forbiddenProcess,
  spawn: forbiddenProcess, spawnSync: forbiddenProcess, fork: forbiddenProcess,
}));
import { KiroBackend } from "../src/backend/kiro.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { Daemon } from "../src/daemon.js";
import type { RuntimeDialog } from "../src/backend/types.js";

// Native #1405 capture. The following variants change only the cursor rows,
// or deliberately corrupt the captured layout; they are not new CLI evidence.
const NATIVE = readFileSync(new URL("./fixtures/kiro-steer-1405/2.27.1-tui-trust-all-tools.pane.txt", import.meta.url), "utf8");
const ACCEPT = NATIVE.replace("❯ No, exit", "  No, exit").replace(/^([ ]*)Yes, I accept$/m, "$1❯ Yes, I accept");
const PERSIST = NATIVE.replace("❯ No, exit", "  No, exit").replace(/^([ ]*)Yes, and don't ask again$/m, "$1❯ Yes, and don't ask again");
const TUI_IDLE = readFileSync(new URL("./fixtures/kiro-steer-1405/2.27.1-tui-idle.pane.txt", import.meta.url), "utf8");
const TUI_BUSY = readFileSync(new URL("./fixtures/kiro-steer-1405/2.28.0-tui-busy-steer.pane.txt", import.meta.url), "utf8");
const TUI_COMPOSER = TUI_IDLE.split("\n").find(row => row.startsWith("›"))!;
const READY = "All tools are now trusted (!).\n2% !> What would you like to do?";
const dirs: string[] = [];
const daemons: any[] = [];
const backend = (authorized = true) => Object.assign(Object.create(KiroBackend.prototype), {
  activeUi: "tui", activeTrustAll: authorized,
}) as KiroBackend;
const matches = (dialogs: RuntimeDialog[], pane: string) => dialogs.filter(d => d.pattern.test(pane) && (!d.isActive || d.isActive(pane)));
const tables = (authorized = true) => [backend(authorized).getStartupDialogs(), backend(authorized).getRuntimeDialogs()];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.freezeRuntimeMonitors();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(forbiddenProcess).not.toHaveBeenCalled();
});

function makeDaemon(initial = NATIVE, onKey: (key: string, pane: string) => string = (_key, pane) => pane, authorized = true) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-trust-849-"));
  dirs.push(instanceDir);
  writeFileSync(join(instanceDir, "window-id"), "@fixture");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("trust-849", {
    working_directory: instanceDir, backend: "kiro-cli", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
  } as any, instanceDir, false, backend(authorized), undefined, { child: () => logger } as any) as any;
  daemons.push(daemon);
  daemon.spawnGeneration = 1;
  const screen = { pane: initial };
  const keys: string[] = [];
  const captures: string[] = [];
  const tmux = {
    capturePane: vi.fn(async () => { captures.push(screen.pane); return screen.pane; }),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); screen.pane = onKey(key, screen.pane); return true; }),
    sendKeys: vi.fn(async () => { throw new Error("Unexpected text key"); }),
    pasteText: vi.fn(async () => { throw new Error("Unexpected paste"); }),
  };
  daemon.tmux = tmux;
  daemon.controlClient = { isIdle: () => true, waitForIdle: async () => {} };
  return { daemon, tmux, screen, keys, captures, logger };
}

async function startup(daemon: any, ms = 2_000) {
  const run = daemon.dismissDialogsUntilReady(ms, 50);
  await vi.advanceTimersByTimeAsync(ms + 500);
  return await run;
}

describe("native TUI trust selector shared by startup and runtime", () => {
  it.each([["decline", NATIVE, "Down"], ["per-session accept", ACCEPT, "Enter"]])("%s permits one safe key, then hold", (_name, pane, key) => {
    for (const dialogs of tables()) {
      const found = matches(dialogs, pane);
      expect(found.map(d => d.keys)).toEqual([[key], []]);
      expect(found[0].inputBlocked).toBe(true);
      expect(found[0].blocksDelivery).toBe(true);
      expect(found[0].verifyAfterKeys).toBe(true);
      expect(found[0].autoResolutionKey).toBeTruthy();
      expect(found[0].oncePerLaunch).toBe(true);
      expect(found[1].holdOnly).toBe(true);
    }
  });

  it.each([
    ["persistent accept", PERSIST],
    ["unknown cursor", NATIVE.replace("❯ No, exit", "● No, exit")],
    ["missing cursor", NATIVE.replace("❯ No, exit", "  No, exit")],
    ["duplicate cursor", NATIVE.replace(/^([ ]*)Yes, I accept$/m, "$1❯ Yes, I accept")],
    ["changed option", NATIVE.replace("Yes, I accept", "Yes, accept permanently")],
    ["missing option", NATIVE.replace(/^ *Yes, and don't ask again\n/m, "")],
    ["changed footer", NATIVE.replace("↵ to select", "type a password")],
    ["new trailing output", `${NATIVE.trimEnd()}\nUnrecognised prompt below`],
    ["unverified workspace trust", "Do you trust the files?\n❯ No, exit\n  Yes, I accept\n"],
    ["workspace question with copied native choices", NATIVE.replace("Warning: Kiro is running in trust all tools mode", "Do you trust the files?")],
  ])("%s is held without any key", (_name, pane) => {
    for (const dialogs of tables()) {
      const found = matches(dialogs, pane);
      expect(found.map(d => ({ keys: d.keys, hold: d.holdOnly }))).toEqual([{ keys: [], hold: true }]);
      expect(found[0].inputBlocked).toBe(true);
      expect(found[0].blocksDelivery).toBe(true);
    }
  });

  it("does not auto-accept if this launch did not request trust-all-tools", () => {
    for (const dialogs of tables(false)) expect(matches(dialogs, ACCEPT).map(d => d.keys)).toEqual([[]]);
  });

  it.each([
    ["quoted with current composer", `${NATIVE.trimEnd()}\n${READY}`],
    ["composer before copied options", NATIVE.replace("❯ No, exit", "2% !> prior reply\n❯ No, exit")],
    ["bare decline in prose", "Earlier we selected ❯ No, exit"],
    ["ordinary model picker", `${NATIVE.trimEnd()}\nSelect model (type to search):\n> * auto`],
  ])("%s cannot receive a trust key", (_name, pane) => {
    for (const dialogs of tables()) expect(matches(dialogs, pane).filter(d => d.description.includes("trust confirmation"))).toEqual([]);
  });
});

describe("true daemon startup with scripted tmux only", () => {
  it("captures the accepted cursor between Down and Enter, then becomes ready", async () => {
    const h = makeDaemon(NATIVE, (key, pane) => key === "Down" && pane === NATIVE ? ACCEPT : key === "Enter" && pane === ACCEPT ? READY : pane);
    expect(await startup(h.daemon)).toBe(true);
    expect(h.keys).toEqual(["Down", "Enter"]);
    const keys = h.tmux.sendSpecialKey.mock.invocationCallOrder;
    expect(h.tmux.capturePane.mock.invocationCallOrder.some((order: number, i: number) => order > keys[0] && order < keys[1] && h.captures[i] === ACCEPT)).toBe(true);
    expect((await h.daemon.probeBlockingDialog()).state).toBe("clear");
  });

  it("a swallowed Down is never followed by Enter or a second Down", async () => {
    const h = makeDaemon();
    expect(await startup(h.daemon)).toBe(true); // alive, not deliverable
    expect(h.keys).toEqual(["Down"]);
    const probe = await h.daemon.probeBlockingDialog();
    expect(probe.state).toBe("dialog");
    expect(probe.dialog.holdOnly).toBe(true);
    expect(await h.daemon.paneReadinessForDelivery("@fixture")).toBe("dialog");
  });

  it.each([["persistent", PERSIST], ["unknown", NATIVE.replace("❯ No, exit", "● No, exit")]])("%s remains blocked with no key", async (_name, pane) => {
    const h = makeDaemon(pane);
    expect(await startup(h.daemon)).toBe(true);
    expect(h.keys).toEqual([]);
    expect((await h.daemon.probeBlockingDialog()).state).toBe("dialog");
  });

  it("re-reads under the pane lock and does not navigate a changed screen", async () => {
    const h = makeDaemon();
    h.tmux.capturePane.mockResolvedValueOnce(NATIVE).mockResolvedValue(PERSIST);
    await startup(h.daemon);
    expect(h.keys).toEqual([]);
  });

  it("checks the screen again after Down, refusing the persistent choice", async () => {
    const h = makeDaemon(NATIVE, key => key === "Down" ? PERSIST : NATIVE);
    await startup(h.daemon);
    expect(h.keys).toEqual(["Down"]);
    expect((await h.daemon.probeBlockingDialog()).dialog.holdOnly).toBe(true);
  });

  it("re-checks admission after Down and never confirms revoked consent", async () => {
    let current = true;
    const h = makeDaemon(NATIVE, key => { if (key === "Down") current = false; return ACCEPT; });
    h.daemon.startupAdmission = () => { if (!current) throw new Error("consent revoked"); };
    const outcome = h.daemon.dismissDialogsUntilReady(2_000, 50).then(
      () => "unexpected success", (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await outcome).toBe("consent revoked");
    expect(h.keys).toEqual(["Down"]);
  });

  it("Enter which did not clear the dialog is not repeated", async () => {
    const h = makeDaemon(ACCEPT);
    await startup(h.daemon);
    expect(h.keys).toEqual(["Enter"]);
    expect((await h.daemon.probeBlockingDialog()).dialog.holdOnly).toBe(true);
  });

  it.each(["spawn", "pause", "tmux"])("held fresh capture cannot write after %s changes owner", async which => {
    const h = makeDaemon();
    let release!: (pane: string) => void;
    h.tmux.capturePane.mockResolvedValueOnce(NATIVE).mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const run = h.daemon.dismissDialogsUntilReady(2_000, 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeTypeOf("function");
    if (which === "spawn") h.daemon.spawnGeneration++;
    if (which === "pause") h.daemon.freezeRuntimeMonitors();
    if (which === "tmux") h.daemon.tmux = { ...h.tmux };
    release(NATIVE);
    await vi.advanceTimersByTimeAsync(2_500);
    await run;
    expect(h.keys).toEqual([]);
  });
});

describe("true daemon runtime scanner and delivery hold", () => {
  it("one poll sends Down, a later accepted cursor gets one Enter", async () => {
    const h = makeDaemon(NATIVE, (key, pane) => key === "Down" && pane === NATIVE ? ACCEPT : key === "Enter" && pane === ACCEPT ? READY : pane);
    h.daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_400);
    expect(h.keys).toEqual(["Down"]);
    expect(await h.daemon.paneReadinessForDelivery("@fixture")).toBe("dialog");
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h.keys).toEqual(["Down", "Enter"]);
    expect(h.daemon.isInputBlocked()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.keys).toEqual(["Down", "Enter"]);
  });

  it("a swallowed Down holds input and escalates once without repeated keys", async () => {
    const h = makeDaemon();
    const parked: any[] = [];
    h.daemon.on("dialog_parked", (event: unknown) => parked.push(event));
    h.daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(66_000);
    expect(h.keys).toEqual(["Down"]);
    expect(h.daemon.isInputBlocked()).toBe(true);
    expect((await h.daemon.probeBlockingDialog()).dialog.holdOnly).toBe(true);
    expect(parked).toHaveLength(1);
    expect(JSON.stringify(parked)).not.toContain("In this mode, Kiro will execute");
  });

  it("a persistent choice appearing between capture and lock never gets Enter", async () => {
    const h = makeDaemon(ACCEPT);
    h.tmux.capturePane.mockResolvedValueOnce(ACCEPT).mockResolvedValue(PERSIST);
    h.daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(h.keys).toEqual([]);
    expect(h.daemon.isInputBlocked()).toBe(true);
  });

  it.each(["spawn", "pause"])("held lock capture cannot write after %s", async which => {
    const h = makeDaemon();
    let release!: (pane: string) => void;
    h.tmux.capturePane.mockResolvedValueOnce(NATIVE).mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    h.daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toBeTypeOf("function");
    if (which === "spawn") h.daemon.spawnGeneration++;
    else h.daemon.freezeRuntimeMonitors();
    release(NATIVE);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.keys).toEqual([]);
  });
});

describe("R2 trust launch claims and native composer ownership", () => {
  it.each([["idle", TUI_IDLE], ["busy", TUI_BUSY]])("archived trust above the native %s composer is history", async (_name, current) => {
    const pane = `${NATIVE.trimEnd()}\n${current}`;
    for (const dialogs of tables()) expect(matches(dialogs, pane).filter(d => d.description.includes("trust confirmation"))).toEqual([]);
    const h = makeDaemon(pane);
    expect((await h.daemon.probeBlockingDialog()).state).toBe("clear");
    if (_name === "idle") expect(await h.daemon.paneReadinessForDelivery("@fixture")).toBe("ready");
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(10_500);
    expect(h.keys).toEqual([]);
  });
  it.each([["No", NATIVE], ["Accept", ACCEPT]])("native composer before copied %s options cannot receive keys", (_name, frame) => {
    const pane = frame.replace(" ❯", `\n${TUI_COMPOSER}\n ❯`);
    for (const dialogs of tables()) expect(matches(dialogs, pane).filter(d => d.description.includes("trust confirmation"))).toEqual([]);
  });
  it("each runtime phase stays claimed when Enter repaints No", async () => {
    const h = makeDaemon(NATIVE, key => key === "Down" ? ACCEPT : NATIVE);
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(35_500);
    expect(h.keys).toEqual(["Down", "Enter"]);
    expect((await h.daemon.probeBlockingDialog()).dialog.holdOnly).toBe(true);
  });
  it("startup claims survive handoff to runtime and a ready repaint", async () => {
    const h = makeDaemon(NATIVE, key => key === "Down" ? ACCEPT : READY);
    await startup(h.daemon);
    expect(h.keys).toEqual(["Down", "Enter"]);
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5_500);
    h.screen.pane = NATIVE; await vi.advanceTimersByTimeAsync(25_000);
    expect(h.keys).toEqual(["Down", "Enter"]);
    expect((await h.daemon.probeBlockingDialog()).dialog.holdOnly).toBe(true);
  });
  it("uncertain send ACK never releases a claimed launch phase", async () => {
    const h = makeDaemon();
    h.tmux.sendSpecialKey.mockImplementation(async key => { h.keys.push(key); return false; });
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(25_500);
    expect(h.keys).toEqual(["Down"]);
  });
  it.each(["stop", "recover"])("held runtime Accept capture cannot send after %s", async which => {
    const h = makeDaemon(ACCEPT);
    let release!: (pane: string) => void;
    h.tmux.capturePane.mockResolvedValueOnce(ACCEPT).mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toBeTypeOf("function");
    let replacementSend: ReturnType<typeof vi.spyOn> | undefined;
    if (which === "stop") h.daemon.fenceDeliveryWritesForStop();
    else {
      Object.assign(h.tmux, { getWindowId: () => "@fixture" });
      Object.assign(h.daemon.controlClient, { registerWindow: vi.fn(async () => {}), unregisterWindow: vi.fn(), on: vi.fn(), off: vi.fn() });
      vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([{ id: "@replacement", name: "trust-849", index: 0 }] as any);
      expect(await h.daemon.recoverWindow()).toBe("@replacement");
      expect(h.daemon.tmux).not.toBe(h.tmux);
      replacementSend = vi.spyOn(h.daemon.tmux, "sendSpecialKey").mockResolvedValue(true);
    }
    release(ACCEPT); await vi.advanceTimersByTimeAsync(400);
    expect(h.keys).toEqual([]);
    if (replacementSend) expect(replacementSend).not.toHaveBeenCalled();
  });
  it("a genuinely new spawn may claim the phases again", async () => {
    const h = makeDaemon(NATIVE, key => key === "Down" ? ACCEPT : READY);
    await startup(h.daemon);
    h.daemon.beginSpawn(); h.daemon.endSpawn(); h.screen.pane = NATIVE;
    await startup(h.daemon);
    expect(h.keys).toEqual(["Down", "Enter", "Down", "Enter"]);
  });
});

describe("R2 final synchronous admission and attempt controls", () => {
  it("stop at the last callback before the key refuses it synchronously", async () => {
    const h = makeDaemon(ACCEPT);
    h.logger.info.mockImplementation(() => h.daemon.fenceDeliveryWritesForStop());
    h.daemon.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5_500);
    expect(h.keys).toEqual([]);
  });
  it("a new launch attempt in the same spawn may claim the phases again", async () => {
    const h = makeDaemon(NATIVE, key => key === "Down" ? ACCEPT : READY);
    await startup(h.daemon);
    h.daemon.launchAttempt++; h.screen.pane = NATIVE;
    await startup(h.daemon);
    expect(h.keys).toEqual(["Down", "Enter", "Down", "Enter"]);
  });
});
