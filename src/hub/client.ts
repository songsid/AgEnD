/** Outbound-only pinned member connection. Reconnect reconciles; it never repeats an input/tool operation. */
import { WebSocket } from "ws";
import { createPublicKey, randomUUID } from "node:crypto";
import { HUB_CAPABILITIES, HUB_LIMITS, HUB_PATHS, parseServerFrame, encodeMemberFrame } from "./protocol.js";
import { HubSocket } from "./socket.js";
import { HubProtocolError } from "./validation.js";
import { pinnedHubAgent, HubTlsIdentityError } from "./tls.js";
import { verifyLease, personKeyString } from "./identity.js";
import { HubMemberProfileStore, type HubMemberProfile } from "./profile.js";
import type { HubAuthorizationLease, HubAuthorizationRequest, HubMemberFrame, HubServerFrame, HubMemberTransport } from "./types.js";
export class HubAuthorizationError extends Error {
  constructor(readonly code: "denied" | "unavailable" | "stale", readonly reasonCode: string) { super(`Hub authorization ${code}`); }
}
export interface HubMemberLink {
  readonly linkEpoch: number; readonly revocationVersion: number; readonly profile: HubMemberProfile;
  current(): boolean;
  send(frame: HubMemberFrame): Promise<void>;
  exchange(frame: HubMemberFrame, responseType: HubServerFrame["type"]): Promise<HubServerFrame>;
}
interface Pending { expected: HubServerFrame["type"]; resolve(frame: HubServerFrame): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface HubClientOptions {
  home: string; hubId: string; memberOrigin: string; current(): boolean;
  /** Must durably reconcile the current revocation version and journal BEFORE returning. No input here. */
  reconcile(link: HubMemberLink): Promise<void>;
  receive(frame: Exclude<HubServerFrame, { type: "welcome" }>, link: HubMemberLink): Promise<void>;
  hold(code: "unavailable" | "invalid" | "backpressure" | "replaced" | "revoked" | "key-changed"): void;
  now?: () => number; random?: () => number;
}
export class HubMemberClient implements HubMemberTransport {
  private profile: HubMemberProfile | null = null;
  private link: HubSocket<HubServerFrame, HubMemberFrame> | null = null;
  private view: HubMemberLink | null = null;
  private pending = new Map<string, Pending>();
  private deferred: HubServerFrame[] = [];
  private deferredBytes = 0;
  private workTail = Promise.resolve();
  private queuedWork = 0;
  private queuedWorkBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private connecting = false;
  private opening: WebSocket | null = null;
  private ready = false;
  private epoch = 0;
  private revocation = 0;
  private firstResolve: (() => void) | null = null;
  private firstReject: ((error: Error) => void) | null = null;
  readonly bootId = randomUUID();
  constructor(private readonly options: HubClientOptions) {}
  private current(): boolean { return !this.stopped && this.options.current(); }
  async start(): Promise<void> {
    if (!this.current() || this.profile) throw new HubAuthorizationError("unavailable", "unavailable");
    this.profile = new HubMemberProfileStore(this.options.home, this.options.hubId).readProfile();
    if (this.profile.hub.memberOrigin !== this.options.memberOrigin) { this.options.hold("key-changed"); throw new HubAuthorizationError("stale", "stale"); }
    await new Promise<void>((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject; this.connect(); });
  }
  private connect(): void {
    if (!this.current() || !this.profile || this.connecting) return;
    this.connecting = true; this.ready = false; this.deferred = []; this.deferredBytes = 0;
    const profile = this.profile, handshake = randomUUID();
    const endpoint = new URL(HUB_PATHS.connect, profile.hub.memberOrigin); endpoint.protocol = "wss:";
    const agent = pinnedHubAgent(profile.hub, () => this.current());
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${profile.credential}` }, agent,
      followRedirects: false, handshakeTimeout: HUB_LIMITS.rpcTimeout, maxPayload: HUB_LIMITS.frame, perMessageDeflate: false });
    this.opening = ws;
    let connected = false, finished = false;
    const failed = (error?: unknown) => {
      if (finished) return; finished = true; this.connecting = false;
      if (this.opening === ws) this.opening = null;
      agent.destroy();
      if (!this.current()) return;
      if (error instanceof HubTlsIdentityError) { this.options.hold("key-changed"); this.stopped = true; }
      if (!connected) { if (!this.stopped) this.options.hold("unavailable"); this.firstReject?.(new HubAuthorizationError("unavailable", "unavailable")); this.firstReject = this.firstResolve = null; this.reconnect(); }
    };
    ws.once("error", failed); ws.once("close", () => failed());
    ws.once("open", () => {
      if (!this.current()) { ws.terminate(); return; } this.opening = null; connected = true; this.connecting = false;
      let link!: HubSocket<HubServerFrame, HubMemberFrame>;
      const handshakeTimer = setTimeout(() => link.end(), HUB_LIMITS.rpcTimeout); handshakeTimer.unref();
      link = new HubSocket(ws, { current: () => this.current() && this.link === link, parse: parseServerFrame, encode: encodeMemberFrame,
        receive: frame => this.receive(frame, link, handshake, handshakeTimer), closed: code => {
          clearTimeout(handshakeTimer);
          if (code === "replaced" || code === "revoked") this.stopped = true;
          if (this.link !== link) return;
          this.link = null; this.view = null; this.ready = false; this.deferred = []; this.deferredBytes = 0;
          this.rejectPending(); this.options.hold(code); this.firstReject?.(new HubAuthorizationError("unavailable", code)); this.firstReject = this.firstResolve = null; this.reconnect();
        } });
      this.link = link;
      void link.send({ v: 1, type: "hello", requestId: handshake, linkEpoch: 0,
        payload: { supportedVersions: [1], capabilities: [...HUB_CAPABILITIES], memberBootId: this.bootId } }).catch(() => link.end());
    });
  }
  private async receive(frame: HubServerFrame, link: HubSocket<HubServerFrame, HubMemberFrame>, handshake: string, timeout: NodeJS.Timeout): Promise<void> {
    if (!link.current()) return;
    if (!this.view) {
      if (frame.type !== "welcome" || frame.requestId !== handshake || frame.payload.hubId !== this.profile!.hub.hubId || frame.payload.fleetId !== this.profile!.fleetId
        || frame.linkEpoch !== frame.payload.linkEpoch || frame.payload.revocationVersion < this.revocation) throw new HubProtocolError("stale");
      clearTimeout(timeout); this.epoch = frame.linkEpoch; this.revocation = frame.payload.revocationVersion;
      const profile = this.profile!, epoch = this.epoch;
      const self = this;
      const view: HubMemberLink = { profile: structuredClone(profile), linkEpoch: epoch, get revocationVersion() { return self.revocation; },
        current: () => this.current() && this.link === link && this.view === view && this.epoch === epoch && link.current(),
        send: value => { if (!view.current() || value.linkEpoch !== epoch || value.type === "hello") return Promise.reject(new HubAuthorizationError("stale", "stale")); return link.send(value); },
        exchange: (value, type) => this.exchange(value, type, view) };
      this.view = view;
      // Do not await reconciliation on the receive queue: its RPC response arrives on that queue.
      void this.options.reconcile(view).then(async () => {
        if (!view.current()) return;
        this.ready = true; this.attempt = 0; this.firstResolve?.(); this.firstReject = this.firstResolve = null;
        const queued = this.deferred.splice(0); this.deferredBytes = 0;
        for (const waiting of queued) { if (!view.current()) return; await this.dispatch(waiting, view); }
      }).catch(error => link.end(error instanceof HubProtocolError && error.code === "backpressure" ? "backpressure" : "unavailable"));
      return;
    }
    const view = this.view;
    if (frame.type === "welcome" || frame.linkEpoch !== this.epoch) throw new HubProtocolError("stale");
    const pending = this.pending.get(frame.requestId);
    if (pending) {
      if (frame.type !== pending.expected) throw new HubProtocolError();
      clearTimeout(pending.timer); this.pending.delete(frame.requestId); pending.resolve(frame); return;
    }
    if (frame.type === "authorize.result" || frame.type === "reconcile") throw new HubProtocolError();
    if (!this.ready) {
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (this.deferred.length + this.queuedWork >= HUB_LIMITS.pending || this.deferredBytes + this.queuedWorkBytes + bytes > HUB_LIMITS.sendQueue) throw new HubProtocolError("backpressure");
      this.deferredBytes += bytes; this.deferred.push(frame); return;
    }
    await this.dispatch(frame, view);
  }
  private async dispatch(frame: HubServerFrame, view: HubMemberLink): Promise<void> {
    if (!view.current() || frame.type === "welcome") throw new HubProtocolError("stale");
    if (frame.type === "revoke") {
      if (frame.payload.revocationVersion < this.revocation) throw new HubProtocolError("stale");
      this.revocation = frame.payload.revocationVersion;
    }
    if (frame.type === "question") {
      // Admission awaits authorize() on this very socket. Queue work separately so its reply (or a
      // revocation) can be processed; never block the control receive queue behind external work.
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (this.queuedWork + this.deferred.length >= HUB_LIMITS.pending || this.queuedWorkBytes + this.deferredBytes + bytes > HUB_LIMITS.sendQueue) throw new HubProtocolError("backpressure");
      this.queuedWork++; this.queuedWorkBytes += bytes;
      this.workTail = this.workTail.then(async () => {
        if (view.current()) await this.options.receive(frame, view);
      }).catch(error => {
        if (view.current()) this.link?.end(error instanceof HubProtocolError && error.code === "backpressure" ? "backpressure" : "unavailable");
      }).finally(() => { this.queuedWork--; this.queuedWorkBytes -= bytes; });
      return;
    }
    await this.options.receive(frame, view);
  }
  private async exchange(frame: HubMemberFrame, expected: HubServerFrame["type"], view: HubMemberLink): Promise<HubServerFrame> {
    if (!view.current() || this.pending.has(frame.requestId) || this.pending.size >= HUB_LIMITS.pending) throw new HubAuthorizationError("unavailable", "backpressure");
    const result = new Promise<HubServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(frame.requestId); reject(new HubAuthorizationError("unavailable", "uncertain")); }, HUB_LIMITS.rpcTimeout); timer.unref();
      this.pending.set(frame.requestId, { expected, resolve, reject, timer });
    });
    void view.send(frame).catch(() => { const p = this.pending.get(frame.requestId); if (p) { clearTimeout(p.timer); this.pending.delete(frame.requestId); p.reject(new HubAuthorizationError("unavailable", "uncertain")); } });
    return result;
  }
  async send(frame: HubMemberFrame): Promise<void> {
    if (!this.ready || !this.view?.current()) throw new HubAuthorizationError("unavailable", "unavailable"); await this.view.send(frame);
  }
  async authorize(request: HubAuthorizationRequest): Promise<HubAuthorizationLease> {
    const view = this.view;
    if (!this.ready || !view?.current()) throw new HubAuthorizationError("unavailable", "unavailable");
    const result = await this.exchange({ v: 1, type: "authorize.request", requestId: randomUUID(), linkEpoch: this.epoch, payload: request }, "authorize.result", view);
    if (!view.current() || result.type !== "authorize.result") throw new HubAuthorizationError("stale", "stale");
    if (!result.payload.ok) throw new HubAuthorizationError("denied", result.payload.reasonCode);
    try { return verifyLease(result.payload.lease, request, { linkEpoch: this.epoch, revocationVersion: this.revocation, now: this.options.now?.() ?? Date.now() }); }
    catch { throw new HubAuthorizationError("stale", "stale"); }
  }
  private reconnect(): void {
    if (!this.current() || this.timer) return;
    const base = Math.min(30_000, 250 * 2 ** Math.min(this.attempt++, 7));
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, Math.floor(base * (1 + (this.options.random?.() ?? Math.random()) * 0.25))); this.timer.unref();
  }
  private rejectPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HubAuthorizationError("unavailable", "uncertain")); } this.pending.clear();
  }
  fence(): void {
    this.stopped = true; this.ready = false; if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.opening?.terminate(); this.opening = null; this.link?.end(); this.link = null; this.view = null; this.rejectPending(); this.firstReject?.(new HubAuthorizationError("unavailable", "unavailable")); this.firstReject = this.firstResolve = null;
  }
  async close(): Promise<void> { this.fence(); }
}
