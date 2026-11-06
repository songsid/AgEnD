/** Async native module startup and teardown stay outside the runner's transport loop. */
import { spawn } from "./child-process.js";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { prepareNativePaneQuotaHistory } from "./runtime-pane-quota-history.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import type { RuntimePaneProcess } from "./runtime-pane-host.js";
import type { NativePaneCommand, NativePaneFrame, NativePaneOwner } from "./runtime-pane-native.js";
// Include the worker in standalone TypeScript build closures without loading it in the runner.
import type {} from "./runtime-pane-worker.js";
import type {} from "./runtime-pane-job-owner.js";

export async function spawnNativePane(launch: RuntimePaneLaunch, owner: NativePaneOwner): Promise<RuntimePaneProcess> {
  if (process.platform !== "win32") return Promise.reject(Error("Persistent Windows panes require native Windows Node"));
  // Freeze only positively verified quota records BEFORE this exact resume can write or repaint anything.
  const quotaReplay = await prepareNativePaneQuotaHistory(launch);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./runtime-pane-job-owner.js", import.meta.url)),
      owner.directory, owner.launchId, launch.paneId, launch.agentId, String(process.pid),
    ], {
      // libuv kills non-detached children when the runner dies. This owner must finish its exact-job receipt first.
      detached: true, windowsHide: true, shell: false, env: nativeCliEnvironment(), stdio: ["pipe", "pipe", "pipe"],
    });
    const events = new EventEmitter();
    const decoder = new StringDecoder("utf8");
    let pending = "", ready = false, exited = false, failed = false, confirmedCode: number | undefined;
    const buffered: string[] = [];
    const fail = (): void => { failed = true; events.emit("failure"); if (!ready) reject(Error("ConPTY helper startup was not confirmed")); };
    const send = (value: NativePaneCommand): void => {
      if (exited || !child.stdin?.writable || child.stdin.writableLength > 256 * 1024) throw Error("ConPTY helper input is unavailable");
      child.stdin.write(JSON.stringify(value) + "\n", error => { if (error) fail(); });
    };
    const proxy: RuntimePaneProcess = {
      ...(quotaReplay ? { quotaReplay } : {}),
      get pid() { return child.pid ?? 0; },
      write: data => send({ type: "input", data: typeof data === "string" ? data : data.toString("utf8") }), resize: (columns, rows) => send({ type: "resize", columns, rows }),
      kill: () => send({ type: "close" }), pause: () => send({ type: "pause" }), resume: () => send({ type: "resume" }),
      onData: listener => { events.on("output", listener); for (const data of buffered.splice(0)) listener(data); return { dispose: () => { events.removeListener("output", listener); } }; },
      onExit: listener => { events.on("exit", listener); if (exited && confirmedCode !== undefined) listener({ exitCode: confirmedCode }); return { dispose: () => { events.removeListener("exit", listener); } }; },
      onFailure: listener => { events.on("failure", listener); if (failed) listener(); return { dispose: () => { events.removeListener("failure", listener); } }; },
    };
    const timer = setTimeout(() => {
      fail();
      // Only this ChildProcess handle, never a discovered PID. The durable pane reservation remains unknown.
      child.kill();
    }, 120_000);
    child.stdout?.on("data", (data: Buffer) => {
      pending += decoder.write(data);
      if (Buffer.byteLength(pending) > 256 * 1024) { fail(); child.kill(); return; }
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const frame = JSON.parse(line) as NativePaneFrame;
          if (frame.type === "ready" && !ready && Number.isSafeInteger(frame.pid) && frame.pid > 0) {
            clearTimeout(timer); ready = true; resolve(proxy);
          } else if (frame.type === "output" && typeof frame.data === "string" && Buffer.byteLength(frame.data) <= 64 * 1024) {
            if (events.listenerCount("output")) events.emit("output", frame.data);
            else {
              buffered.push(frame.data);
              if (buffered.reduce((size, data) => size + Buffer.byteLength(data), 0) > 256 * 1024) { fail(); child.kill(); }
            }
          }
          else if (frame.type === "tree.exit" && Number.isSafeInteger(frame.code) && frame.code >= 0) confirmedCode = frame.code;
          else if (frame.type === "exit") { /* Root CLI exit is insufficient: its owned descendants may remain. */ }
          else throw Error("Invalid ConPTY helper frame");
        } catch { fail(); }
      }
    });
    child.stderr?.resume(); // Untrusted native startup output never goes into protocol diagnostics.
    child.stdin?.on("error", fail);
    child.on("error", () => { clearTimeout(timer); fail(); });
    child.on("close", () => {
      clearTimeout(timer); exited = true;
      if (confirmedCode === undefined || !ready) fail();
      else events.emit("exit", { exitCode: confirmedCode });
    });
    try { send({ type: "start", launch, owner }); } catch { fail(); child.kill(); }
  });
}
