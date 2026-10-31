/**
 * Codex's folder-trust prompt in an AgEnD session (#2893, then #2895: the user's decision hmsg-53600a2c): answered Trust —
 * logged with what it trusted — whenever the cursor is on "Trust and continue"; held, with the reason, only for a layout
 * or row AgEnD never answers, or a press that did not take. Log only; per-action approvals are separate dialogs.
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

const dirs: string[] = [];
const priorCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  vi.useRealTimers();
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-trust-why-"));
  dirs.push(dir);
  const shared = join(dir, "shared-codex"), instance = join(dir, "instance"), cwd = join(dir, "folder");
  for (const d of [shared, instance, cwd]) mkdirSync(d);
  process.env.CODEX_HOME = shared;
  const backend = new CodexBackend(instance);
  backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} } as any);
  return { dir, instance, cwd, backend };
}
/** Codex's "Folder access" decision block (0.156+ layout), as the trust-modal tests draw it; `root`: the subdirectory note. */
function trustPane(folder: string, cursor: "trust" | "quit" = "trust", root?: string) {
  return ["› Ask Codex to do anything", "", "  Folder access", `  ${folder}`, "",
    ...(root ? ["  Note: You’re in a subdirectory of a Git project. Trusting will apply to the", "  repository root:", `  ${root}`, ""] : []),
    "  Trust this folder? Codex can read, edit, and run files here, subject to your",
    "  permission settings. Folder settings can run code automatically, even",
    "  without a model request. Continue only if you trust these files. Your trust",
    "  decision will be saved.", "",
    `${cursor === "trust" ? "›" : " "} 1. Trust and continue`, `${cursor === "quit" ? "›" : " "} 2. Quit`, "",
    "  enter continue · esc quit", ""].join("\n");
}
const hold = (backend: CodexBackend) => backend.getRuntimeDialogs().find(d => d.description === "Codex folder trust needs human confirmation")!;

const auto = (backend: CodexBackend) => backend.getRuntimeDialogs().find(d => d.description === "Codex folder trust — trusting the agent's own folder")!;
const active = (d: { isActive?: (p: string) => boolean }, pane: string) => d.isActive!(pane);
function daemonFor(cwd: string, instance: string, backend: CodexBackend) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("test", {
    working_directory: cwd, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
  } as any, instance, false, backend, undefined, { child: () => logger } as any) as any;
  return { daemon, logger };
}

