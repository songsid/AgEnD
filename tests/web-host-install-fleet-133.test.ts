/**
 * AGEND-133 (upstream #3521): FleetManager.startWebInstall — the dashboard's Install is `/login`'s install without a chat.
 * Real: the registry's command through unattendedInstallCommand, the fleet-wide login window, a login shell and `which` (a throwaway HOME whose
 * .bash_profile adds the directory a fake `grok` sits in). Faked: the tmux window (LoginSession) — its poll's verdicts are fed by hand.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSessions: Array<{ flow: any; events: any; cancelled: string[]; startGate?: Promise<void> }> = [];
let startGate: Promise<void> | undefined;
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    record: { flow: any; events: any; cancelled: string[] };
    constructor(public flow: any, _tmux: any, public events: any) { this.record = { flow, events, cancelled: [] }; fakeSessions.push(this.record); }
    async start(launch?: () => void) { if (startGate) await startGate; launch?.(); }
    async cancel(reason = "cancelled") { this.record.cancelled.push(reason); this.state = "done"; }
  }
  return { ...real, LoginSession: FakeLoginSession };
});
vi.mock("../src/tmux-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tmux-manager.js")>();
  class FakeTmux { constructor() {} static async ensureSession() {} }
  return { ...real, TmuxManager: Object.assign(FakeTmux, { ensureSession: async () => {} }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { checkBinaryInstalled, BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import type { HostInstallReporter } from "../src/web-host-install.js";

let root: string, home: string, profileBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-133-"));
  home = join(root, "home");
  profileBin = join(home, ".grok", "bin");
  mkdirSync(profileBin, { recursive: true });
  writeFileSync(join(profileBin, "grok"), "#!/bin/sh\necho grok 0.4.2\n");
  chmodSync(join(profileBin, "grok"), 0o755);
  writeFileSync(join(home, ".bash_profile"), `export PATH="$HOME/.grok/bin:$PATH"\n`);
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  fakeSessions.length = 0; startGate = undefined;
});
afterEach(() => {
  process.env.PATH = saved.PATH; process.env.HOME = saved.HOME;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fleet() {
  const fm = new FleetManager(join(root, "data"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const reporter = () => {
    const progress = vi.fn<(pane: string) => void>(), done = vi.fn<Parameters<HostInstallReporter["done"]>[0] extends infer R ? (result: R) => void : never>();
    return { progress, done } satisfies HostInstallReporter;
  };
  return { fm, reporter };
}

describe("startWebInstall", () => {
  it("runs the registry's command through the unattended wrapper — the CLI's id in, nothing else", async () => {
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ started: true });
    expect(fakeSessions).toHaveLength(1);
    const { flow } = fakeSessions[0]!;
    expect(flow.backend).toBe("grok");
    const info = BACKEND_INSTALLATION_INFO.grok!;
    expect(flow.command).toContain("agend-install");
    expect(flow.command).toContain(info.unattended ?? info.install);
    expect(flow.exitMarker).toMatch(/^AGEND-INSTALL-EXIT-[0-9a-f]{16}=$/);
  });
  it("keeps held-change admission through the FleetManager and login-window handoff", async () => {
    const { fm, reporter } = fleet();
    let release!: () => void;
    startGate = new Promise<void>(r => { release = r; });
    let current = true;
    const execution = new SettingsExecution({ current: () => current, snapshot: () => null });
    const complete = vi.spyOn(execution, "complete");
    try {
      const start = fm.startWebInstall("grok", reporter(), execution);
      await vi.waitFor(() => expect(fakeSessions).toHaveLength(1));
      current = false; release();
      expect(await start).toMatchObject({ refused: "failed" });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(execution.completed).toBe(false);
      expect((fm as any).loginWindow.isHeld).toBe(false);
    } finally { release(); execution.close(); }
  });
  it("an id the registry does not install is refused; a CLI that is already installed too; nothing is started for either", async () => {
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("rm -rf /", reporter())).toEqual({ refused: "unsupported" });
    expect(await fm.startWebInstall("gemini", reporter())).toEqual({ refused: "unsupported" });
    process.env.PATH = `${profileBin}:/usr/bin:/bin`;
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ refused: "already" });
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("the start returns while the installer runs: the fleet is not held, only the one window is", async () => {
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ started: true });
    expect((fm as any).loginWindow.heldFor("grok")).toMatchObject({ kind: "install", backend: "grok" });
    // Another install, a sign-in or /login meanwhile: refused at once, never queued.
    expect(await fm.startWebInstall("codex", reporter())).toEqual({ refused: "busy" });
    expect(fakeSessions).toHaveLength(1);
  });
  it("progress goes to the reporter; success is verified on a fresh login shell, the CLI's directory joins the fleet's PATH, and the window is released", async () => {
    const { fm, reporter } = fleet();
    const r = reporter();
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("signing in");
    await fm.startWebInstall("grok", r);
    fakeSessions[0]!.events.onProgress("Downloading grok\n");
    expect(r.progress).toHaveBeenCalledWith("Downloading grok\n");
    expect(checkBinaryInstalled("grok")).toBe(false);
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done).toHaveBeenCalledTimes(1);
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, detail: "clean exit", verified: true });
    expect(typeof r.done.mock.calls[0]![0].signIn).toBe("boolean");
    expect(process.env.PATH!.split(":")[0]).toBe(profileBin);
    expect(checkBinaryInstalled("grok")).toBe(true);
    expect((fm as any).loginWindow.isHeld).toBe(false);
    expect((fm as any).activeInstall).toBeNull();
    // No chat hand-off: the page offers Sign in itself.
    expect(signIn).not.toHaveBeenCalled();
  });
  it("an installer that exits 0 but leaves no binary is not verified", async () => {
    const { fm, reporter } = fleet();
    const r = reporter();
    rmSync(join(profileBin, "grok"));
    await fm.startWebInstall("grok", r);
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, verified: false, version: null });
  });
  it("a failed installer: its verdict text goes to the reporter and nothing is verified", async () => {
    const { fm, reporter } = fleet();
    const r = reporter();
    await fm.startWebInstall("grok", r);
    await fakeSessions[0]!.events.onDone({ ok: false, detail: "CLI exited with code 7 — boom" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: false, detail: "CLI exited with code 7 — boom", verified: false });
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("a window that could not be opened releases the window and says it failed", async () => {
    const { fm, reporter } = fleet();
    const tmux = await import("../src/tmux-manager.js");
    vi.spyOn(tmux.TmuxManager as any, "ensureSession").mockRejectedValue(new Error("no tmux"));
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ refused: "failed", message: "no tmux" });
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("the fleet stopping while it starts: refused as shutting down, the window not held", async () => {
    const { fm, reporter } = fleet();
    (fm as any).loginWindow.close();
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ refused: "shutting_down" });
  });
});

describe("webHostInstalls (the page's side)", () => {
  it("a session that is not a live local admin starts nothing", async () => {
    const { fm } = fleet();
    vi.spyOn(fm as any, "isLocalAdminSession").mockReturnValue(false);
    expect(await fm.webHostInstalls.begin({ handle: "a".repeat(16), label: "x" }, "grok")).toEqual({ error: "not_allowed" });
    expect(fakeSessions).toHaveLength(0);
  });
  it("start → progress → verdict shows in the view; the pages are told twice (started, ended); cancel stops the running window", async () => {
    const { fm } = fleet();
    vi.spyOn(fm as any, "isLocalAdminSession").mockReturnValue(true);
    const frames: string[] = [];
    (fm as any).sseClients = new Set([{ write: (c: string) => { frames.push(String(c)); return true; }, destroyed: false, writableEnded: false }]);
    const first = await fm.webHostInstalls.begin({ handle: "a".repeat(16), label: "Firefox" }, "grok");
    expect(first).toMatchObject({ install: { backend: "grok", phase: "running" } });
    fakeSessions[0]!.events.onProgress("step 1\n");
    expect(fm.webHostInstalls.view()!.lines).toEqual(["step 1"]);
    expect(await fm.webHostInstalls.cancel()).toBe(true);
    expect(fakeSessions[0]!.cancelled).toEqual(["cancelled"]);
    await fakeSessions[0]!.events.onDone({ ok: false, detail: "cancelled" });
    expect(fm.webHostInstalls.view()).toMatchObject({ phase: "cancelled" });
    // The pages read again (no details in the event): once when it started, once when it ended.
    expect(frames.filter(f => f.includes("event: backend_login")).length).toBe(2);
    expect(await fm.webHostInstalls.cancel()).toBe(false);          // nothing running now
  });
});
