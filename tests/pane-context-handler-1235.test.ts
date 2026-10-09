import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { Logger } from "../src/logger.js";
const io = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), ...io }));
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { TmuxControlClient } from "../src/tmux-control.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { forgetInstanceContext } from "../src/topic-commands.js";
import { getTmuxSocketName } from "../src/paths.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";

class CaptureRes extends ServerResponse {
  status = 0;
  body = "";
  writeHead(status: number): this { this.status = status; return this; }
  end(chunk?: unknown): this { if (chunk) this.body += String(chunk); return this; }
}
const token = "a".repeat(48);
function details(ctx: FleetManager | WebApiContext): number | null {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = "GET"; req.url = "/ui/instance/one"; req.headers = { "x-agend-token": token };
  const res = new CaptureRes(req);
  expect(handleWebRequest(req, res, new URL(req.url, "http://localhost"), ctx as unknown as WebApiContext)).toBe(true);
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { context_pct: number | null }).context_pct;
}

function child() {
  return Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn((_data: string, _callback?: unknown) => true) }), kill: vi.fn(() => true) });
}
type Child = ReturnType<typeof child>;
const roots: string[] = [], clients: TmuxControlClient[] = [], fleets: FleetManager[] = [], daemons: Daemon[] = [];
let attachment: Child, sequence: number;
const logger = pino({ enabled: false }) as Logger;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  TmuxManager.setSocketName(getTmuxSocketName()); sequence = 1;
  for (const mock of Object.values(io)) mock.mockReset().mockImplementation(() => { throw Error("unexpected native process call"); });
  io.spawn.mockImplementation((command, args) => {
    expect(command).toBe("tmux"); expect(args).toContain("-C"); expect(args).toContain("-L");
    expect(args[args.indexOf("-L") + 1]).toBe(getTmuxSocketName());
    attachment = child(); return attachment;
  });
});
afterEach(() => {
  for (const fm of fleets.splice(0)) clearInterval((fm as any).replyObligationTimer);
  for (const d of daemons.splice(0)) (d as any).stopInstanceStateMonitor();
  for (const c of clients.splice(0)) c.stop();
  forgetInstanceContext("one"); TmuxManager.setSocketName(null); vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function reply(pane: string) {
  const command = String(attachment.stdin.write.mock.calls.at(-1)?.[0]);
  const nonce = command.match(/display-message -p '(agend-read-[^']+)'/)?.[1];
  expect(nonce).toBeTruthy(); const id = ++sequence;
  attachment.stdout.emit("data", Buffer.from(`%begin 10 ${id} 1\n${pane}%end 10 ${id} 1\n%begin 10 ${id + 1} 1\n${nonce}\n%end 10 ${id + 1} 1\n`));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-pane1235-")); roots.push(root);
  writeFileSync(join(root, "web.token"), token, { mode: 0o600 });
  const config = { backend: "codex", working_directory: root, lightweight: true, log_level: "error",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as const;
  const control = new TmuxControlClient("context-fixture"); clients.push(control); control.start();
  attachment.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  const manager = new TmuxManager("context-fixture", "@1", undefined, control);
  const dir = join(root, "instances", "one"); mkdirSync(dir, { recursive: true });
  const d = new Daemon("one", config, dir, true, undefined, control, logger); daemons.push(d);
  (d as any).tmux = manager;
  const fm = new FleetManager(root); fleets.push(fm);
  const f = fm as any; f.logger = logger; f.fleetConfig = { defaults: {}, instances: { one: config } }; f.daemons.set("one", d);
  // Presentation seams are unrelated to the context reader; the real public getter,
  // resolver, owner producers, manager, lane and control parser remain in the path.
  f.resolveInstanceModel = () => ({ display: "fixture", source: "config" });
  f.resolveInstanceEffort = () => ({ effort: null, source: "config" }); f.effortStrategyFor = () => "unsupported";
  f.instancePresentation = () => ({ state: "idle", execution_state: "idle" }); f.getInstanceStatus = () => "running";
  const context = () => (fm.getUiStatus() as { instances: Array<{ context_pct: number | null }> }).instances[0].context_pct;
  return { root, fm, f, daemon: d, d: d as any, control, manager, context };
}

describe("public status to the existing tmux control attachment", () => {
  it("joins repeated status reads and parses the control response without native queries", async () => {
    const h = fixture();
    const read = vi.spyOn(h.control, "read");
    for (let i = 0; i < 25; i++) expect(h.context()).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({ kind: "capture", session: "context-fixture", window: "@1", history: 60 }, 2_000);
    expect(attachment.stdin.write).toHaveBeenCalledOnce();
    expect(attachment.stdin.write.mock.calls[0][0]).toContain("capture-pane");
    expect(attachment.stdin.write.mock.calls[0][0]).toContain("'-60'");
    reply("Context 33% left\n"); await drain(); expect(h.context()).toBe(67);
    expect(io.spawn).toHaveBeenCalledOnce(); // only the inert initial control attachment
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it("Details returns the status-warmed context through the real web handler", async () => {
    const h = fixture(); const read = vi.spyOn(h.control, "read");
    expect(h.context()).toBeNull(); reply("Context 33% left\n"); await drain();
    expect(h.context()).toBe(67);
    for (let i = 0; i < 25; i++) expect(details(h.fm)).toBe(67);
    expect(read).toHaveBeenCalledOnce(); expect(attachment.stdin.write).toHaveBeenCalledOnce();
    expect(io.spawn).toHaveBeenCalledOnce();
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it("opening Details preserves the warm status cache without another capture", async () => {
    const h = fixture(); const read = vi.spyOn(h.control, "read");
    expect(h.context()).toBeNull(); reply("Context 33% left\n"); await drain();
    expect(h.context()).toBe(67); details(h.fm);
    expect(h.context()).toBe(67);
    expect(read).toHaveBeenCalledOnce(); expect(attachment.stdin.write).toHaveBeenCalledOnce();
  });

  it("a cold Details request and status join the same owned capture", async () => {
    const h = fixture(); const read = vi.spyOn(h.control, "read");
    expect(details(h.fm)).toBeNull(); expect(h.context()).toBeNull(); expect(details(h.fm)).toBeNull();
    expect(read).toHaveBeenCalledOnce(); expect(attachment.stdin.write).toHaveBeenCalledOnce();
    reply("Context 33% left\n"); await drain();
    expect(details(h.fm)).toBe(67); expect(h.context()).toBe(67); expect(read).toHaveBeenCalledOnce();
  });

  it("Details without an owner-source getter stays unknown and starts no capture", () => {
    const h = fixture(); const ctx = Object.create(h.fm) as WebApiContext;
    Object.defineProperty(ctx, "getPaneContextSource", { value: undefined });
    expect(details(ctx)).toBeNull(); expect(attachment.stdin.write).not.toHaveBeenCalled();
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["stop", "daemon"] as const)("Details rejects a held capture after owner retirement by %s", async event => {
    const h = fixture(); const read = vi.spyOn(h.control, "read");
    expect(h.context()).toBeNull();
    if (event === "stop") h.daemon.fenceDeliveryWritesForStop();
    else h.f.daemons.delete("one");
    expect(details(h.fm)).toBeNull();
    reply("Context 33% left\n"); await drain();
    expect(details(h.fm)).toBeNull(); expect(h.context()).toBeNull();
    expect(read).toHaveBeenCalledOnce(); expect(attachment.stdin.write).toHaveBeenCalledOnce();
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["stop", "spawn", "freeze", "manager", "daemon", "delivery", "fleet-stop"] as const)("rejects held pane results after %s", async event => {
    const h = fixture(); expect(h.context()).toBeNull(); const captured = h.fm.getPaneContextSource("one")!;
    if (event === "stop") { h.daemon.fenceDeliveryWritesForStop(); expect(h.daemon.getPaneContextSource()).toBeNull(); }
    if (event === "spawn") { h.d.beginSpawn(); h.d.endSpawn(); }
    if (event === "freeze") h.d.freezeRuntimeMonitors();
    if (event === "manager") h.d.tmux = new TmuxManager("context-fixture", "@2", undefined, h.control);
    if (event === "daemon") h.f.daemons.delete("one");
    if (event === "delivery") h.f.cancelPendingDeliveries("one");
    if (event === "fleet-stop") h.f.shuttingDown = true;
    expect(captured.isCurrent()).toBe(false);
    reply("Context 1% left\n"); await drain(); expect(h.context()).toBeNull();
    if (["spawn", "freeze", "manager", "delivery"].includes(event)) {
      reply("Context 80% left\n"); await drain(); expect(h.context()).toBe(20);
    }
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it("an expired control attempt uses the existing bounded fallback and remains unknown", async () => {
    const h = fixture(); expect(h.context()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_001); expect(h.context()).toBeNull();
    expect(io.execFile).toHaveBeenCalledExactlyOnceWith("tmux", ["-L", getTmuxSocketName(), "capture-pane", "-t", "context-fixture:@1", "-p", "-S", "-60"], { maxBuffer: 1_048_576, timeout: 1_000 }, expect.any(Function));
    // This is the manager lane's inert fallback, within the original 2s budget.
    expect(io.spawn).toHaveBeenCalledOnce();
  });

  it("a held control response lets a real event-loop heartbeat run", async () => {
    vi.useRealTimers(); const h = fixture(); let heartbeat = false;
    expect(h.context()).toBeNull(); setTimeout(() => { heartbeat = true; }, 0);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(heartbeat).toBe(true); expect(h.context()).toBeNull();
    reply("Context 33% left\n"); await drain(); expect(h.context()).toBe(67);
    expect(io.spawn).toHaveBeenCalledOnce();
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });

  it("an unbound or stopping daemon supplies no pane reader", () => {
    const h = fixture(); h.d.controlClient = undefined;
    expect(h.daemon.getPaneContextSource()).toBeNull(); expect(h.context()).toBeNull();
    expect(attachment.stdin.write).not.toHaveBeenCalled();
    for (const mock of [io.execFile, io.execSync, io.execFileSync, io.spawnSync]) expect(mock).not.toHaveBeenCalled();
  });
});
