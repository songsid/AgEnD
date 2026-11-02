/** Private authenticated link to a persistent host. Closing the runtime client never closes its CLI panes. */
import WebSocket from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "./child-process.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { protectPaneDirectory, readPaneHostDescriptor, type PaneHostDescriptor } from "./runtime-pane-private.js";
import { validateRuntimePaneRequest, validateRuntimePaneSnapshot, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type {} from "./runtime-pane-service.js";
export interface PaneLinkOptions {
  directory: string;
  server: string;
  machineId: string;
  online(): boolean;
  maxAgents(): number;
  output?(snapshot: RuntimePaneSnapshot): void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class RuntimePaneLink {
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private constructor(private socket: WebSocket, readonly hostBootId: string, private options: Pick<PaneLinkOptions, "online" | "maxAgents" | "output">) {}
  static async open(options: PaneLinkOptions): Promise<RuntimePaneLink> {
    if (process.platform !== "win32") throw Error("Persistent pane host requires Windows Node");
    const directory = join(options.directory, "pane-host");
    await protectPaneDirectory(directory);
    const scope = runtimeJobDigest({ server: options.server, machineId: options.machineId });
    let descriptor = readPaneHostDescriptor(directory, scope);
    let live = false;
    if (descriptor) {
      live = true;
      try { process.kill(descriptor.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; }
    }
    if (!live) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./runtime-pane-service.js", import.meta.url)), directory, scope], {
        detached: true, windowsHide: true, stdio: "ignore", shell: false, env: nativeCliEnvironment(),
      });
      let failed = false; child.on("error", () => { failed = true; }); child.unref();
      const deadline = performance.now() + 120_000;
      const prior = descriptor?.hostBootId;
      for (;;) {
        if (failed || child.exitCode !== null) throw Error("Pane host startup was not confirmed");
        descriptor = readPaneHostDescriptor(directory, scope);
        if (descriptor && descriptor.hostBootId !== prior && descriptor.pid === child.pid) break;
        if (performance.now() > deadline) throw Error("Pane host startup deadline; its state is retained for inspection");
        await new Promise(done => setTimeout(done, 50));
      }
    }
    if (!descriptor) throw Error("Pane host descriptor is unavailable");
    // A live descriptor which cannot authenticate is held, never replaced by another host.
    return this.attach(descriptor, options);
  }
  /** Authenticated discovery seam; fixtures bind only private loopback services. */
  static attach(descriptor: PaneHostDescriptor, options: Pick<PaneLinkOptions, "online" | "maxAgents" | "output">): Promise<RuntimePaneLink> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/pane/v1`, { headers: { Authorization: `Bearer ${descriptor.token}` },
        handshakeTimeout: 10_000, maxPayload: 256 * 1024, followRedirects: false, perMessageDeflate: false });
      const link = new RuntimePaneLink(socket, descriptor.hostBootId, options);
      let ready = false;
      const deadline = setTimeout(() => { socket.terminate(); reject(Error("Pane host authentication deadline")); }, 10_000);
      socket.on("error", () => {});
      socket.on("close", () => { clearTimeout(deadline); link.closePending(); if (!ready) reject(Error("Pane host attachment is unconfirmed")); });
      socket.on("message", (bytes, binary) => {
        try {
          if (binary) throw Error("Binary pane frame");
          const value = JSON.parse(bytes.toString());
          if (!ready) {
            if (value?.type !== "hello" || value.hostBootId !== descriptor.hostBootId) throw Error("Pane host boot changed");
            ready = true; clearTimeout(deadline); link.lease(); link.timer = setInterval(() => link.lease(), 5000); link.timer.unref(); resolve(link); return;
          }
          if (value?.type === "output") { options.output?.(validateRuntimePaneSnapshot(value.snapshot)); return; }
          if (value?.type !== "response" || typeof value.id !== "string" || typeof value.ok !== "boolean") throw Error("Invalid pane reply");
          const pending = link.pending.get(value.id); if (!pending) return;
          link.pending.delete(value.id); clearTimeout(pending.timer);
          if (value.ok) pending.resolve(value.result); else pending.reject(Error("Pane host refused operation; inspect its owned snapshot"));
        } catch { socket.close(1008, "Invalid pane host frame"); }
      });
    });
  }
  private lease(): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.closed) return;
    const maxAgents = this.options.maxAgents();
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) { this.socket.close(1008, "Invalid machine limit"); return; }
    this.socket.send(JSON.stringify({ type: "lease", online: this.options.online(), maxAgents }));
  }
  request(raw: unknown): Promise<unknown> {
    const request = validateRuntimePaneRequest(raw);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || !this.options.online()) return Promise.reject(Error("Pane client is disconnected"));
    if (this.pending.size >= 64 || this.socket.bufferedAmount > 256 * 1024) return Promise.reject(Error("Pane client backpressure limit"));
    this.lease();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Pane result unconfirmed; no input is replayed")); }, 125_000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, request }), error => {
        if (!error) return;
        const pending = this.pending.get(id); if (pending) { clearTimeout(timer); this.pending.delete(id); reject(Error("Pane result unconfirmed")); }
      });
    });
  }
  private closePending(): void {
    this.closed = true; clearInterval(this.timer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Pane connection closed; terminal ownership is retained")); }
    this.pending.clear();
  }
  async stop(): Promise<void> { this.closePending(); this.socket.terminate(); }
}
