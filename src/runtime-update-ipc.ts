/** Inherited local Node IPC only. This protocol never carries credentials, shell commands, tasks or network URLs. */
import { isAbsolute } from "node:path";

interface Base { v: 1; id: string }
export type RuntimeUpdateIpcMessage =
  | Base & { type: "init"; role: "helper" | "rollback"; ownerId: string; profile: string }
  | Base & { type: "armed" }
  | Base & { type: "failure"; reason: "startup" | "identity" | "ownership" | "uncertain" };
export interface RuntimeUpdateIpcPeer {
  readonly connected: boolean;
  on(event: "message" | "disconnect" | "error", listener: (...args: any[]) => void): unknown;
  off(event: "message" | "disconnect" | "error", listener: (...args: any[]) => void): unknown;
  send(value: RuntimeUpdateIpcMessage, callback: (error: Error | null) => void): unknown;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseRuntimeUpdateIpc(value: unknown): RuntimeUpdateIpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Runtime update IPC");
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || typeof p.id !== "string" || !UUID.test(p.id) || typeof p.type !== "string" || Buffer.byteLength(JSON.stringify(p)) > 16 * 1024) throw Error("Invalid Runtime update IPC");
  let fields: string[];
  switch (p.type) {
    case "init":
      fields = ["role", "ownerId", "profile"];
      if (typeof p.role !== "string" || !["helper", "rollback"].includes(p.role) || typeof p.ownerId !== "string" || !UUID.test(p.ownerId)
        || typeof p.profile !== "string" || p.profile.length > 4096 || /[\x00-\x1f\x7f]/.test(p.profile) || !isAbsolute(p.profile)) throw Error("Invalid Runtime update initialization");
      break;
    case "failure":
      fields = ["reason"];
      if (typeof p.reason !== "string" || !["startup", "identity", "ownership", "uncertain"].includes(p.reason)) throw Error("Invalid Runtime update failure");
      break;
    case "armed": fields = []; break;
    default: throw Error("Unsupported Runtime update IPC");
  }
  const allowed = ["v", "id", "type", ...fields];
  if (Object.keys(p).length !== allowed.length || Object.keys(p).some(key => !allowed.includes(key))) throw Error("Invalid Runtime update IPC fields");
  return structuredClone(p) as unknown as RuntimeUpdateIpcMessage;
}
/** A closed channel is uncertainty, never permission to terminate an admitted Runtime or roll it back. */
export class RuntimeUpdateIpc {
  private id: string | undefined;
  private failure: Error | undefined;
  private queue: RuntimeUpdateIpcMessage[] = [];
  private pending: { types: readonly RuntimeUpdateIpcMessage["type"][]; accept(value: RuntimeUpdateIpcMessage): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private readonly onMessage = (value: unknown) => {
    try {
      const message = parseRuntimeUpdateIpc(value);
      if (!this.id) { if (message.type !== "init") throw Error("Runtime update initialization required"); this.id = message.id; }
      if (message.id !== this.id || this.queue.length >= 16) throw Error("Runtime update IPC binding changed");
      if (this.failure) return;
      this.queue.push(message); this.consume();
    } catch { this.fail(Error("Runtime update IPC refused")); }
  };
  private readonly onDisconnect = () => this.fail(Error("Runtime update IPC disconnected"));
  private readonly onError = () => this.fail(Error("Runtime update IPC unavailable"));
  constructor(private readonly peer: RuntimeUpdateIpcPeer, id?: string) {
    if (!peer.connected || id !== undefined && !UUID.test(id)) throw Error("Inherited Runtime update IPC required");
    this.id = id; peer.on("message", this.onMessage); peer.on("disconnect", this.onDisconnect); peer.on("error", this.onError);
  }
  private fail(error: Error): void {
    this.failure ??= error; this.queue = [];
    if (this.pending) { const p = this.pending; this.pending = undefined; clearTimeout(p.timer); p.reject(this.failure); }
  }
  private consume(): void {
    if (!this.pending || !this.queue.length) return;
    const message = this.queue.shift()!, p = this.pending;
    if (!p.types.includes(message.type)) { this.fail(Error("Unexpected Runtime update IPC phase")); return; }
    this.pending = undefined; clearTimeout(p.timer); p.accept(message);
  }
  next(types: readonly RuntimeUpdateIpcMessage["type"][], timeoutMs = 10_000): Promise<RuntimeUpdateIpcMessage> {
    if (this.failure || !this.peer.connected) return Promise.reject(this.failure ?? Error("Runtime update IPC disconnected"));
    if (this.pending || !types.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(Error("Runtime update IPC wait refused"));
    const result = new Promise<RuntimeUpdateIpcMessage>((accept, reject) => {
      const timer = setTimeout(() => this.fail(Error("Runtime update IPC acknowledgement is unconfirmed")), timeoutMs);
      this.pending = { types, accept, reject, timer }; this.consume();
    });
    return result;
  }
  send(value: RuntimeUpdateIpcMessage): Promise<void> {
    try {
      const message = parseRuntimeUpdateIpc(value);
      if (this.failure || !this.peer.connected || this.id !== message.id) throw Error("Runtime update IPC unavailable");
      return new Promise((accept, reject) => {
        try { this.peer.send(message, error => { if (error) { this.onError(); reject(Error("Runtime update IPC unavailable")); } else accept(); }); }
        catch { this.onError(); reject(Error("Runtime update IPC unavailable")); }
      });
    } catch { this.fail(Error("Runtime update IPC send refused")); return Promise.reject(this.failure!); }
  }
  /** Register the wait before invoking a callback that can synchronously return a response. */
  async exchange(value: RuntimeUpdateIpcMessage, types: readonly RuntimeUpdateIpcMessage["type"][], timeoutMs?: number): Promise<RuntimeUpdateIpcMessage> {
    const duration = timeoutMs ?? 10_000;
    if (this.failure || !this.peer.connected || this.pending || !types.length || !Number.isSafeInteger(duration) || duration < 1 || duration > 60_000) throw Error("Runtime update IPC exchange refused");
    const waiting = this.next(types, duration), sending = this.send(value);
    return (await Promise.all([waiting, sending]))[0];
  }
  close(): void {
    this.fail(Error("Runtime update IPC closed"));
    this.peer.off("message", this.onMessage); this.peer.off("disconnect", this.onDisconnect); this.peer.off("error", this.onError);
  }
}
