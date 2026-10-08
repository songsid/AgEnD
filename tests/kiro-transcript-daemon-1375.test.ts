import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({
  source: null as any,
  forbidden: vi.fn(() => { throw new Error("forbidden host operation"); }),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: seams.forbidden, execFile: seams.forbidden, execSync: seams.forbidden, execFileSync: seams.forbidden,
  spawn: seams.forbidden, spawnSync: seams.forbidden, fork: seams.forbidden }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(),
  createServer: seams.forbidden, createConnection: seams.forbidden, connect: seams.forbidden }));
vi.mock("../src/channel/ipc-bridge.js", () => ({ IpcServer: class extends EventEmitter { async listen() {} } }));
vi.mock("../src/tmux-manager.js", () => ({
  TmuxManager: class { static async ensureSession() {} }, resolveTmuxLogicalSize: () => ({ width: 80, height: 24 }),
}));
vi.mock("../src/transcript-sources.js", () => ({ createTranscriptSource: () => seams.source }));
vi.mock("../src/context-guardian.js", () => ({ ContextGuardian: class extends EventEmitter { startWatching() {} } }));
import { Daemon } from "../src/daemon.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true})); vi.restoreAllMocks(); expect(seams.forbidden).not.toHaveBeenCalled(); });
async function flush() { for(let i=0;i<40;i++) await Promise.resolve(); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-transcript-start-")); roots.push(dir);
  let resolve!: () => void; const baseline = new Promise<void>(done => { resolve = done; });
  seams.source = { initialize: vi.fn(() => baseline), poll: vi.fn(), reset: vi.fn(), close: vi.fn() };
  const d = Object.create(Daemon.prototype) as any;
  Object.assign(d, {name:"fixture", instanceDir:dir, config:{backend:"kiro-cli",working_directory:dir,hang_detector:{enabled:false}},
    tmuxSessionName:"never-connect", logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()},
    startupAborted:false, launchFenceEpoch:0,
    spawnClaudeWindow:vi.fn(async()=>false), injectSnapshotMessage:vi.fn(async()=>{}),
    maybeResumeInterruptedTurn:vi.fn(async()=>{}), runWarmupInstructionNotice:vi.fn(async()=>{}),
    attachPipePaneLog:vi.fn(async()=>{}), credentialProfileStore:vi.fn(()=>undefined),
    startHealthCheck:vi.fn(), startErrorMonitor:vi.fn(), startInstanceStateMonitor:vi.fn() });
  const polling = vi.spyOn(TranscriptMonitor.prototype,"startPolling").mockImplementation(()=>{});
  const stop = vi.spyOn(TranscriptMonitor.prototype,"stop");
  return {d, resolve, polling, stop};
}
describe("real Daemon.start baseline barrier with all host operations stubbed", () => {
  it("does not arm polling or report ready before the asynchronous baseline; then starts normally", async () => {
    const {d,resolve,polling}=fixture(); const start=d.start(); await flush();
    expect(seams.source.initialize).toHaveBeenCalledTimes(1);
    expect(polling).not.toHaveBeenCalled(); expect(d.startHealthCheck).not.toHaveBeenCalled();
    expect(d.logger.info.mock.calls.flat()).not.toContain("fixture ready");
    resolve(); await start; expect(polling).toHaveBeenCalledTimes(1); expect(d.startHealthCheck).toHaveBeenCalledTimes(1);
    expect(d.logger.info).toHaveBeenCalledWith("fixture ready");
  });
  it.each(["abort","epoch","replacement"])("%s while the baseline is pending never rearms the old launch", async mode => {
    const {d,resolve,polling,stop}=fixture(); const start=d.start(); await flush();
    expect(seams.source.initialize).toHaveBeenCalledTimes(1);
    const monitor=d.transcriptMonitor;
    if(mode==="abort")d.startupAborted=true;
    if(mode==="epoch")d.launchFenceEpoch++;
    if(mode==="replacement")d.transcriptMonitor={};
    resolve(); await start;
    expect(stop).toHaveBeenCalledTimes(1); expect(stop.mock.instances[0]).toBe(monitor);
    expect(seams.source.close).toHaveBeenCalledTimes(1);
    expect(polling).not.toHaveBeenCalled(); expect(d.startHealthCheck).not.toHaveBeenCalled();
  });
});
