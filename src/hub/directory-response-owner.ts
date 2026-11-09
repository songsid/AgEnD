/** Private ownership of one authenticated Save response across listener replacement; never an authority proof. */
import type { Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { HubProtocolError } from "./validation.js";

type Reply = { status: number; json: string; cookie?: string };
export interface HubDirectoryResponse {
  current(): boolean;
  /** Synchronous build/last proof/write, then positive physical drainage. No callback runs after the final check. */
  reply(build: () => Reply, current: () => boolean): Promise<void>;
  discard(): Promise<void>;
}
export interface HubDirectoryResponseListener {
  enter(req: IncomingMessage, res: ServerResponse): boolean;
  capture(req: IncomingMessage, res: ServerResponse, current: () => boolean): HubDirectoryResponse;
  close(): Promise<void>;
}
interface Held {
  socket: Socket; current(): boolean; abort(): void; drain(): Promise<void>;
  serverClosed: Promise<void> | null;
}
const yes = (proof: () => boolean) => { try { return proof() === true; } catch { return false; } };
function connection(socket: Socket): string | null {
  return socket.remoteAddress && socket.remotePort && socket.localAddress && socket.localPort
    ? JSON.stringify([socket.remoteAddress, socket.remotePort, socket.localAddress, socket.localPort]) : null;
}

export class HubDirectoryResponseOwner {
  private stopped = false;
  private readonly held = new Set<Held>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly cleanup: number;
  constructor(options: { now?: () => number; ttlMs?: number; cleanupMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 30_000; this.cleanup = options.cleanupMs ?? 2_000;
    if (![this.ttl, this.cleanup].every(n => Number.isSafeInteger(n) && n > 0 && n <= 30_000)) throw new HubProtocolError("invalid");
  }
  private async bounded(work: Promise<unknown>): Promise<void> {
    let timer!: ReturnType<typeof setTimeout>;
    try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HubProtocolError("unavailable")), this.cleanup); })]); }
    finally { clearTimeout(timer); }
  }
  /** Stop fences synchronously; close later confirms the sockets and any transferred closing server. */
  fence(): void { this.stopped = true; for (const held of this.held) held.abort(); }
  async close(): Promise<void> {
    this.fence();
    const results = await Promise.allSettled([...this.held].map(held => held.drain()));
    if (results.some(result => result.status === "rejected")) throw new HubProtocolError("unavailable");
  }
  get pending(): number { return this.held.size; }

  listener(server: Server): HubDirectoryResponseListener {
    const raw = new Set<Socket>(), secure = new Map<Socket, Socket>(), active = new Map<Socket, Set<ServerResponse>>();
    let selected: Held | null = null, closing: Promise<void> | null = null;
    server.on("connection", (socket: Socket) => { if (closing) { socket.destroy(); return; } raw.add(socket); socket.once("close", () => { raw.delete(socket); }); });
    server.on("secureConnection", socket => {
      if (closing && socket !== selected?.socket) { socket.destroy(); return; }
      const key = connection(socket), candidates = key ? [...raw].filter(raw => !raw.destroyed && connection(raw) === key) : [];
      // No private TLS internals or caller-selected connection: ambiguity cannot acquire a response lease.
      if (candidates.length === 1) secure.set(socket, candidates[0]!);
      socket.once("close", () => { secure.delete(socket); active.delete(socket); });
    });
    const beginClose = () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    });
    const closeOthers = (keep: Socket | undefined) => {
      for (const socket of raw) if (socket !== keep) socket.destroy();
      for (const socket of secure.keys()) if (secure.get(socket) !== keep) socket.destroy();
    };
    return {
      enter: (req, res) => {
        if (selected?.socket === req.socket) { selected.abort(); return false; } // No pipelined companion survives with Save.
        if (closing) { req.socket.destroy(); return false; }
        const requests = active.get(req.socket) ?? new Set<ServerResponse>(); active.set(req.socket, requests); requests.add(res);
        const done = () => { requests.delete(res); if (requests.size === 0) active.delete(req.socket); };
        res.once("finish", done); res.once("close", done); return true;
      },
      capture: (req, res, proof) => {
        if (!yes(proof) || this.stopped || closing) throw new HubProtocolError("unavailable");
        const at = this.now(), parent = secure.get(req.socket), requests = active.get(req.socket);
        if (this.held.size) throw new HubProtocolError("backpressure");
        if (!parent || req.socket !== res.socket || req.socket.destroyed || res.destroyed || res.headersSent || res.writableEnded
          || !req.complete || !req.readableEnded || !requests?.has(res) || requests.size !== 1 || !Number.isSafeInteger(at) || at < 0) throw new HubProtocolError("invalid");
        let phase: "held" | "replying" | "aborted" | "released" = "held", drain: Promise<void> | null = null;
        let ended!: () => void;
        const socketClosed = new Promise<void>(resolve => { ended = resolve; });
        const owned: Held = {
          socket: req.socket, serverClosed: null,
          current: () => { const now = this.now(); return !this.stopped && phase !== "aborted" && phase !== "released" && !req.socket.destroyed
            && !res.destroyed && !res.writableEnded && Number.isSafeInteger(now) && now >= at && now - at < this.ttl; },
          abort: () => { if (phase !== "released") { phase = "aborted"; res.destroy(); req.socket.destroy(); } },
          drain: () => drain ??= (async () => {
            try {
              await this.bounded(Promise.all([socketClosed, ...(owned.serverClosed ? [owned.serverClosed] : [])]));
              phase = "released"; clearTimeout(expiry); this.held.delete(owned); if (selected === owned) selected = null;
            } catch (error) { owned.abort(); throw error; }
            finally { drain = null; }
          })(),
        };
        const expiry = setTimeout(() => { owned.abort(); void owned.drain().catch(() => {}); }, this.ttl); expiry.unref?.();
        req.socket.once("close", () => { ended(); void owned.drain().catch(() => {}); });
        res.once("close", () => { if (!res.writableFinished) owned.abort(); });
        this.held.add(owned); selected = owned;
        return Object.freeze({
          current: owned.current,
          reply: async (build: () => Reply, current: () => boolean) => {
            try {
              if (phase !== "held" || !yes(current) || !owned.current()) throw new HubProtocolError("revoked");
              phase = "replying";
              const result = build();
              if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
                try { (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
                throw new HubProtocolError("invalid");
              }
              const status = result?.status, json = result?.json, cookie = result?.cookie;
              if (!Number.isSafeInteger(status) || status < 200 || status > 599 || typeof json !== "string" || Buffer.byteLength(json) > 64 * 1024
                || (cookie !== undefined && (typeof cookie !== "string" || cookie.length > 2048 || /[\r\n]/.test(cookie)))) throw new HubProtocolError("invalid");
              if (!yes(current) || !owned.current()) throw new HubProtocolError("revoked");
              res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Connection": "close",
                "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", ...(cookie ? { "Set-Cookie": cookie } : {}) });
              res.end(json);
              await owned.drain();
            } catch (error) { owned.abort(); void owned.drain().catch(() => {}); throw error; }
          },
          discard: () => { owned.abort(); return owned.drain(); },
        });
      },
      close: async () => {
        const keep = selected?.current() ? selected : null, parent = keep ? secure.get(keep.socket) : undefined;
        const stopped = beginClose(); void stopped.catch(() => {});
        if (keep && parent && !server.listening) {
          keep.serverClosed = stopped; closeOthers(parent);
          return; // Ownership of the closing server has moved to held; its callback is still awaited by drain/Stop.
        }
        closeOthers(undefined); await this.bounded(stopped);
      },
    };
  }
}
