/** Dedicated TLS machine listener. No Hub browser routes or ordinary fleet authority lives here. */
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { HubMemberFrame, HubServerFrame, PersonKey } from "./types.js";
import { HUB_CAPABILITIES, HUB_LIMITS, HUB_OPTIONAL_CAPABILITIES, HUB_PATHS, parseMemberFrame, encodeServerFrame } from "./protocol.js";
import { HubSocket, type HubLinkCloseCode } from "./socket.js";
import { HubProtocolError, parseStrictJson } from "./validation.js";
import { HubPairingService } from "./pairing.js";
import { readPrivateFile } from "./private-files.js";
import { readHubIdentity } from "./tls.js";
import { personKeyString } from "./identity.js";
/** `features`: the optional features both ends listed (the member's hello ∩ this Hub's), set once at hello. */
export interface HubLinkContext { fleetId: string; owner: PersonKey; linkEpoch: number; current(): boolean; readonly features: ReadonlySet<string> }
interface Connection { link: HubSocket<HubMemberFrame, HubServerFrame>; context: HubLinkContext; ready: boolean; hello: boolean; timer: NodeJS.Timeout }
export interface HubServerOptions {
  home: string; hubId: string; memberOrigin: string; listen: { host: string; port: number }; pairing: HubPairingService;
  current(): boolean;
  /** S3/S5 authorize and atomically audit before returning a reply. Throwing never falls through to fleet tools. */
  receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, context: HubLinkContext): Promise<HubServerFrame | void>;
  hold(fleetId: string | null, code: HubLinkCloseCode): void;
  /** The optional features this Hub offers (tests use a smaller list to stand in for an older Hub). */
  capabilities?: readonly string[];
}
export class HubServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, Connection>();
  private sockets = new Set<Socket>();
  private stopped = false;
  private accepting = 0;
  private handshakes = 0;
  constructor(private readonly options: HubServerOptions) {}
  private current(): boolean { return !this.stopped && this.options.current(); }
  address(): AddressInfo | null { const x = this.server?.address(); return x && typeof x !== "string" ? x : null; }
  async start(): Promise<void> {
    if (!this.current() || this.server) throw new HubProtocolError("unavailable");
    const identity = readHubIdentity(this.options);
    if (identity.hubId !== this.options.hubId) throw new HubProtocolError("invalid");
    const server = createServer({ key: readPrivateFile(this.options.home, "hub/keys/tls-key.pem"), cert: readPrivateFile(this.options.home, "hub/keys/tls-cert.pem"), minVersion: "TLSv1.2", maxHeaderSize: 8 * 1024 },
      (req, res) => { void this.http(req, res).catch(() => this.response(res, 503, { code: "unavailable" })); });
    this.server = server; this.wss = new WebSocketServer({ noServer: true, maxPayload: HUB_LIMITS.frame, perMessageDeflate: false });
    server.requestTimeout = server.headersTimeout = 5_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 16;
    server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); if (this.sockets.size > 256) socket.destroy(); });
    server.on("upgrade", (req, socket, head) => { void this.upgrade(req, socket, head).catch(() => socket.destroy()); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(this.options.listen.port, this.options.listen.host, () => { server.removeListener("error", reject); resolve(); });
    });
    if (!this.current()) { await this.close(); throw new HubProtocolError("stale"); }
  }
  private machine(req: IncomingMessage): boolean {
    return this.current() && (req.socket as Socket & { encrypted?: boolean }).encrypted === true
      && req.headers.origin === undefined && req.headers.cookie === undefined && req.headers["sec-websocket-protocol"] === undefined;
  }
  private response(res: ServerResponse, code: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body));
  }
  private async body(req: IncomingMessage): Promise<unknown> {
    if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"] !== undefined) throw new HubProtocolError();
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const part of req) { const b = Buffer.from(part); bytes += b.length; if (bytes > 2048) { req.destroy(); throw new HubProtocolError(); } chunks.push(b); }
    return parseStrictJson(Buffer.concat(chunks), 2048);
  }
  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.machine(req) || req.headers.authorization !== undefined || req.method !== "POST" || ![HUB_PATHS.pair, HUB_PATHS.claim].includes(req.url as typeof HUB_PATHS.pair)) { this.response(res, 404, { code: "not-found" }); return; }
    if (++this.accepting > HUB_LIMITS.pending) { this.accepting--; this.response(res, 429, { code: "backpressure" }); return; }
    try {
      const body = await this.body(req); if (!this.current()) throw new HubProtocolError("unavailable");
      const result = req.url === HUB_PATHS.pair ? this.options.pairing.pair(body) : await this.options.pairing.claim(body);
      if (!this.current()) throw new HubProtocolError("unavailable"); this.response(res, 200, result);
    } catch (error) { this.response(res, error instanceof HubProtocolError && error.code === "denied" ? 403 : 400, { code: error instanceof HubProtocolError ? error.code : "invalid" }); }
    finally { this.accepting--; }
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.machine(req) || req.method !== "GET" || req.url !== HUB_PATHS.connect || !/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization ?? "")) { socket.destroy(); return; }
    if (++this.handshakes > HUB_LIMITS.pending) { this.handshakes--; socket.destroy(); return; }
    try {
      const binding = await this.options.pairing.connect(req.headers.authorization!.slice(7));
      if (!this.current() || socket.destroyed) { socket.destroy(); return; }
      // The pairing service fences any old connection before committing the new epoch.
      this.fenceFleet(binding.fleetId);
      this.wss!.handleUpgrade(req, socket, head, ws => {
        let connection!: Connection;
        const context: HubLinkContext = { fleetId: binding.fleetId, owner: binding.owner, linkEpoch: binding.linkEpoch, features: new Set<string>(),
          current: () => this.current() && this.connections.get(binding.fleetId) === connection && this.options.pairing.bindingCurrent(binding.fleetId, binding.generation) };
        const link = new HubSocket(ws, { current: context.current, parse: parseMemberFrame, encode: encodeServerFrame,
          receive: frame => this.receive(frame, connection, binding.revocationVersion), closed: code => {
            clearTimeout(connection?.timer); if (this.connections.get(binding.fleetId) === connection) this.connections.delete(binding.fleetId);
            this.options.hold(binding.fleetId, code);
          } });
        connection = { link, context, ready: false, hello: false, timer: setTimeout(() => link.end(), 5_000) }; connection.timer.unref();
        this.connections.set(binding.fleetId, connection);
      });
    } finally { this.handshakes--; }
  }
  private async receive(frame: HubMemberFrame, connection: Connection, revocationVersion: number): Promise<void> {
    const { link, context } = connection; if (!context.current()) throw new HubProtocolError("stale");
    if (!connection.hello) {
      if (frame.type !== "hello" || frame.linkEpoch !== 0 || !frame.payload.supportedVersions.includes(1) || HUB_CAPABILITIES.some(c => !frame.payload.capabilities.includes(c))) throw new HubProtocolError("incompatible");
      connection.hello = true; clearTimeout(connection.timer);
      const offered = this.options.capabilities ?? HUB_OPTIONAL_CAPABILITIES, features = context.features as Set<string>;
      for (const c of offered) if (frame.payload.capabilities.includes(c)) features.add(c);
      await link.send({ v: 1, type: "welcome", requestId: frame.requestId, linkEpoch: context.linkEpoch,
        payload: { selectedVersion: 1, hubId: this.options.hubId, fleetId: context.fleetId, linkEpoch: context.linkEpoch, revocationVersion,
          // Only to a member that asked: an older member's strict welcome schema refuses the field.
          ...(features.has("welcome-caps-v1") ? { capabilities: [...offered] } : {}) } }); return;
    }
    if (frame.type === "hello" || frame.linkEpoch !== context.linkEpoch) throw new HubProtocolError("stale");
    if (!connection.ready && !["exposure.snapshot", "reconcile", "error"].includes(frame.type)) throw new HubProtocolError("unavailable");
    if (frame.type === "exposure.snapshot" && frame.payload.exposures.some(e => e.fleetId !== context.fleetId || personKeyString(e.owner) !== personKeyString(context.owner))) throw new HubProtocolError("denied");
    const result = await this.options.receive(frame, context);
    if (!context.current()) return;
    if (result) {
      if (result.requestId !== frame.requestId || result.linkEpoch !== context.linkEpoch) throw new HubProtocolError("invalid");
      await link.send(result);
      if (frame.type === "reconcile" && result.type === "reconcile" && !result.payload.more) connection.ready = true;
    }
  }
  async send(fleetId: string, frame: HubServerFrame): Promise<void> {
    const connection = this.connections.get(fleetId);
    if (!connection?.ready || !connection.context.current() || frame.linkEpoch !== connection.context.linkEpoch
      || frame.type === "welcome" || frame.type === "question" && (frame.payload.identity.destinationFleetId !== fleetId || frame.payload.identity.issuer !== this.options.hubId)) throw new HubProtocolError("unavailable");
    await connection.link.send(frame);
  }
  /** The enabled optional features of a fleet's ready link, or null while it has none. */
  features(fleetId: string): ReadonlySet<string> | null {
    const connection = this.connections.get(fleetId);
    return connection?.ready && connection.context.current() ? connection.context.features : null;
  }
  fenceFleet(fleetId: string, reason: "replaced" | "revoked" = "replaced"): void { this.connections.get(fleetId)?.link.retire(reason); }
  fence(): void { this.stopped = true; for (const connection of [...this.connections.values()]) connection.link.end(); for (const socket of this.sockets) socket.destroy(); }
  async close(): Promise<void> {
    this.fence(); const server = this.server, wss = this.wss; this.server = null; this.wss = null;
    wss?.close(); if (server) await new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
  }
}
