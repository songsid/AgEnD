/** In-process Fleet channel for a native Daemon. Contains no runner input or shell RPC. */
import { EventEmitter } from "node:events";
import type { Daemon } from "./daemon.js";
export class NativeDaemonClient extends EventEmitter {
  private closed = false;
  constructor(private daemon: Daemon, private isOwner: () => boolean) { super(); }
  get connected(): boolean { return !this.closed && this.isOwner(); }
  async connect(): Promise<void> {
    if (!this.connected) throw Error("Native daemon channel owner changed");
    this.daemon.setNativeFleetBridge({ current: () => this.connected, send: message => {
      if (this.connected) this.emit("message", message);
    } });
  }
  send(message: unknown): boolean {
    if (!this.connected || !message || typeof message !== "object" || Array.isArray(message)) return false;
    return this.daemon.acceptNativeFleetMessage(message as Record<string, unknown>);
  }
  async close(): Promise<void> { this.closed = true; this.removeAllListeners(); }
}
