/** A bounded, ownership-fenced WSS link. Socket acceptance is never durable delivery evidence. */
import { WebSocket, type RawData } from "ws";
import { HUB_LIMITS } from "./protocol.js";
import { HubProtocolError } from "./validation.js";
export type HubLinkCloseCode = "unavailable" | "invalid" | "backpressure" | "replaced" | "revoked";
export class HubSocket<Incoming, Outgoing> {
  private tail = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private alive = true;
  private ended = false;
  private heartbeat: NodeJS.Timeout;
  constructor(readonly ws: WebSocket, private readonly options: {
    current(): boolean; parse(input: Buffer): Incoming; encode(value: Outgoing): string;
    receive(value: Incoming): Promise<void>; closed(code: HubLinkCloseCode): void;
  }) {
    ws.on("pong", () => { this.alive = true; });
    ws.on("message", (data: RawData, binary) => {
      if (binary) { this.end("invalid"); return; }
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (++this.queued > HUB_LIMITS.pending || (this.queuedBytes += buffer.length) > HUB_LIMITS.sendQueue) { this.end("backpressure"); return; }
      this.tail = this.tail.then(async () => {
        if (!this.current()) return;
        await options.receive(options.parse(buffer));
      }).catch(error => { this.end(error instanceof HubProtocolError && error.code === "backpressure" ? "backpressure" : "invalid"); })
        .finally(() => { this.queued--; this.queuedBytes -= buffer.length; });
    });
    ws.on("close", (code, reason) => this.end(code === 1008 && ["replaced", "revoked"].includes(reason.toString()) ? reason.toString() as "replaced" | "revoked" : "unavailable")); ws.on("error", () => this.end("unavailable"));
    this.heartbeat = setInterval(() => {
      if (!this.current() || !this.alive) { this.end("unavailable"); return; }
      this.alive = false; ws.ping(undefined, undefined, (error?: Error) => { if (error) this.end("unavailable"); });
    }, HUB_LIMITS.heartbeat);
    this.heartbeat.unref();
  }
  current(): boolean { return !this.ended && this.ws.readyState === WebSocket.OPEN && this.options.current(); }
  async send(value: Outgoing): Promise<void> {
    if (!this.current()) throw new HubProtocolError("unavailable");
    const data = this.options.encode(value);
    if (Buffer.byteLength(data) > HUB_LIMITS.frame || this.ws.bufferedAmount + Buffer.byteLength(data) > HUB_LIMITS.sendQueue) throw new HubProtocolError("backpressure");
    await new Promise<void>((resolve, reject) => this.ws.send(data, error => error ? reject(new HubProtocolError("uncertain")) : resolve()));
    if (!this.current()) throw new HubProtocolError("uncertain");
  }
  retire(reason: "replaced" | "revoked"): void {
    if (this.ended) return; this.ended = true; clearInterval(this.heartbeat);
    this.ws.close(1008, reason);
    const timer = setTimeout(() => this.ws.terminate(), 2_000); timer.unref(); this.ws.once("close", () => clearTimeout(timer));
    this.options.closed(reason);
  }
  end(code: HubLinkCloseCode = "unavailable"): void {
    if (this.ended) return; this.ended = true; clearInterval(this.heartbeat); this.ws.terminate(); this.options.closed(code);
  }
}