describe("codex folder trust in an AgEnD session: answered Trust, or held with the reason", () => {
  it("the cursor on Trust is answered whatever preTrust covered; the answer says what it trusted", () => {
    const { cwd, backend } = fixture();
    expect(active(auto(backend), trustPane(cwd))).toBe(true);                         // no preTrust at all
    expect(auto(backend).keys).toEqual(["Enter"]);
    expect(auto(backend).answerDetail!(trustPane(join(cwd, "stranger"), "trust", "/elsewhere"))).toMatchObject({
      autoTrusted: true, promptFolder: join(cwd, "stranger"), promptRoot: "/elsewhere", authorizedCwd: null });
    backend.preTrust(cwd);
    expect(auto(backend).answerDetail!(trustPane(cwd))).toMatchObject({ autoTrusted: true, promptFolder: cwd, authorizedCwd: cwd,
      configPath: expect.stringMatching(/config\.toml$/) });
  });

  it("held only for a row or layout AgEnD never answers, or a press that did not take — with the reason", () => {
    const { cwd, backend } = fixture();
    backend.preTrust(cwd);
    const quit = trustPane(cwd, "quit");
    expect(active(auto(backend), quit)).toBe(false);
    expect(hold(backend).heldReason!(quit)).toMatchObject({
      trustHoldReason: "the cursor is not on Trust and continue, or the options are not the known ones", promptFolder: cwd, configTrust: "trusted" });
    const extra = trustPane(cwd).replace("  2. Quit", "  2. Quit\n  3. Ask later");
    expect(active(auto(backend), extra)).toBe(false);
    expect(hold(backend).heldReason!(extra)).toMatchObject({ trustHoldReason: "the cursor is not on Trust and continue, or the options are not the known ones" });
    // The held entry sees the same Trust row once the one answer was used and the prompt stayed up.
    expect(hold(backend).heldReason!(trustPane(cwd))).toMatchObject({ trustHoldReason: "Trust was already pressed for this prompt and it is still up" });
  });

  it("two cursor markers, or another footer mapping, are never answered (#2896 review)", () => {
    const { cwd, backend } = fixture();
    const twoMarkers = trustPane(cwd).replace("  2. Quit", "❯ 2. Quit");
    const swapped = trustPane(cwd).replace("enter continue · esc quit", "enter quit · esc continue");
    for (const pane of [twoMarkers, swapped]) {
      expect(active(auto(backend), pane)).toBe(false);
      expect(hold(backend).isActive!(pane)).toBe(true);
    }
  });

  it("a trust layout AgEnD never answers (Open restricted / Trust and continue / Quit) is named as such", () => {
    const { backend } = fixture();
    const pane = ["  Folder access", "  /work/repo", "", "› 1. Trust and continue", "  2. Open restricted", "  3. Quit", "", "  enter continue · esc quit", ""].join("\n");
    expect(hold(backend).isActive!(pane)).toBe(true);
    expect(hold(backend).heldReason!(pane)).toMatchObject({ trustHoldReason: expect.stringMatching(/^a trust layout AgEnD never answers/) });
  });

  it("the daemon's startup scan answers Trust and logs what it trusted, once", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    let pane = trustPane(join(cwd, "stranger"));                       // no preTrust, another folder: trusted anyway
    const keys: string[] = [];
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); pane = "› Ask Codex to do anything\n\n  Context 100% left"; return true; }) };
    await daemon.dismissDialogsUntilReady(1_000, 0);
    expect(keys).toEqual(["Enter"]);
    const answered = logger.info.mock.calls.filter(([, msg]) => String(msg).startsWith("Dismissing startup dialog: Codex folder trust"));
    expect(answered).toHaveLength(1);
    expect(answered[0]![0]).toMatchObject({ autoTrusted: true, promptFolder: join(cwd, "stranger") });
    expect(logger.warn.mock.calls.filter(([, msg]) => String(msg).startsWith("Startup dialog held"))).toEqual([]);
  });

  it("a held prompt is logged once with its reason at startup, and the cursor-off case sends no key", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    const pane = trustPane(cwd, "quit");
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true, sendSpecialKey: vi.fn(async () => true) };
    await daemon.dismissDialogsUntilReady(300, 0);
    const held = logger.warn.mock.calls.filter(([, msg]) => String(msg).startsWith("Startup dialog held"));
    expect(held).toHaveLength(1);
    expect(held[0]![0]).toMatchObject({ description: "Codex folder trust needs human confirmation",
      trustHoldReason: "the cursor is not on Trust and continue, or the options are not the known ones", promptFolder: cwd });
    expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });

  it("at runtime a held prompt is logged once per hold even when the delivery probe saw it first; a later hold logs again", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    let pane = trustPane(cwd, "quit");
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true, sendSpecialKey: vi.fn(async () => true) };
    const held = () => logger.warn.mock.calls.filter(([, msg]) => String(msg).startsWith("Runtime dialog held"));
    expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
    vi.useFakeTimers();
    daemon.startErrorMonitor();
    try {
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(held()).toHaveLength(1);
      pane = "› Ask Codex to do anything\n\n  Context 100% left";
      await vi.advanceTimersByTimeAsync(5_000);
      pane = trustPane(cwd, "quit");
      for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(held()).toHaveLength(2);
      expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });

  it("the startup log names the prompt actually answered — the one re-read under the write lock (#2896 review)", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    const [a, b] = [join(cwd, "a"), join(cwd, "b")];
    const panes = [trustPane(a), trustPane(b)];                         // the scan's capture, then the locked re-read
    let after = false;
    daemon.tmux = { capturePane: vi.fn(async () => (after ? "› Ask Codex to do anything\n\n  Context 100% left" : panes.shift() ?? trustPane(b))),
      isWindowAlive: async () => true, sendSpecialKey: vi.fn(async () => { after = true; return true; }) };
    await daemon.dismissDialogsUntilReady(1_000, 0);
    const answered = logger.info.mock.calls.filter(([, msg]) => String(msg).startsWith("Dismissing startup dialog: Codex folder trust"));
    expect(answered).toHaveLength(1);
    expect(answered[0]![0]).toMatchObject({ autoTrusted: true, promptFolder: b });
  });

  it("one Enter per prompt: a prompt still up after it is held, at startup then runtime alike; a new prompt gets its own", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    let pane = trustPane(cwd);
    const keys: string[] = [];
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }) };       // the key is ignored: the prompt stays
    await daemon.dismissDialogsUntilReady(400, 0);
    expect(keys).toEqual(["Enter"]);
    vi.useFakeTimers();
    daemon.startErrorMonitor();
    try {
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(keys).toEqual(["Enter"]);                                   // never pressed again
      // Said once per hold, by whichever path saw it held first (the startup scan's last polls, or the monitor).
      const held = logger.warn.mock.calls.filter(([, msg]) => /^(?:Startup|Runtime) dialog held/.test(String(msg)));
      expect(held.filter(([f]) => (f as { trustHoldReason?: string }).trustHoldReason === "Trust was already pressed for this prompt and it is still up")).toHaveLength(1);
      pane = "› Ask Codex to do anything\n\n  Context 100% left";        // the prompt goes
      await vi.advanceTimersByTimeAsync(5_000);
      pane = trustPane(cwd);                                             // a new prompt: its own one Enter
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(keys).toEqual(["Enter", "Enter"]);
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });

  it("at runtime the Trust row is answered too (a prompt that appears later), and logged with what it trusted", async () => {
    const { instance, cwd, backend } = fixture();
    const { daemon, logger } = daemonFor(cwd, instance, backend);
    let pane = trustPane(cwd);
    const keys: string[] = [];
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); pane = "› Ask Codex to do anything\n\n  Context 100% left"; return true; }) };
    vi.useFakeTimers();
    daemon.startErrorMonitor();
    try {
      for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(keys).toEqual(["Enter"]);
      const answered = logger.info.mock.calls.filter(([, msg]) => String(msg).startsWith("Auto-dismissing runtime dialog: Codex folder trust"));
      expect(answered).toHaveLength(1);
      expect(answered[0]![0]).toMatchObject({ autoTrusted: true, promptFolder: cwd });
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });
});
