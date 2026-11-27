import {HUB_ROOM_HISTORY_CAPABILITY} from "./room-history-model.js";
import { HUB_ROOM_REACT_ACK_CAPABILITY } from "./room-react-ack-model.js";
import { HUB_QUESTION_CLOSE_CAPABILITY } from "./question-close-model.js";
import {HUB_ROOM_ASKER_IDENTITY_CAPABILITY} from "./room-asker-identity-model.js";
import { HUB_DIRECT_POST_CAPABILITY } from "./direct-posts-model.js";
import {HUB_ROOM_ANSWER_STATUS_CAPABILITY} from "./room-answer-status-model.js";
import {HUB_ROOM_MEMBERS_CAPABILITY} from "./room-members-model.js";
import {HUB_ROOM_BRIEF_CAPABILITY} from "./room-brief-model.js";
import {HUB_AGENT_INTRO_CAPABILITY} from "./agent-intro-model.js";
import { HUB_AGENT_CHARACTERS_CAPABILITY, HUB_AGENT_PICTURES_CAPABILITY } from "./agent-pictures-model.js";
import { HUB_AGENT_CATALOG_CAPABILITY, HUB_AGENT_CATALOG_LAPSE_CAPABILITY, HUB_EXPOSURE_REQUEST_CAPABILITY } from "./agent-catalog-model.js";
import { HUB_ROOM_MENTION_FEEDBACK_CAPABILITY } from "./room-mention-feedback-model.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "./room-context-model.js";
/** Outbound-only pinned member connection. Reconnect reconciles; it never repeats an input/tool operation. */
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { HUB_ASKER_NAME_CAPABILITY, HUB_FLEET_UPDATE_CAPABILITY, HUB_CAPABILITIES, HUB_LIMITS, HUB_REVOCATION_FLOOR_HEADER, HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_BUTTONS_CAPABILITY, HUB_ROOM_POST_CAPABILITY, HUB_ROOM_REACT_CAPABILITY, HUB_PATHS, parseServerFrame, encodeMemberFrame } from "./protocol.js";
import { HubSocket } from "./socket.js";
import { HUB_RECOMMENDATION_CAPABILITY } from "./recommendation-model.js";
import { HUB_FLEET_INFO_CAPABILITY } from "./fleet-info.js";
import { HubProtocolError } from "./validation.js";
import { pinnedHubAgent, HubTlsIdentityError } from "./tls.js";
import { verifyLease, sha256, canonicalArguments } from "./identity.js";
import { HubMemberProfileStore, type HubMemberProfile } from "./profile.js";
import { HUB_WEB_ORIGIN_CAPABILITY, type HubWebOriginStatement } from "./web-origin.js";
import { HUB_MEMBER_RELOCATION_CAPABILITY } from "./member-origin.js";
import type { HubAuthorizationLease, HubAuthorizationRequest, HubMemberFrame, HubServerFrame, HubMemberTransport, HubMemberLeaveBinding } from "./types.js";
export class HubAuthorizationError extends Error {
  constructor(readonly code: "denied" | "unavailable" | "stale", readonly reasonCode: string) { super(`Hub authorization ${code}`); }
}
export interface HubMemberLink {
  readonly linkEpoch: number; readonly revocationVersion: number; readonly profile: HubMemberProfile;
  /** #3429 B: the member address this link actually dialled and authenticated (a pending relocation's `to`, or the anchor). */
  readonly endpoint: string;
  /** The optional features both ends listed: this member's offer ∩ the Hub's welcome (empty for an older Hub). */
  readonly features: ReadonlySet<string>;
  current(): boolean;
  send(frame: HubMemberFrame): Promise<void>;
  exchange(frame: HubMemberFrame, responseType: HubServerFrame["type"]): Promise<HubServerFrame>;
}
interface Pending { expected: HubServerFrame["type"]; resolve(frame: HubServerFrame): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface HubClientOptions {
  /** A mounted Fleet owns reconnects: a retryable first outage leaves it mounted offline. Direct callers still await a ready link. */
  allowOfflineStart?: boolean;
  log?(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  receiveRecommendations?: boolean;
  /** Explicit opt-in without another hello capability name. */
  roomContext?: boolean;
  agentIntro?: boolean;
  agentCatalog?: boolean;
  /** M-3533 R2b: report shared agents' pictures (agent-pictures-v1) when the Hub offers it. */
  agentPictures?: boolean;
  /** M-3533 R2c: this member sends its agents' own characters when the Hub offers agent-characters-v1. */
  agentCharacters?: boolean;
  exposureRequests?: boolean;
  roomMentionFeedback?: boolean;
  fleetInfo?: import("./types.js").HubFleetInfo;
  home: string; hubId: string; memberOrigin: string; current(): boolean;
  /** M-3205: the member's durable revocation floor (its journal's), sent on each connect so a restored Hub can catch up. */
  revocationFloor?(): number;
  /** Must durably reconcile the current revocation version and journal BEFORE returning. No input here. */
  reconcile(link: HubMemberLink): Promise<void>;
  receive(frame: Exclude<HubServerFrame, { type: "welcome" }>, link: HubMemberLink): Promise<void>;
  hold(code: "unavailable" | "invalid" | "backpressure" | "replaced" | "revoked" | "key-changed" | "rejected"): void;
  now?: () => number; random?: () => number;
  /** The optional features this member offers (tests use a smaller list to stand in for an older member). */
  capabilities?: readonly string[];
  /**
   * #3429 B: where to dial, in order — a pending relocation's `to` first, then the anchor (member-origin.ts). Each dial
   * is pinned to the profile's member key and checked against the origin actually dialled. Empty: a relocation state that
   * does not verify (fail closed: held, nothing dialled). Absent: the profile's member address, as before.
   */
  dial?(): string[];
  /**
   * web-origin-v1 (M-2901): the Hub's signed current web address from this link's welcome, before reconciliation. The
   * receiver verifies it against the pinned profile; whatever it does, the link goes on (a refusal is its own to record).
   */
  webOrigin?(statement: HubWebOriginStatement, link: HubMemberLink): Promise<void> | void;
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
  /** #3429 B: which of dial()'s addresses this attempt is on (a candidate that fails moves to the next one at once). */
  private dialIndex = 0;
  private legacyHello = false;
  private legacyTried = false;
  readonly bootId = randomUUID();
  constructor(private readonly options: HubClientOptions) {}
  private current(): boolean { return !this.stopped && this.options.current(); }
  async start(): Promise<void> {
    if (!this.current() || this.profile) throw new HubAuthorizationError("unavailable", "unavailable");
    this.profile = new HubMemberProfileStore(this.options.home, this.options.hubId).readProfile();
    // With dial() the anchor may differ from pairing.json's own address (a confirmed relocation); without it, as before.
    if (!this.options.dial && this.profile.hub.memberOrigin !== this.options.memberOrigin) { this.options.hold("key-changed"); throw new HubAuthorizationError("stale", "stale"); }
    await new Promise<void>((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject; this.connect(); });
  }
  private firstFailure(error: HubAuthorizationError, retryable: boolean): void {
    if (this.options.allowOfflineStart && retryable && this.current()) this.firstResolve?.();
    else this.firstReject?.(error);
    this.firstReject = this.firstResolve = null;
  }
  private connect(): void {
    if (!this.current() || !this.profile || this.connecting) return;
    this.connecting = true; this.ready = false; this.deferred = []; this.deferredBytes = 0;
    const profile = this.profile, handshake = randomUUID();
    const offered = [...(this.options.capabilities ?? HUB_OPTIONAL_CAPABILITIES)].filter(c => !this.legacyHello || c !== HUB_FLEET_UPDATE_CAPABILITY && c !== HUB_ASKER_NAME_CAPABILITY && c !== HUB_DIRECT_POST_CAPABILITY && c !== HUB_QUESTION_CLOSE_CAPABILITY && c !== HUB_ROOM_ASKER_IDENTITY_CAPABILITY);
    const origins = this.options.dial ? this.options.dial() : [profile.hub.memberOrigin];
    if (!origins.length) {                                       // a relocation state that does not verify: fail closed
      this.connecting = false; this.stopped = true; this.options.hold("key-changed");
      this.firstReject?.(new HubAuthorizationError("stale", "stale")); this.firstReject = this.firstResolve = null; return;
    }
    const index = Math.min(this.dialIndex, origins.length - 1), origin = origins[index]!, last = index === origins.length - 1;
    const endpoint = new URL(HUB_PATHS.connect, origin); endpoint.protocol = "wss:";
    const agent = pinnedHubAgent({ memberOrigin: origin, spkiSha256: profile.hub.spkiSha256 }, () => this.current());
    // M-3205: the durable floor rides on the upgrade so a restored Hub can catch up; an older Hub ignores the header.
    let floor = this.revocation; try { floor = Math.max(floor, this.options.revocationFloor?.() ?? 0); } catch { /* the journal answers on the next attempt */ }
    const headers: Record<string, string> = { Authorization: `Bearer ${profile.credential}`, ...(Number.isSafeInteger(floor) && floor > 0 ? { [HUB_REVOCATION_FLOOR_HEADER]: String(floor) } : {}) };
    const ws = new WebSocket(endpoint, { headers, agent,
      followRedirects: false, handshakeTimeout: HUB_LIMITS.rpcTimeout, maxPayload: HUB_LIMITS.frame, perMessageDeflate: false });
    this.opening = ws;
    let connected = false, finished = false;
    const failed = (error?: unknown) => {
      if (finished) return; finished = true; this.connecting = false;
      if (this.opening === ws) this.opening = null;
      agent.destroy();
      if (!this.current()) return;
      // #3429 B: a pending relocation's `to` that cannot be reached, or that does not hold the pinned key, is only a
      // candidate: try the next address now. Never after a refused credential (401/403: stopped) — that is recovery.
      if (!connected && !last && !this.stopped) { this.dialIndex++; this.connect(); return; }
      if (error instanceof HubTlsIdentityError) { this.options.hold("key-changed"); this.stopped = true; }
      if (!connected) { if (!this.stopped) this.options.hold("unavailable"); this.firstFailure(new HubAuthorizationError("unavailable", "unavailable"), !this.stopped); this.reconnect(); }
    };
    ws.once("unexpected-response", (_request, response) => {
      // TLS pinning already succeeded. Only an explicit authentication refusal is terminal; 5xx/overload stay outages.
      if (this.current() && (response.statusCode === 401 || response.statusCode === 403)) {
        this.stopped = true;
        this.options.hold("rejected");
        this.firstReject?.(new HubAuthorizationError("denied", "rejected")); this.firstReject = this.firstResolve = null;
      }
      response.destroy(); ws.terminate();
    });
    ws.once("error", failed); ws.once("close", () => failed());
    ws.once("open", () => {
      if (!this.current()) { ws.terminate(); return; } this.opening = null; connected = true; this.connecting = false;
      let link!: HubSocket<HubServerFrame, HubMemberFrame>;
      let welcomed = false;
      const handshakeTimer = setTimeout(() => link.end(), HUB_LIMITS.rpcTimeout); handshakeTimer.unref();
      link = new HubSocket(ws, { current: () => this.current() && this.link === link, parse: parseServerFrame, encode: encodeMemberFrame,
        receive: frame => { if (frame.type === "welcome") welcomed = true; return this.receive(frame, link, handshake, handshakeTimer, origin, offered); }, closed: code => {
          clearTimeout(handshakeTimer); const wasStopped = this.stopped, usable = this.ready;
          if (code === "replaced" || code === "revoked") this.stopped = true;
          if (this.link !== link) return;
          this.link = null; this.view = null; this.ready = false; this.deferred = []; this.deferredBytes = 0;
          // Exactly one retry on this same pinned pairing/endpoint, before trying another relocation address.
          if (!welcomed && !this.legacyTried && offered.includes(HUB_FLEET_UPDATE_CAPABILITY) && !this.stopped && this.current()) {
            this.legacyTried = true; this.legacyHello = true; this.rejectPending();
            try { this.options.log?.("info", "Retrying Hub connection with a legacy capability offer", { phase: "legacy-hello" }); } catch { /* diagnostics only */ }
            this.connect(); return;
          }
          // #3429 B: a pending `to` that upgraded but closed (or timed out) before a validated, reconciled welcome is still
          // only a candidate: try the next address now, as before the upgrade. Never after replaced/revoked (stopped), and
          // the anchor (last) never falls back.
          if (!usable && !last && !this.stopped && this.current()) { this.rejectPending(); this.dialIndex++; this.connect(); return; }
          this.rejectPending(); if (!wasStopped) this.options.hold(code); this.firstFailure(new HubAuthorizationError("unavailable", code), code === "unavailable" || code === "backpressure"); this.reconnect();
        } });
      this.link = link;
      void link.send({ v: 1, type: "hello", requestId: handshake, linkEpoch: 0,
        payload: { supportedVersions: [1], capabilities: [...HUB_CAPABILITIES, ...offered], memberBootId: this.bootId } }).catch(() => link.end());
    });
  }
  private async receive(frame: HubServerFrame, link: HubSocket<HubServerFrame, HubMemberFrame>, handshake: string, timeout: NodeJS.Timeout, endpoint: string, offered: readonly string[]): Promise<void> {
    if (!link.current()) return;
    if (!this.view) {
      if (frame.type === "welcome" && frame.requestId === handshake && frame.payload.hubId !== this.profile!.hub.hubId) {
        this.fence(); this.options.hold("key-changed"); return;
      }
      if (frame.type !== "welcome" || frame.requestId !== handshake || frame.payload.hubId !== this.profile!.hub.hubId || frame.payload.fleetId !== this.profile!.fleetId
        || frame.linkEpoch !== frame.payload.linkEpoch || frame.payload.revocationVersion < this.revocation) throw new HubProtocolError("stale");
      clearTimeout(timeout); this.epoch = frame.linkEpoch; this.revocation = frame.payload.revocationVersion;
      const profile = this.profile!, epoch = this.epoch;
      const self = this;
      const canReportInfo = offered.includes("welcome-caps-v1") && frame.payload.capabilities?.includes(HUB_FLEET_INFO_CAPABILITY) === true;
      const canReceiveRecommendation = canReportInfo && !!this.options.fleetInfo && this.options.receiveRecommendations === true && frame.payload.capabilities?.includes(HUB_RECOMMENDATION_CAPABILITY) === true;
      const features = new Set(offered.includes("welcome-caps-v1") ? offered.filter(c => frame.payload.capabilities?.includes(c)) : []);
      if(!features.has("welcome-caps-v1")||!features.has(HUB_ROOM_ASK_CAPABILITY))features.delete(HUB_ROOM_ASKER_IDENTITY_CAPABILITY);
      if(this.options.agentIntro && features.has("welcome-caps-v1") && frame.payload.capabilities?.includes(HUB_AGENT_INTRO_CAPABILITY))features.add(HUB_AGENT_INTRO_CAPABILITY);
      if (this.options.agentCatalog && features.has("welcome-caps-v1") && frame.payload.capabilities?.includes(HUB_AGENT_CATALOG_CAPABILITY)) features.add(HUB_AGENT_CATALOG_CAPABILITY);
      if (this.options.agentPictures && features.has("welcome-caps-v1") && frame.payload.capabilities?.includes(HUB_AGENT_PICTURES_CAPABILITY)) features.add(HUB_AGENT_PICTURES_CAPABILITY);
      if (this.options.agentCharacters && features.has(HUB_AGENT_PICTURES_CAPABILITY) && frame.payload.capabilities?.includes(HUB_AGENT_CHARACTERS_CAPABILITY)) features.add(HUB_AGENT_CHARACTERS_CAPABILITY);
      if (this.options.exposureRequests && features.has(HUB_AGENT_CATALOG_CAPABILITY) && frame.payload.capabilities?.includes(HUB_EXPOSURE_REQUEST_CAPABILITY)) features.add(HUB_EXPOSURE_REQUEST_CAPABILITY);
      // M-3543: the Hub takes a lapsed row and a Share again of a published agent (only with exposure requests).
      if (features.has(HUB_EXPOSURE_REQUEST_CAPABILITY) && frame.payload.capabilities?.includes(HUB_AGENT_CATALOG_LAPSE_CAPABILITY)) features.add(HUB_AGENT_CATALOG_LAPSE_CAPABILITY);
      if (this.options.roomContext && features.has(HUB_ROOM_ASK_CAPABILITY) && frame.payload.capabilities?.includes(HUB_ROOM_CONTEXT_CAPABILITY)) features.add(HUB_ROOM_CONTEXT_CAPABILITY);
      if(features.has(HUB_ROOM_ASK_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_ANSWER_STATUS_CAPABILITY))features.add(HUB_ROOM_ANSWER_STATUS_CAPABILITY);
      if(features.has(HUB_ROOM_ASK_CAPABILITY)&&features.has(HUB_ROOM_REACT_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_REACT_ACK_CAPABILITY))features.add(HUB_ROOM_REACT_ACK_CAPABILITY);
      if(features.has(HUB_ROOM_POST_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_HISTORY_CAPABILITY))features.add(HUB_ROOM_HISTORY_CAPABILITY);
      if(features.has(HUB_ROOM_POST_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_MEMBERS_CAPABILITY))features.add(HUB_ROOM_MEMBERS_CAPABILITY);
      if(features.has(HUB_ROOM_CONTEXT_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_BRIEF_CAPABILITY))features.add(HUB_ROOM_BRIEF_CAPABILITY);
      if(this.options.roomMentionFeedback&&features.has(HUB_ROOM_ASK_CAPABILITY)&&frame.payload.capabilities?.includes(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY))features.add(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY);
      if (canReceiveRecommendation) (features as Set<string>).add(HUB_RECOMMENDATION_CAPABILITY);
      const view: HubMemberLink = { profile: structuredClone(profile), linkEpoch: epoch, endpoint, features, get revocationVersion() { return self.revocation; },
        current: () => this.current() && this.link === link && this.view === view && this.epoch === epoch && link.current(),
        send: value => {
          if (!view.current() || value.linkEpoch !== epoch || value.type === "hello") return Promise.reject(new HubAuthorizationError("stale", "stale"));
          if (value.type === "question.close" && !features.has(HUB_QUESTION_CLOSE_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if(value.type === "agent.intro" && !features.has(HUB_AGENT_INTRO_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if ((value.type === "agent.pictures" || value.type === "agent.picture") && !features.has(HUB_AGENT_PICTURES_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "agent.catalog" && !features.has(HUB_AGENT_CATALOG_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "agent.catalog" && value.payload.requests && !features.has(HUB_EXPOSURE_REQUEST_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if ((value.type === "exposure.request-result" || value.type === "exposure.undo") && !features.has(HUB_EXPOSURE_REQUEST_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if(value.type==="room.answer"&&value.payload.notAnswered&&!features.has(HUB_ROOM_ANSWER_STATUS_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if(value.type==="room.history"&&!features.has(HUB_ROOM_HISTORY_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if(value.type==="room.members"&&value.payload.v2&&!features.has(HUB_ROOM_MEMBERS_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if(value.type==="room.context-state"&&value.payload.brief&&!features.has(HUB_ROOM_BRIEF_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if ((value.type === "room.context-state" || value.type === "room.context-input") && !features.has(HUB_ROOM_CONTEXT_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if((value.type==="room.answer"||value.type==="room.post")&&value.payload.mentionFeedback&&!features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY))return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "fleet.recommendation-ack" && !canReceiveRecommendation) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "fleet.update-status" && !features.has(HUB_FLEET_UPDATE_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "fleet.info" && value.payload.updatesAllowed !== undefined && !features.has(HUB_FLEET_UPDATE_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "fleet.info" && !canReportInfo) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "exposure.quota" && !features.has("quota-band-v1")) return Promise.reject(new HubAuthorizationError("unavailable", "incompatible"));
          if ((value.type === "room.answer" || value.type === "agent.state") && (!features.has(HUB_ROOM_ASK_CAPABILITY) || !features.has("welcome-caps-v1"))) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "room.answer" && value.payload.buttons && !features.has(HUB_ROOM_BUTTONS_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "room.react" && value.payload.acknowledge && !features.has(HUB_ROOM_REACT_ACK_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "room.react" && (!features.has(HUB_ROOM_REACT_CAPABILITY) || !features.has(HUB_ROOM_ASK_CAPABILITY))) return Promise.reject(new HubProtocolError("incompatible"));
          if (value.type === "room.post" && (value.payload.direct || value.payload.attachments) && !features.has(HUB_DIRECT_POST_CAPABILITY)) return Promise.reject(new HubProtocolError("incompatible"));
          if ((value.type === "room.history" || value.type === "room.list" || value.type === "room.post" || value.type === "room.members" || value.type === "people.search" || value.type === "room.post-answer-ack") && (!features.has(HUB_ROOM_POST_CAPABILITY) || !features.has(HUB_ROOM_ASK_CAPABILITY) || !features.has("welcome-caps-v1"))) return Promise.reject(new HubProtocolError("incompatible"));
          return link.send(value);
        },
        exchange: (value, type) => this.exchange(value, type, view) };
      this.view = view;
      // Do not await reconciliation on the receive queue: its RPC response arrives on that queue.
      const statement = features.has(HUB_WEB_ORIGIN_CAPABILITY) ? frame.payload.webOrigin : undefined, learn = this.options.webOrigin;
      const learned = statement && learn ? Promise.resolve().then(() => view.current() ? learn(statement, view) : undefined).catch(() => undefined) : Promise.resolve();
      void learned.then(async () => {
        if (canReportInfo && this.options.fleetInfo && view.current()) await view.send({ v: 1, type: "fleet.info", requestId: randomUUID(), linkEpoch: epoch, payload: { version: this.options.fleetInfo.version, runsAsService: this.options.fleetInfo.runsAsService, ...(features.has(HUB_FLEET_UPDATE_CAPABILITY) && this.options.fleetInfo.updatesAllowed !== undefined ? { updatesAllowed: this.options.fleetInfo.updatesAllowed } : {}), ...(canReceiveRecommendation ? { recommendations: true as const } : {}) } });
        await this.options.reconcile(view);
      }).then(async () => {
        if (!view.current()) return;
        this.ready = true; this.attempt = 0; this.dialIndex = 0; this.firstResolve?.(); this.firstReject = this.firstResolve = null;
        const queued = this.deferred.splice(0); this.deferredBytes = 0;
        for (const waiting of queued) { if (!view.current()) return; await this.dispatch(waiting, view); }
      }).catch(error => link.end(error instanceof HubProtocolError && error.code === "backpressure" ? "backpressure" : "unavailable"));
      return;
    }
    const view = this.view;
    if (frame.type === "welcome" || frame.linkEpoch !== this.epoch) throw new HubProtocolError("stale");
    // Negotiation is checked before resolving RPCs as well as before dispatching unsolicited work.
    if ((frame.type === "exposure.request" || frame.type === "exposure.request-ack" || frame.type === "exposure.undo-result")
      && !view.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY)) throw new HubProtocolError("incompatible");
    if(frame.type === "agent.intro-result" && !view.features.has(HUB_AGENT_INTRO_CAPABILITY))throw new HubProtocolError("incompatible");
    if ((frame.type === "agent.pictures-result" || frame.type === "agent.picture-result") && !view.features.has(HUB_AGENT_PICTURES_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "room.react-result" && (!view.features.has(HUB_ROOM_REACT_CAPABILITY) || !view.features.has(HUB_ROOM_ASK_CAPABILITY) || frame.payload.acknowledged && !view.features.has(HUB_ROOM_REACT_ACK_CAPABILITY))) throw new HubProtocolError("incompatible");
    if(frame.type==="room.history-result"&&!view.features.has(HUB_ROOM_HISTORY_CAPABILITY))throw new HubProtocolError("incompatible");
    const pending = this.pending.get(frame.requestId);
    // The Hub can retry its request while our result waits for an ACK with the same operation id.
    if (pending && !(frame.type === "exposure.request" && pending.expected === "exposure.request-ack")) {
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
    if(frame.type==="room.members-result"&&frame.payload.ok&&"v2" in frame.payload&&!view.features.has(HUB_ROOM_MEMBERS_CAPABILITY))throw new HubProtocolError("incompatible");
    if (frame.type === "question.close-result" && !view.features.has(HUB_QUESTION_CLOSE_CAPABILITY)) throw new HubProtocolError("incompatible");
    if(frame.type==="question"&&frame.payload.askerName!==undefined&&!view.features.has(HUB_ASKER_NAME_CAPABILITY))throw new HubProtocolError("incompatible");
    if(frame.type==="room.ask"&&frame.payload.askerIdentity&&!view.features.has(HUB_ROOM_ASKER_IDENTITY_CAPABILITY))throw new HubProtocolError("incompatible");
    if(frame.type==="room.ask"&&frame.payload.brief&&!view.features.has(HUB_ROOM_BRIEF_CAPABILITY))throw new HubProtocolError("incompatible");
    if ((frame.type === "room.context-state-result" || frame.type === "room.context-input-result"
      || frame.type === "room.ask" && !!frame.payload.contextState) && !view.features.has(HUB_ROOM_CONTEXT_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "agent.catalog-refresh" && !view.features.has(HUB_AGENT_CATALOG_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "exposure.request" && !view.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "pairing.notice" && (!view.features.has("pairing-notices-v1") || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if (frame.type === "pairing.notice-v2" && (!view.features.has("pairing-notices-v2") || !view.features.has("pairing-notices-v1") || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if (frame.type === "pairing.notice-v3" && (!view.features.has("pairing-notices-v3") || !view.features.has("pairing-notices-v1") || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if ((frame.type === "fleet.update" || frame.type === "fleet.update-cancel" || frame.type === "fleet.update-status-ack") && !view.features.has(HUB_FLEET_UPDATE_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "fleet.recommendation" && !view.features.has(HUB_RECOMMENDATION_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (frame.type === "relocate" && (!view.features.has(HUB_MEMBER_RELOCATION_CAPABILITY) || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if ((frame.type === "room.ask" || frame.type === "room.answer-ack") && (!view.features.has(HUB_ROOM_ASK_CAPABILITY) || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if (frame.type === "room.react-result" && (!view.features.has(HUB_ROOM_REACT_CAPABILITY) || !view.features.has(HUB_ROOM_ASK_CAPABILITY))) throw new HubProtocolError("incompatible");
    if(!view.features.has(HUB_DIRECT_POST_CAPABILITY)&&((frame.type==="room.list-result"&&frame.payload.ok&&frame.payload.rooms.some(r=>r.kind))||(frame.type==="room.post-result"&&frame.payload.message)))throw new HubProtocolError("incompatible");
    if ((frame.type === "room.history-result" || frame.type === "room.list-result" || frame.type === "room.post-result" || frame.type === "room.members-result" || frame.type === "people.search-result" || frame.type === "room.post-answer") && (!view.features.has(HUB_ROOM_POST_CAPABILITY) || !view.features.has(HUB_ROOM_ASK_CAPABILITY) || !view.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");
    if (frame.type === "revoke") {
      if (frame.payload.revocationVersion < this.revocation) throw new HubProtocolError("stale");
      this.revocation = frame.payload.revocationVersion;
    }
    if (frame.type === "question") {
      if (frame.payload.identity.issuer !== view.profile.hub.hubId || frame.payload.identity.issuerKeyId !== view.profile.issuerKeyId) {
        this.fence(); this.options.hold("key-changed"); return;
      }
    }
    if (frame.type === "question" || frame.type === "room.ask") {
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
  /** Best-effort narrowing for this exact saved binding. True means socket-written, never a durable remote ACK. */
  async leave(expected: HubMemberLeaveBinding): Promise<boolean> {
    try {
      const view = this.view, profile = this.profile;
      if (!this.ready || !view?.current() || !profile || expected.hubId !== profile.hub.hubId
        || !view.features.has("member-leave-v1") || !view.features.has("welcome-caps-v1")) return false;
      const store = new HubMemberProfileStore(this.options.home, expected.hubId), digest = store.profileDigest();
      if (!digest || expected.binding !== sha256(JSON.stringify(["agend-hub-binding-v1", expected.hubId, digest]))
        || canonicalArguments(store.readProfile()) !== canonicalArguments(profile) || !view.current()) return false;
      await view.send({ v: 1, type: "member.leave", requestId: randomUUID(), linkEpoch: view.linkEpoch, payload: {} });
      return true;
    } catch { return false; }
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
    this.dialIndex = 0;                                          // each new attempt starts at the first candidate again
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
