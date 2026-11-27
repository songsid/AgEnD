import type { HubHeldCloseOutcome } from "../question-close-model.js";
import { HUB_QUESTION_CLOSE_CAPABILITY } from "../question-close-model.js";
import {HubRoomAskerStore} from "../member/room-asker-store.js";
import {HUB_ROOM_ASKER_IDENTITY_CAPABILITY} from "../room-asker-identity-model.js";
import { HubDirectRooms } from "../member/direct-rooms.js";
import { HUB_DIRECT_POST_CAPABILITY } from "../direct-posts-model.js";
import {HubMemberAgentIntro} from "../member/agent-intro.js";
import { HUB_MEMBER_SHARING_MIGRATION, HubMemberSharingJournal } from "../member/sharing-journal.js";
import { HubMemberSharing } from "../member/sharing.js";
import { HubMemberSharingLink } from "../member/sharing-link.js";
import { sharingNotice } from "../member/sharing-result.js";
import { HubMemberAgentCatalog, memberAgentCatalog, hubPageSharingEnabled, type MemberCatalogAgent } from "../member/agent-catalog.js";
import { HubMemberAgentPictures, type MemberPictureSources } from "../member/agent-pictures.js";
import { cropInWorker, reduceInWorker } from "../../hub-picture-reduce.js";
import {HubRoomMentionFeedback,HUB_ROOM_MENTION_FEEDBACK_MIGRATION,verifyRoomMentionFeedback} from "../member/room-mention-feedback.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY} from "../room-mention-feedback-model.js";
/**
 * S5b member factory (S-51 PR 2b; docs/design/hub-composition.md §5 "Member"). Called by S1's HubMount for an enabled
 * hub_member, and only for a current, non-disconnected binding (S3c's pairing state). Builds, in order:
 *   member DB + every migration → floors and keys (first creation only) → member-local audit → S1 journal (its
 *   restricted outbox forwards to S4 once S4 exists) → S3c exposure store → S4 restricted execution (+ the optional
 *   S4b provider, only when the owner configured one) → recover() → S1 admission + client with #3116's handshake and
 *   S5's receive routing → the exposure API and Needs-you attention attached to the fleet.
 * Either the whole service comes back or nothing stays open; unconfirmed cleanup stays owned (drain()).
 * The data-view registry comes from a HubViewSource: EMPTY until the owner-approval flow exists (§7 Q2), so nothing
 * is publishable or askable — fail closed.
 */
import { createHash, createPublicKey, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import type Database from "better-sqlite3";
import { createHubAudit, HUB_AUDIT_MIGRATION, type HubAuditStore } from "../audit/index.js";
import {
  applyHubMigrations,
  bindHubInstance,
  HUB_INSTANCE_MIGRATION,
  HubStateError,
  inspectStateSet,
  openHubDatabase,
  type HubHoldCode,
  type HubStateSet,
} from "../db.js";
import type { HubMountedService } from "../mount.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { HubMemberAdmissionAdapter } from "../admission.js";
import { HubMemberClient, type HubMemberLink } from "../client.js";
import { HUB_MEMBER_JOURNAL_MIGRATION, HubMemberJournal, type HubRestrictedOutbox } from "../member-journal.js";
import { createHubMemberHandshake } from "../member-reconciliation.js";
import { HubMemberProfileStore, type HubMemberProfile } from "../profile.js";
import { createHubWebOriginRecorder, learnHubWebOrigin, HubMemberWebOriginStore } from "../web-origin.js";
import { HubMemberRelocationStore, acceptHubRelocation, completeRelocationPin, knownMemberOrigins, promoteHubRelocation } from "../member-origin.js";
import { CompanyTrustStore } from "../join/trust.js";
import { createQuotaPublisher } from "../member/quota.js";
import { HubFileVersionFloor } from "../version-floor.js";
import type { HubAuditRecord, HubServerFrame } from "../types.js";
import { EMPTY_VIEW_SOURCE, type HubViewSource } from "./views.js";
import { HUB_REPRESENTATIVE_MIGRATION, HubAskerNames, HubRepresentativeExecution, type HubReportOutcome, type HubRepresentativeDelivery } from "../representative.js";
import { HUB_PROVIDER_SETUP_REASONS, hubProviderSetupReason, type HubProviderSetupReason } from "../execution/provider-setup.js";
import { HubMemberUpdates, HUB_MEMBER_UPDATES_MIGRATION, type MemberUpdatesOptions } from "../member/updates.js";
import { IDLE_UPDATE_MIGRATION } from "../../update-idle.js";
import { createPublishedVersionLookup } from "../published-version.js";
import { HubMemberRecommendations, HUB_MEMBER_RECOMMENDATION_MIGRATION } from "../member/recommendations.js";
import { readHubDisplayName } from "../display-name.js";
import { refreshHubDisplayName } from "../member/display-name.js";
import { HubMemberFiles } from "../member/attachments.js";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../member/pairing-notices.js";
import { HUB_ASKER_NAME_CAPABILITY, HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY, HUB_FLEET_UPDATE_CAPABILITY } from "../protocol.js";
import { createRoomStatePublisher, HubRoomAskAdapter, HUB_ROOM_ASK_MIGRATION, HUB_ROOM_CONTEXT_RECEIPTS_MIGRATION, verifyRoomAskJournal,
  type AgentStateInput, type RoomAskLink, type RoomStateLink } from "../member/room-ask.js";
import { HubRoomPostAdapter, isShareLapsed, verifyRoomPostJournal } from "../member/room-post.js";
import { HubProtocolError } from "../validation.js";

/** The legacy location remains assigned to its first proven binding; later pairings get separate complete sets. */
export function memberSet(hubId: string, profile?: Pick<HubMemberProfile, "fleetId" | "owner" | "issuerKeyId">): HubStateSet {
  const scope = profile ? createHash("sha256").update(JSON.stringify(["agend-member-binding-v1", hubId, profile.issuerKeyId,
    profile.fleetId, profile.owner.realm, profile.owner.objectId])).digest("hex") : null;
  const base = `hub-member/${hubId}${scope ? `/bindings/${scope}` : ""}`;
  return Object.freeze({
    database: `${base}/member.sqlite`,
    floors: Object.freeze([`${base}/floors/journal`, `${base}/floors/execution`, `${base}/floors/s3c-exposures`]),
    keys: Object.freeze([`${base}/keys/journal.key`, `${base}/keys/content.key`]),
  });
}

type Execution = typeof import("../execution/index.js");
type Exposures = typeof import("../member/exposures.js");
type ExposureApi = typeof import("../member/exposure-api.js");

/** The slices the member side needs, imported lazily inside the factory. Missing: hub-incomplete, before any I/O. */
export interface HubMemberComponents {
  execution?: () => Promise<Execution>;
  exposures?: () => Promise<{ store: Exposures; api: ExposureApi }>;
  /** S4b: only consulted when the owner configured hub_member.execution.provider. */
  provider?: () => Promise<{
    createHubCliProvider: typeof import("../execution/cli-provider.js").createHubCliProvider;
    createHubModelBroker: typeof import("../execution/model-broker.js").createHubModelBroker;
  }>;
}

export interface HubMemberFactoryOptions {
  updates?: Pick<MemberUpdatesOptions, "canInstall" | "launch" | "active" | "outcome" | "idle" | "notify" | "busy" | "onQueue">;
  attachUpdates?(updates: HubMemberUpdates | null): void;
  fleetInfo?: import("../types.js").HubFleetInfo;
  versionRegistry?: import("../published-version.js").PublishedVersionLookup;
  attachRecommendations?(read: (() => import("../recommendation-model.js").HubRecommendedUpdate | null) | null): void;
  recommendationChanged?(): void;
  home: string;
  components: HubMemberComponents;
  /** S3c's current binding (its pairing state): the Hub id, or null when unpaired or disconnected. */
  boundHub(): string | null;
  /** The owner's local agents, each with the S4 provider it would run under (null: none). */
  agents(): import("../member/exposure-api.js").HubMemberAgent[];
  catalogAgents?(): MemberCatalogAgent[];
  /** M-3533 R2b: an agent's pictures as its owner's Fleet shows them (the sidebar's disc, the identity card's portrait). */
  pictureSources?(agent: string): MemberPictureSources;
  sharingNotice?(notice: import("../../hub-sharing-notice.js").HubSharingNotice): Promise<boolean>;
  attachSharing?(controller: import("../../hub-sharing-notice.js").HubSharingController | null): void;
  /** Current Fleet message-body limit, applied to room history rendering only. */
  maxCrossInstanceMessageBytes?(): number | undefined;
  views?: HubViewSource;
  /** P1's representative mode: the fleet's ordinary delivery, the agent lifecycle token and the report_result hook. */
  representative: HubRepresentativeHost;
  attachAgentIntro?(port: import("../member/agent-intro.js").AgentIntroPort|null):void;
  attachAgentRooms?(port: import("../member/room-post.js").AgentRoomPort | null): void;
  /** M-3543: which shared agents' shares lapsed (their backend/folder changed since they were shared). */
  attachShareLapse?(port: { lapsed(agent: string): boolean; agents(): string[] } | null): void;
  roomToolsChanged?(): void;
  roomConversationGeneration?(agent: string): string | null;
  attachRoomOwed?(port:{replyWarning(agent:string):string|undefined;turnEnded(agent:string,generation:string,turn:string):Promise<void>}|null):void;
  attachRoomAskers?(port: Pick<HubRoomAskAdapter,"verifiedAsker"> | null): void;
  attachRoomInputs?(handler: ((correlationId: string, agent: string, generation: string) => void) | null): void;
  roomReceipt?(caller: import("../member/room-post.js").RoomCaller, receiptId: string): import("../member/room-post-receipt.js").RoomReceiptProof | null;
  roomNotify?(input: import("../member/room-post-answers.js").RoomPostNotification): Promise<boolean>;
  /**
   * M-3313 (#4145): what a Hub question, room ask or room post's answer carries, the moment this link receives it — before
   * it is journaled or waits for its agent — so a sign-in token pasted there is taken back at once, not at delivery
   * (which may be late, or never). The Fleet only looks (its delivery hides the token from the agent); it changes nothing.
   */
  sawText?(text: string): void;
  attachExposures(api: import("../member/exposure-api.js").HubMemberExposureApi | null): void;
  /** M-3632: `retry` sends one held question back through the Hub's checks (Needs you → "Try again"). */
  attachAttention(read: (() => import("../../needs-you.js").HubExecutionAttentionInput[]) | null, retry?: (id: string) => "queued" | "not-found" | "not-retryable", close?: (id: string) => Promise<HubHeldCloseOutcome>): void;
  /** Security inbox is available to the current binding's local Settings page, on chat and web-only fleets. */
  attachPairingNotices?(read: (() => import("../types.js").HubPairingNotice[]) | null): void;
  pokeAttention(): void;
  /** The member link as S3c's pairing view shows it: online after reconciliation; refused/invalid saved links remain visible for their exact profile. */
  linkState?(state: "online" | "offline" | "revoked" | "rejected", profileDigest?: string | null): void;
  report(code: HubHoldCode, detail: string): void;
  /**
   * A non-fatal hold while the member keeps running (the provider could not be set up: every exposure stays
   * unavailable). `reason` is a bounded setup reason (PROVIDER_SETUP_REASONS) for localized guidance.
   */
  notice?(code: HubHoldCode, reason: ProviderSetupReason, detail: string): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
}

export interface HubRepresentativeHost {
  /** Derive only a coarse band from this agent's local CLI/profile. Never hands exact usage to the Hub layer. */
  quota?(agent: string): Promise<import("../types.js").HubQuota>;
  /** Room composition opt-in: cached Fleet state only, no pane probe or vendor request. */
  readState?(agent: string): AgentStateInput | Promise<AgentStateInput>;
  locale?: "en" | "zh-TW";
  /** Ordinary cross-instance delivery to the published agent, with beforeInput run immediately before the IPC hand-off. */
  deliver(input: HubRepresentativeDelivery): Promise<boolean>;
  /** S-244: while an update barrier is up, Hub and room producers leave their rows queued. */
  updateHeld?: () => boolean;
  /** The agent's current lifecycle token (null: not a deliverable agent now). */
  agentToken(agent: string): string | null;
  /** M-3632: the waits before asking the Hub again after it could not answer before input (default HUB_BEGIN_RETRY_MS). */
  beginRetryMs?: readonly number[];
  /** attachments-v1: the agent's inbox for a question's files and its own paths for an answer's (absent: no files). */
  files?: import("../member/attachments.js").HubMemberFilesOptions;
  /** The report_result hook for HUB_REPORT_TARGET and the pane-failure hook for its correlation ids (null: detached). */
  attachReports(
    handler: ((input: { correlationId: string; caller: string; text: string; callerCurrent(): boolean; requestScope?:import("../../request-hub-output.js").RequestHubOutputScope; extras?: import("../../hub-report-target.js").HubReportExtras }) => Promise<HubReportOutcome> | null) | null,
    failed: ((correlationId: string, agent: string) => void) | null,
  ): void;
  /** Private Classic input may reopen room output only after its Hub work has ended and a fresh idle proof. */
  attachPrivateQuestions?(read: ((agent: string) => boolean) | null): void;
  /** M-3660: whether a Hub question is no longer being answered, so its contact window ends (null: detached). */
  attachQuestionSettled?(read: ((agent: string, correlationId: string) => boolean) | null): void;
  /** M-3127: the `react` hook for a room question's correlation id (null: detached). Absent: this Fleet has none. */
  attachReacts?(handler: ((input: { correlationId: string; caller: string; emoji: string; callerCurrent(): boolean; requestScope?:import("../../request-hub-output.js").RequestHubOutputScope }) => Promise<HubReportOutcome> | null) | null): void;
}

/** Ordered cleanup that stops at the first unconfirmed step (same rules as the server factory). */
class Teardown {
  private readonly steps: { name: string; run: () => unknown; done: boolean }[] = [];
  add(name: string, run: () => unknown): void {
    this.steps.push({ name, run, done: false });
  }
  async run(): Promise<void> {
    for (let i = this.steps.length - 1; i >= 0; i -= 1) {
      const step = this.steps[i]!;
      if (step.done) continue;
      try {
        await step.run();
        step.done = true;
      } catch (err) {
        throw new HubStateError("service-unavailable", `Hub member cleanup of ${step.name} is unconfirmed: ${(err as Error).message}`);
      }
    }
  }
}

function createKeyFile(home: string, rel: string): void {
  ensurePrivateDirectory(home, rel.slice(0, rel.lastIndexOf("/")));
  const fd = openSync(`${home}/${rel}`, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("base64"));
  } finally {
    closeSync(fd);
  }
}
function readKey(home: string, rel: string): Buffer {
  const key = Buffer.from(readPrivateFile(home, rel, 256).trim(), "base64");
  if (key.length !== 32) throw new HubStateError("hub-storage", `${rel} is not a 32-byte key`);
  return key;
}

/** Bounded provider-setup reasons: S4's own list (src/hub/execution/provider-setup.ts); S4 owns the guidance text. */
export const PROVIDER_SETUP_REASONS = HUB_PROVIDER_SETUP_REASONS;
export type ProviderSetupReason = HubProviderSetupReason;
export class HubProviderSetupError extends HubStateError {
  constructor(readonly reason: ProviderSetupReason, message: string) {
    super("hub-provider-unavailable", message);
    this.name = "HubProviderSetupError";
  }
}
/** The bounded reason of any provider-setup failure: S4b's typed `.reason` when it is one of ours, else "unavailable". */
export function providerSetupReason(err: unknown): ProviderSetupReason {
  if (err instanceof HubProviderSetupError) return err.reason;
  return hubProviderSetupReason(err) ?? "unavailable";
}

const PROVIDER_KEYS = new Set(["backend", "imageId", "model", "credentialRef", "dockerSocket"]);
interface ProviderConfig {
  backend: "claude" | "codex";
  imageId: string;
  model: string;
  credentialRef: string;
  dockerSocket?: string;
}

/** hub_member.execution.provider, strictly (agreed with S4b, hub-s54-provider-composition). Absent: null. */
export function providerConfig(cfg: Record<string, unknown>, hubId: string): ProviderConfig | null {
  const execution = cfg.execution;
  if (execution === undefined) return null;
  const provider = execution && typeof execution === "object" ? (execution as Record<string, unknown>).provider : undefined;
  if (provider === undefined) return null;
  const p = provider as Record<string, unknown>;
  const bad = (why: string, reason: ProviderSetupReason = "unavailable"): never => {
    throw new HubProviderSetupError(reason, `hub_member.execution.provider: ${why}`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("must be an object");
  for (const k of Object.keys(p)) if (!PROVIDER_KEYS.has(k)) bad(`unknown setting "${k}"`);
  if (p.backend !== "claude" && p.backend !== "codex") bad('backend must be "claude" or "codex"');
  if (typeof p.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.imageId)) bad("imageId must be sha256:<64 hex>", "image-unconfigured");
  if (typeof p.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(p.model)) bad("model is not a model id");
  if (p.credentialRef !== `file:hub-member/${hubId}/secrets/model-api`) bad(`credentialRef must be file:hub-member/${hubId}/secrets/model-api`, "credential-unconfigured");
  if (p.dockerSocket !== undefined && (typeof p.dockerSocket !== "string" || !/^\/(var\/)?run\/[A-Za-z0-9._/-]+\.sock$/.test(p.dockerSocket))) {
    bad("dockerSocket must be a local unix socket under /var/run or /run");
  }
  return p as unknown as ProviderConfig;
}

const execAction = (kind: string) => `execution.${kind.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`.slice(0, 128);

/**
 * The member's captured binding for S4 (and S1 admission): the pairing's identity plus the link it was captured on.
 * relink() starts a new generation for every (re)connect; a binding captured earlier then reads current() === false,
 * as it does after fence(). S4 keeps binding objects across awaits, so this is what fences its in-flight work.
 */
export function createMemberBinding(deps: {
  hubId: string;
  profile: Pick<HubMemberProfile, "issuerKeyId" | "fleetId" | "owner" | "hub">;
  live(): boolean;
  revocationFloor(): number;
}) {
  let generation = 0;
  let link: HubMemberLink | null = null;
  const issuerPublicKey = createPublicKey(deps.profile.hub.issuerPublicKey);
  return {
    relink(l: HubMemberLink): void {
      link = l;
      generation += 1;
    },
    fence(): void {
      generation += 1;
    },
    link: () => link,
    binding() {
      const gen = generation;
      const captured = link;
      return Object.freeze({
        hubId: deps.hubId,
        issuerKeyId: deps.profile.issuerKeyId,
        issuerPublicKey,
        fleetId: deps.profile.fleetId,
        owner: deps.profile.owner,
        revocationVersion: captured?.revocationVersion ?? deps.revocationFloor(),
        generation: gen,
        linkEpoch: captured?.linkEpoch ?? 0,
        current: () => deps.live() && generation === gen && (captured === null || (link === captured && captured.current())),
      });
    },
  };
}

/**
 * S5's receive routing for the member link (agreed with S1, hub-s51-compose): question → admit → the receipt on the
 * same link, answering the question's own requestId; revoke → fence; receipt (the Hub's ACK) → journal.acknowledge;
 * anything else is refused. Never ordinary fleet delivery.
 */
/** M-3313: hand a received frame's content to the Fleet's look (sawText) — never throwing into the link's routing. */
function seen(saw: ((text: string) => void) | undefined, payload: unknown): void {
  if (!saw) return;
  try { saw(JSON.stringify(payload)); } catch { /* a look that fails must not refuse the frame */ }
}

export function createMemberReceive(deps: {
  admission: Pick<HubMemberAdmissionAdapter, "admit" | "fence">;
  journal: Pick<HubMemberJournal, "acknowledge">;
  live(): boolean;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  notices?: { receive: ReturnType<typeof createHubPairingNoticeInbox>["receive"] };
  /** M-3007: the snapshot sender's record of a policy refusal (what the owner's Settings shows). */
  publicationRefused?(requestId: string, code: string): void;
  /** #3429 B: a `relocate` statement on this link (member-relocation-v1): kept durably, then acked on the same link. */
  relocate?(statement: unknown, requestId: string, l: HubMemberLink): Promise<void>;
  /** M-3313: see HubMemberFactoryOptions.sawText. */
  sawText?(text: string): void;
  /** M-3594: where a 1:1 question's Hub-verified asker name waits for the representative's hand-off. */
  askerNames?: Pick<HubAskerNames, "remember">;
}) {
  return async (frame: Exclude<HubServerFrame, { type: "welcome" }>, l: HubMemberLink): Promise<void> => {
    if (!deps.live() || !l.current()) return;
    if (frame.type === "question") {
      seen(deps.sawText, frame.payload);
      // M-3594: the Hub's display name for the asker stays in memory only. The journal keeps the question exactly as an older
      // build parses it (its strict schema would refuse the field after a rollback).
      const { askerName, ...question } = frame.payload;
      if (askerName !== undefined) deps.askerNames?.remember(question.identity.messageId, askerName);
      const receipt = await deps.admission.admit(question);
      if (!l.current()) return;
      await l.send({ v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: l.linkEpoch, payload: receipt });
      return;
    }
    if (frame.type === "revoke") return deps.admission.fence(frame.payload);
    if (frame.type === "receipt") return deps.journal.acknowledge(frame.payload);
    if (frame.type === "error" && (frame.payload.code === "denied" || frame.payload.code === "unavailable")) {
      // The Hub may refuse publication independently of the saved member credential.
      // Keep local consent pending; this feedback grants no remote publication or execution.
      deps.log("warn", "Hub publication not accepted", { code: frame.payload.code });
      deps.publicationRefused?.(frame.requestId, frame.payload.code);
      return;
    }
    if ((frame.type === "pairing.notice" || frame.type === "pairing.notice-v2" || frame.type === "pairing.notice-v3") && deps.notices) return deps.notices.receive(frame.payload, l);
    if (frame.type === "relocate" && deps.relocate) return deps.relocate(frame.payload, frame.requestId, l);
    deps.log("warn", "Hub frame not expected on the member", { type: frame.type });
    throw new HubStateError("service-unavailable", `unexpected ${frame.type} frame`);
  };
}

/** Open at most two candidates. A partial/corrupt selected set never falls back to fresh state. */
function openMemberState(options: {
  home: string; hubId: string; profile: HubMemberProfile; execution: Execution; exposureStore: Exposures;
  views: HubViewSource; outbox: HubRestrictedOutbox; now(): number; current(): boolean;
}) {
  const { home, hubId, profile, execution, exposureStore, now } = options;
  const scoped = memberSet(hubId, profile);
  const candidates = inspectStateSet(home, scoped) === "complete" ? [scoped] : [memberSet(hubId), scoped];
  for (const set of candidates) {
    if (!options.current()) throw new HubStateError("hub-member-pairing", "the pairing changed before opening its state");
    const state = inspectStateSet(home, set);
    const db = openHubDatabase(home, set.database, { create: state === "new" });
    let selected = false;
    try {
      const [journalFloor, executionFloor, exposureFloor] = set.floors.map(f => new HubFileVersionFloor(home, f));
      if (state === "new") {
        for (const floor of [journalFloor!, executionFloor!, exposureFloor!]) floor.initialize();
        for (const key of set.keys) createKeyFile(home, key);
      }
      applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION, HUB_MEMBER_JOURNAL_MIGRATION,
        { component: "s4-execution", version: 1, up: execution.migrateHubExecution }, exposureStore.HUB_EXPOSURE_MIGRATION,
        HUB_REPRESENTATIVE_MIGRATION, HUB_PAIRING_INBOX_MIGRATION, HUB_ROOM_ASK_MIGRATION, HUB_ROOM_CONTEXT_RECEIPTS_MIGRATION, HUB_MEMBER_RECOMMENDATION_MIGRATION, IDLE_UPDATE_MIGRATION, HUB_MEMBER_UPDATES_MIGRATION,HUB_ROOM_MENTION_FEEDBACK_MIGRATION,HUB_MEMBER_SHARING_MIGRATION]);
      bindHubInstance(db, hubId, state, now());
      // P1 never initialized S4, so its absent meta row is valid only with the untouched zero floor.
      const executionMeta = db.prepare("SELECT revision FROM hub_execution_meta WHERE singleton=1").get() as { revision: number } | undefined;
      if ((executionMeta?.revision ?? 0) !== executionFloor!.read()) throw new HubStateError("hub-state-mismatch", "the execution database and floor disagree");
      const audit = createHubAudit({ db, contentKey: readKey(home, set.keys[1]!), now });
      const journal = new HubMemberJournal(db, { hubId, encryptionKey: readKey(home, set.keys[0]!), floor: journalFloor!, outbox: options.outbox, now });
      const exposures = new exposureStore.HubExposureStore(db, { floor: exposureFloor!, audit,
        binding: () => ({ owner: profile.owner, fleetId: profile.fleetId }), views: options.views.load(), now });
      if (state === "new") { journal.initialize(); exposures.initialize(); }
      const roomBinding = memberSet(hubId, profile).database;
      const roomKey = Buffer.from(hkdfSync("sha256", readKey(home, set.keys[1]!), Buffer.alloc(0),
        Buffer.from(JSON.stringify(["agend-hub-room-journal-key-v1", roomBinding])), 32));
      const postKey = Buffer.from(hkdfSync("sha256", readKey(home, set.keys[1]!), Buffer.alloc(0),
        Buffer.from(JSON.stringify(["agend-hub-room-post-key-v1", roomBinding])), 32));
      const feedbackKey=Buffer.from(hkdfSync("sha256",readKey(home,set.keys[1]!),Buffer.alloc(0),Buffer.from(JSON.stringify(["agend-hub-room-feedback-key-v1",roomBinding])),32));
      if (!db.transaction(() => {
        // An unbound legacy set must authenticate room history before bindPairing can advance its durable floor.
        const meta = db.prepare("SELECT binding FROM hub_member_meta WHERE singleton=1").get() as { binding: string | null };
        if (meta.binding === null) {
          verifyRoomPostJournal({db,binding:roomBinding,encryptionKey:postKey});
          verifyRoomAskJournal(db, { bindingKey: roomBinding, encryptionKey: roomKey });
          verifyRoomMentionFeedback({db,binding:roomBinding,encryptionKey:feedbackKey});
        }
        if (!journal.bindPairing(profile, exposures.list())) return false;
        verifyRoomPostJournal({db,binding:roomBinding,encryptionKey:postKey});
        verifyRoomAskJournal(db, { bindingKey: roomBinding, encryptionKey: roomKey });
        verifyRoomMentionFeedback({db,binding:roomBinding,encryptionKey:feedbackKey});
        return true;
      }).immediate()) {
        if (set.database === scoped.database) throw new HubStateError("hub-state-mismatch", "the scoped member database belongs to another pairing");
        continue; // Proven legacy mismatch only. Keep that entire state set, including its floors and keys.
      }
      if (!options.current()) throw new HubStateError("hub-member-pairing", "the pairing changed while opening its state");
      selected = true;
      return { db, journal, exposures, audit, roomKey, postKey, feedbackKey, roomBinding };
    } finally { if (!selected) db.close(); }
  }
  throw new HubStateError("hub-state-mismatch", "no member state belongs to this pairing");
}

/**
 * Disconnect while the member side is not running (held, or never composed): withdraw every published exposure in the
 * member's own store, so consent never outlives the disconnect (a later re-pair to the same Hub republishes nothing).
 * Never composed (no member state): nothing was published. A partial set throws (the disconnect reports "unsaved").
 */
export async function withdrawMemberExposuresOffline(home: string, hubId: string, now: () => number = Date.now): Promise<number> {
  const legacy = memberSet(hubId);
  if (!existsSync(`${home}/hub-member/${hubId}/pairing.json`)) {
    if (inspectStateSet(home, legacy) === "new") return 0;
    throw new HubStateError("hub-member-pairing", "the saved member state has no pairing");
  }
  const profiles = new HubMemberProfileStore(home, hubId), profile = profiles.readProfile(), digest = profiles.profileDigest();
  const scoped = memberSet(hubId, profile);
  if (inspectStateSet(home, scoped) === "new" && inspectStateSet(home, legacy) === "new") return 0;
  const [store, execution] = await Promise.all([import("../member/exposures.js"), import("../execution/index.js")]);
  const { db, exposures } = openMemberState({ home, hubId, profile, execution, exposureStore: store,
    views: EMPTY_VIEW_SOURCE, outbox: { insert: () => { throw Error("offline"); }, lookup: () => { throw Error("offline"); } }, now,
    current: () => profiles.profileDigest() === digest });
  try {
    let withdrawn = 0;
    for (const row of exposures.list()) {
      const committed = row.committed;
      if (committed && committed.exposure.state === "published") {
        exposures.withdraw(committed.exposure.id, committed.exposure.revision);
        withdrawn += 1;
      }
    }
    return withdrawn;
  } finally { db.close(); }
}

export function createHubMemberFactory(options: HubMemberFactoryOptions) {
  const now = options.now ?? Date.now;
  const views = options.views ?? EMPTY_VIEW_SOURCE;
  let unconfirmed: Teardown | null = null;

  const createMember = async function createMember(cfg: Record<string, unknown>, current: () => boolean): Promise<HubMountedService> {
    if (unconfirmed) {
      try {
        await unconfirmed.run();
        unconfirmed = null;
      } catch (err) {
        options.report("service-unavailable", (err as Error).message);
        throw err;
      }
    }
    const teardown = new Teardown();
    const fail = async (err: unknown): Promise<never> => {
      try {
        await teardown.run();
      } catch (cleanupErr) {
        unconfirmed = teardown;
        options.report("service-unavailable", (cleanupErr as Error).message);
        throw cleanupErr;
      }
      options.report(err instanceof HubStateError ? err.code : "service-unavailable", (err as Error).message);
      throw err;
    };
    try {
      const catalogEnabled = hubPageSharingEnabled(cfg);
      // 0. Every slice present and a current binding, before any I/O.
      if (!options.components.execution || !options.components.exposures) {
        throw new HubStateError("hub-incomplete", "the Hub member side (S4 / S3c) is not in this build");
      }
      const hubId = options.boundHub();
      if (!hubId) throw new HubStateError("hub-member-pairing", "this fleet is not paired with a Hub (or was disconnected)");
      let profile: HubMemberProfile;
      try {
        profile = new HubMemberProfileStore(options.home, hubId).readProfile();
      } catch (err) {
        throw new HubStateError("hub-member-pairing", `the Hub pairing is missing or invalid: ${(err as Error).message}`);
      }
      const profileDigest = new HubMemberProfileStore(options.home, hubId).profileDigest();
      let terminalHold = false;
      const reportLink = (state: "online" | "offline" | "revoked" | "rejected") => options.linkState?.(state, profileDigest);
      const [execution, exposureMods] = await Promise.all([options.components.execution(), options.components.exposures()]);

      // Bind the whole set BEFORE recovery, snapshot publication, attention or outbox attachment.
      let outbox: HubRestrictedOutbox | null = null;
      const forwarding: HubRestrictedOutbox = {
        insert: (...args) => {
          if (!outbox) throw new HubStateError("service-unavailable", "the restricted outbox is not ready");
          return outbox.insert(...args);
        },
        lookup: (...args) => {
          if (!outbox) throw new HubStateError("service-unavailable", "the restricted outbox is not ready");
          return outbox.lookup(...args);
        },
      };
      const profileCurrent = () => current() && options.boundHub() === hubId
        && new HubMemberProfileStore(options.home, hubId).profileDigest() === profileDigest;
      const { db, journal, exposures, audit, roomKey, postKey, feedbackKey, roomBinding } = openMemberState({ home: options.home, hubId, profile, execution,
        exposureStore: exposureMods.store, views, outbox: forwarding, now, current: profileCurrent });
      teardown.add("the member database", () => db.close());
      if ((cfg as { execution?: { provider?: unknown } }).execution?.provider !== undefined) {
        options.log("info", "hub_member.execution.provider is ignored: P1 Hub answers come from the published agent (representative mode)");
      }
      let fenced = false;
      const live = () => !fenced && current();
      const links = createMemberBinding({
        hubId,
        profile,
        live,
        revocationFloor: () => journal.revocationVersion(),
      });
      const binding = links.binding;
      let client: HubMemberClient | null = null;
      let online: HubMemberLink | null = null;
      const hubName = () => readHubDisplayName(options.home, profile) || new URL(profile.hub.webOrigin).hostname;
      let displayRequest: AbortController | null = null, displayKick: NodeJS.Immediate | null = null;
      const stopDisplay = () => { if (displayKick) clearImmediate(displayKick); displayKick = null; displayRequest?.abort(); displayRequest = null; };
      const learnDisplay = (l: HubMemberLink) => {
        stopDisplay();
        const controller = displayRequest = new AbortController();
        // The client completes ready in its microtask queue first. Optional metadata never delays startup/reconciliation.
        displayKick = setImmediate(() => {
          displayKick = null;
          void refreshHubDisplayName({ home: options.home, profile, endpoint: l.endpoint,
            current: () => live() && l.current() && profileCurrent(), signal: controller.signal }).then(changed => {
              if (changed && live() && l.current() && profileCurrent()) { options.recommendationChanged?.(); options.pokeAttention(); }
            }).catch(() => {}).finally(() => { if (displayRequest === controller) displayRequest = null; });
        }); displayKick.unref();
      };
      teardown.add("Hub display metadata", stopDisplay);
      // M-3125: one file handler for the 1:1 representative and the room asks (the inbox and the reply rule are the same).
      const memberFiles = options.representative.files ? new HubMemberFiles(options.representative.files) : undefined;
      const askerNames = new HubAskerNames();
      const directRooms = new HubDirectRooms(db);
      const service = new HubRepresentativeExecution({
        db,hubId,
        journal,
        askerName: (messageId) => askerNames.get(messageId),directRooms,
        binding,
        localExposure: (id) => exposures.localExposure(id),
        agentToken: (agent) => options.representative.agentToken(agent),
        authorize: (request) => (client ? client.authorize(request) : Promise.reject(new HubStateError("service-unavailable", "not connected"))),
        link: () => (online && online.current() && links.link() === online ? online : null),
        deliver: (input) => options.representative.deliver(input),
        ...(options.representative.updateHeld ? { updateHeld: options.representative.updateHeld } : {}),
        ...(options.representative.beginRetryMs ? { beginRetryMs: options.representative.beginRetryMs } : {}),
        ...(memberFiles ? { files: memberFiles } : {}),
        audit: (event, database) =>
          audit.appendInTransaction(
            {
              id: randomBytes(16).toString("hex"),
              sequence: 0,
              at: now(),
              requestId: event.messageId ?? "s5-representative",
              actor: { kind: "local-host" },
              action: event.action,
              result: event.result,
              policyVersion: 0,
              ...(event.messageId ? { messageId: event.messageId } : {}),
              ...(event.exposureId ? { exposureId: event.exposureId } : {}),
              ...(event.reasonCode ? { reasonCode: event.reasonCode.slice(0, 64) } : {}),
            } as HubAuditRecord,
            database,
          ),
        attentionChanged: () => options.pokeAttention(),
        log: options.log,
        now,
      });
      teardown.add("the representative adapter", () => service.close());
      service.recover();
      outbox = service.restrictedOutbox();

      const roomCurrent = () => live() && profileCurrent() && !terminalHold;
      const feedback=new HubRoomMentionFeedback({db,binding:roomBinding,encryptionKey:feedbackKey,locale:options.representative.locale,
        current:source=>{
          if(!roomCurrent()||!online?.current()||!online.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY))return false;
          const local=exposures.localExposure(source.exposureId);
          return !!local&&local.agent===source.agent&&local.exposure.state==="published"&&local.exposure.revision===source.revision&&local.consentId===source.consentId
            &&options.representative.agentToken(source.agent)===source.token&&service.readiness(source.exposureId,source.revision).ok;
        },deliver:input=>options.roomNotify?.(input)??Promise.resolve(false),held:id=>options.log("warn","Hub mention feedback delivery held",{notificationId:id}),
        ...(options.representative.updateHeld ? { updateHeld: options.representative.updateHeld } : {})});
      const receiveFeedback=feedback.receive.bind(feedback);
      const askerStore=options.representative.readState ? new HubRoomAskerStore({home:options.home,binding:roomBinding,encryptionKey:roomKey,now,
        identity:{hubId,issuerKeyId:profile.issuerKeyId,issuerPublicKey:createPublicKey(profile.hub.issuerPublicKey),fleetId:profile.fleetId}}) : undefined;
      teardown.add("room author provenance",()=>askerStore?.close());
      const room = new HubRoomAskAdapter({ hubId,askerStore,db,now,attentionChanged:options.pokeAttention, bindingKey: roomBinding, encryptionKey: roomKey, current: roomCurrent,
        locale: options.representative.locale, generation: options.roomConversationGeneration,feedback:receiveFeedback,
        maxCrossInstanceMessageBytes: options.maxCrossInstanceMessageBytes,remind:options.roomNotify,
        localExposure: id => {
          if (!roomCurrent()) return null;
          const local = exposures.localExposure(id);
          if (!local || !service.readiness(id, local.exposure.revision).ok) return null;
          const consent = db.prepare("SELECT agent,token FROM hub_representative_consents WHERE consent_id=?").get(local.consentId) as { agent: string; token: string } | undefined;
          if (!consent || consent.agent !== local.agent || options.representative.agentToken(local.agent) !== consent.token) return null;
          return { agent: local.agent, consentId: local.consentId, revision: local.exposure.revision, token: consent.token, contactLimit: local.contactLimit !== false };
        },
        deliver: input => options.representative.deliver(input), ...(memberFiles ? { files: memberFiles } : {}),
        ...(options.representative.updateHeld ? { updateHeld: options.representative.updateHeld } : {}) });
      // M-3543: a published share whose consent no longer matches its agent — the agent's backend or folder changed since
      // it was shared (#3147: consent never carries over). Only this case: no share, no link or no token is not "lapsed".
      const shareLapsed = (agent: string): boolean => {
        try {
          const local = exposures.list().find(row => row.agent === agent)?.committed;
          if (!local || local.exposure.state !== "published") return false;
          const consent = db.prepare("SELECT agent,token FROM hub_representative_consents WHERE consent_id=?").get(local.consentId) as {agent:string;token:string}|undefined;
          return isShareLapsed(agent, local, consent, options.representative.agentToken(agent));
        } catch { return false; }
      };
      const lapsedAgents = (): string[] => exposures.list().flatMap(row => shareLapsed(row.agent) ? [row.agent] : []);
      const posts = new HubRoomPostAdapter({hubId,db,binding:roomBinding,encryptionKey:postKey,current:roomCurrent,lapsed:shareLapsed,files:memberFiles,directRoom:(room,local)=>directRooms.has(room,local.exposureId,local.token),rememberDirectRoom:(room,local)=>directRooms.remember(`listed:${local.exposureId}:${room}`,room,local.exposureId,local.token),
        receipt: options.roomReceipt,feedback:receiveFeedback,
        notify: options.roomNotify,
        ...(options.representative.updateHeld ? { updateHeld: options.representative.updateHeld } : {}),
        held: id => options.log("warn", "Hub room reply delivery held", {notificationId:id}),
        changed: () => options.roomToolsChanged?.(),
        local: agent => {
          if (!roomCurrent()) return null;
          const row = exposures.list().find(row => row.agent === agent), local = row?.committed;
          if (!local || local.exposure.state !== "published") return null;
          const consent = db.prepare("SELECT agent,token FROM hub_representative_consents WHERE consent_id=?").get(local.consentId) as {agent:string;token:string}|undefined;
          if (!consent || consent.agent !== agent || options.representative.agentToken(agent) !== consent.token) return null;
          return {exposureId:local.exposure.id,revision:local.exposure.revision,consentId:local.consentId,token:consent.token};
        }});
      const roomExposures = () => exposures.list().flatMap(row => row.committed?.exposure.state === "published"
        ? [{ exposureId: row.committed.exposure.id, agent: row.agent }] : []);
      const roomState = createRoomStatePublisher({
        exposures: roomExposures,
        read: agent => options.representative.readState!(agent),
      });
      const roomLinks = new WeakMap<HubMemberLink, RoomAskLink & RoomStateLink>();
      const roomLink = (l: HubMemberLink) => {
        let view = roomLinks.get(l);
        if (!view) {
          const version = l.revocationVersion;
          view = { features: l.features,linkEpoch:l.linkEpoch,
            current: () => roomCurrent() && online === l && links.link() === l && l.current() && l.revocationVersion === version,
            contextState: async payload => { const result=await l.exchange({v:1,type:"room.context-state",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload},"room.context-state-result");
              if(result.type!=="room.context-state-result")throw new HubProtocolError("invalid");return result.payload; },
            contextInput: async payload => { const result=await l.exchange({v:1,type:"room.context-input",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload},"room.context-input-result");
              if(result.type!=="room.context-input-result")throw new HubProtocolError("invalid");return result.payload; },
            sendAnswer: payload => l.send({ v: 1, type: "room.answer", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload:{...payload,...(options.roomNotify&&l.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY)?{mentionFeedback:true as const}:{})} }),
            // M-3125 (room files, roomFilesNegotiated): the 1:1 chat's own file frames, on this link.
            fetchFile: async (id: string, offset: number) => { const reply = await l.exchange({ v: 1, type: "attachment.get", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { id, offset } }, "attachment.chunk");
              if (reply.type !== "attachment.chunk") throw new HubProtocolError("invalid"); return reply.payload; },
            putFile: async (chunk: import("../types.js").HubAttachmentChunk) => { const ack = await l.exchange({ v: 1, type: "attachment.put", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: chunk }, "attachment.ack");
              if (ack.type !== "attachment.ack" || ack.payload.id !== chunk.id || ack.payload.offset !== chunk.offset) throw new HubProtocolError("uncertain"); },
            sendState: payload => l.send({ v: 1, type: "agent.state", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload }),
            sendReact: async payload => { const result = await l.exchange({ v: 1, type: "room.react", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload }, "room.react-result");
              if(result.type!=="room.react-result"||result.payload.messageId!==payload.messageId)throw new HubProtocolError("invalid"); return result.payload; } };
          roomLinks.set(l, view);
        }
        return view;
      };
      let roomTimer: NodeJS.Timeout | null = null;
      const stopRooms = () => { if (roomTimer) clearInterval(roomTimer); roomTimer = null; room.connected(null); roomState.connected(null); posts.connected(null); };
      const refreshRooms = () => {feedback.flush();return Promise.all([room.flush(), roomState.refresh(), posts.flushAnswers(), room.refreshContexts(roomExposures())]).then(() => undefined);};
      let postLink: import("../member/room-post.js").RoomPostLink | null = null;
      const startRooms = (l: HubMemberLink) => {
        stopRooms();
        if (!options.representative.readState || !l.features.has(HUB_ROOM_ASK_CAPABILITY) || !l.features.has("welcome-caps-v1")) return;
        const view = roomLink(l); room.connected(view); roomState.connected(view);
        if (options.attachAgentRooms && options.roomNotify) posts.connected(postLink={features:l.features,current:view.current,
          putFile:async chunk=>{const ack=await l.exchange({v:1,type:"attachment.put",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:chunk},"attachment.ack");if(ack.type!=="attachment.ack"||ack.payload.id!==chunk.id)throw new HubProtocolError("invalid");},
          list: async exposureId => {
            const result = await l.exchange({v:1,type:"room.list",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId}},"room.list-result");
            if (result.type !== "room.list-result") throw new HubProtocolError("invalid");
            return result.payload;
          },
          post: async payload => {
            const result = await l.exchange({v:1,type:"room.post",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{...payload,...(!payload.direct&&options.roomNotify&&l.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY)?{mentionFeedback:true as const}:{})}},"room.post-result");
            if (result.type !== "room.post-result") throw new HubProtocolError("invalid");
            return result.payload;
          },
          history:async(exposureId,room,options)=>{
            const result=await l.exchange({v:1,type:"room.history",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId,room,...options}},"room.history-result");
            if(result.type!=="room.history-result")throw new HubProtocolError("invalid");return result.payload;
          },
          members: async (exposureId,room,options) => {
            const result=await l.exchange({v:1,type:"room.members",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId,room,...options}},"room.members-result");
            if(result.type!=="room.members-result")throw new HubProtocolError("invalid");return result.payload;
          },
          people: async (exposureId,q) => {
            const result=await l.exchange({v:1,type:"people.search",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId,q}},"people.search-result");
            if(result.type!=="people.search-result")throw new HubProtocolError("invalid");return result.payload;
          },
          ack: id => l.send({v:1,type:"room.post-answer-ack",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{id}}),
        });
        roomTimer = setInterval(() => { void refreshRooms().catch(() => {}); }, 5_000); roomTimer.unref();
        void refreshRooms().catch(() => {});
      };
      teardown.add("room asks and presence", () => { stopRooms(); feedback.close(); posts.close(); roomState.close(); room.close(); });

      // 6. S1 admission + client: #3116's handshake on (re)connect, S5's receive routing.
      const sender = exposureMods.store.exposureSnapshotSender(exposures);
      const quota = createQuotaPublisher({
        exposures: () => exposures.list().flatMap(row => row.committed?.exposure.state === "published"
          ? [{ exposureId: row.committed.exposure.id, agent: row.agent }] : []),
        read: agent => options.representative.quota?.(agent) ?? Promise.resolve({ band: "unknown" }),
        now,
      });
      teardown.add("quota updates", () => quota.stop());
      const handshake = createHubMemberHandshake({ journal, publishSnapshot: (l) => sender.publishSnapshot(l) });
      const admission = new HubMemberAdmissionAdapter({
        journal,
        transport: { start: async () => {}, send: (f) => client!.send(f), authorize: (r) => client!.authorize(r), close: async () => {} },
        binding: () => {
          const captured = links.link();
          return { profile, linkEpoch: captured?.linkEpoch ?? 0, revocationVersion: captured?.revocationVersion ?? journal.revocationVersion(), current: () => live() && !!captured && links.link() === captured && captured.current() };
        },
        exposure: (id) => exposures.exposure(id),
        fenceLocal: (messageId) => service.fence(messageId),
        hold: (messageId, reason) => options.log("warn", "Hub question held", { messageId, reason }),
        now,
      });
      const reportedInfo = options.fleetInfo ? { ...options.fleetInfo } : undefined;
      const reportUpdateConsent = () => {
        if (!updates || !reportedInfo) return;
        reportedInfo.updatesAllowed = updates.consent().on;
        const l = online;
        // fleet-info-v1 is a Hub-only offer, absent from the member's intersection. send() checks its welcome proof.
        if (l?.current() && l.features.has(HUB_FLEET_UPDATE_CAPABILITY))
          void l.send({ v: 1, type: "fleet.info", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { ...reportedInfo,
            ...(l.features.has("fleet-recommend-v1") ? { recommendations: true as const } : {}) } }).catch(() => {});
      };
      const updates = options.updates && reportedInfo ? new HubMemberUpdates({ ...options.updates, db, binding: profileDigest ?? roomBinding,
        get hubName() { return hubName(); }, version: reportedInfo.version, current: () => live() && !terminalHold && profileCurrent(),
        service: () => reportedInfo.runsAsService, now, lookup: options.versionRegistry ?? createPublishedVersionLookup(), changed: reportUpdateConsent }) : null;
      if (updates && reportedInfo) reportedInfo.updatesAllowed = updates.consent().on;
      let updateTimer: ReturnType<typeof setInterval> | null = null;
      teardown.add("Fleet updates", () => { if (updateTimer) clearInterval(updateTimer); updates?.close(); options.attachUpdates?.(null); });
      const recommendations = options.fleetInfo ? new HubMemberRecommendations({ db, hubId,
        get hubName() { return hubName(); }, version: options.fleetInfo.version, current: live, now,
        lookup: options.versionRegistry, changed: options.recommendationChanged, log: options.log }) : null;
      options.attachRecommendations?.(recommendations ? () => recommendations.view() : null);
      if (recommendations?.view()) options.recommendationChanged?.();
      teardown.add("version advice", () => { recommendations?.close(); options.attachRecommendations?.(null); options.recommendationChanged?.(); });
      const notices = createHubPairingNoticeInbox({ db, audit, current: live, now,
        changed: () => options.pokeAttention() });
      options.attachPairingNotices?.(() => notices.list());
      teardown.add("security notices", () => options.attachPairingNotices?.(null));
      // #3429 B: the member-address relocation (member-origin.ts). The audit is this member's own; the web address the
      // Hub's pages are at now is #3797's, bound to every member address this Fleet trusts.
      const recorder = (l: HubMemberLink) => createHubWebOriginRecorder({ db, audit, now, fleetId: profile.fleetId, policyVersion: () => l.revocationVersion });
      const relocations = new HubMemberRelocationStore(options.home, hubId), trust = new CompanyTrustStore(options.home);
      const trustedMemberOrigins = () => knownMemberOrigins(options.home, profile, profileDigest);
      const webNow = () => new HubMemberWebOriginStore(options.home, hubId).effective(profile, trustedMemberOrigins());
      if (profileDigest) {
        try { completeRelocationPin(options.home, profile, profileDigest, webNow(), live, trust); }
        catch (err) { options.log("warn", "A company pin left behind by a relocation was not completed", { error: (err as Error).message }); }
      }
      const receive = createMemberReceive({ admission, journal, live, log: options.log, notices, sawText: options.sawText, askerNames,
        publicationRefused: (requestId, code) => sender.refused(requestId, code),
        relocate: async (statement, requestId, l) => {
          if (!live() || !l.current() || !profileDigest) return;
          let out: ReturnType<typeof acceptHubRelocation>;
          try {
            out = acceptHubRelocation({ home: options.home, profile, profileDigest, webOrigins: [webNow()], current: () => live() && l.current(),
              log: options.log, record: recorder(l) }, statement);
          } catch (err) {
            // Not recorded or not kept: no ack (the Hub then revokes this Fleet's credential and it reconnects).
            options.log("warn", "The Hub's relocation was not kept", { error: (err as Error).message }); return;
          }
          if ("ack" in out && l.current()) await l.send({ v: 1, type: "relocate.ack", requestId, linkEpoch: l.linkEpoch, payload: out.ack });
        } });
      const intro = new HubMemberAgentIntro({current:roomCurrent,lapsed:shareLapsed,exposures:()=>exposures.list().flatMap(row=>{const e=row.committed?.exposure;const agent=(options.catalogAgents?.()??[]).find(a=>a.instance===row.agent);const consent=row.committed&&db.prepare("SELECT agent,token FROM hub_representative_consents WHERE consent_id=?").get(row.committed.consentId) as {agent:string;token:string}|undefined;return e&&e.state==="published"&&agent&&consent?.agent===row.agent&&options.representative.agentToken(row.agent)===consent.token?[{agent:row.agent,id:e.id,revision:e.revision,description:agent.description}]:[];})});
      options.attachAgentIntro?.(intro);
      teardown.add("agent introductions",()=>{intro.close();options.attachAgentIntro?.(null);});
      const api = exposureMods.api.createHubMemberExposureApi({
        store: exposures,
        // P1 representative agent (docs/design/hub-representative-agent.md): the owner shares a configured agent.
        agents: options.agents,
        afterCommit: async () => { const result = await sender.afterCommit(); void refreshRooms().catch(() => {}); void intro.defaults(); return result; },
        refused: () => sender.isRefused(),
        lapsed: agent => shareLapsed(agent),
        // S5's readiness: the agent's lifecycle token, recorded against the consent inside S3c's atomic publish.
        readinessCandidate: (candidate) => service.readinessCandidate(candidate),
      });
      const catalogAgents = () => (options.catalogAgents?.() ?? []).map(agent => {
        const exposure = exposures.list().find(row => row.agent === agent.instance)?.committed?.exposure;
        return { ...agent, exposure: exposure ? { id: exposure.id, revision: exposure.revision, state: exposure.state } : null };
      });
      const sharingLive = () => live() && profileCurrent();
      const sharingJournal = new HubMemberSharingJournal({ db, binding: roomBinding, owner: profile.owner, fleetId: profile.fleetId,
        agentToken: options.representative.agentToken, current: sharingLive, now });
      const sharing = options.catalogAgents && options.sharingNotice && options.attachSharing ? new HubMemberSharing({
        journal: sharingJournal, store: exposures, api, current: sharingLive, now, enabled: () => catalogEnabled,
        agents: catalogAgents, catalog: (): ReturnType<typeof memberAgentCatalog> => memberAgentCatalog(catalogEnabled, catalogEnabled ? catalogAgents() : [], true,
          catalog?.lapseActive() ? agent => shareLapsed(agent) : undefined),
        lapsed: agent => shareLapsed(agent),
        notice: record => options.sharingNotice!(sharingNotice(record, hubName())),
        snapshot: () => sender.afterCommit(),
      }) : null;
      const sharingLink = sharing ? new HubMemberSharingLink({ sharing, journal: sharingJournal, current: sharingLive,
        failed: () => options.log("warn", "Hub sharing is not confirmed yet") }) : null;
      const sharingController: import("../../hub-sharing-notice.js").HubSharingController | null = sharing ? {
        view: key => {
          if (!sharingLive()) return null;
          const record = sharingJournal.byNotice(key);
          return record && record.noticeAt !== null ? sharingNotice(record, hubName()) : null;
        },
        undo: async (key, actor, authorized) => {
          const record = await sharing.undo(key, actor, authorized);
          void sharingLink?.flush();
          return sharingNotice(record, hubName());
        },
      } : null;
      teardown.add("Hub sharing requests", () => { sharingLink?.close(); options.attachSharing?.(null); });

      const catalog: HubMemberAgentCatalog | null = options.catalogAgents ? new HubMemberAgentCatalog({ current: live, enabled: catalogEnabled, agents: catalogAgents, requests: !!sharing, lapsed: agent => shareLapsed(agent),
        failed: () => options.log("warn", "The owner agent catalog was not sent") }) : null;
      teardown.add("owner agent catalog", () => catalog?.close());
      // M-3533 R2b: each published share's pictures, for the Hub's room offices (agent-pictures-v1, when the Hub offers it).
      const pictures: HubMemberAgentPictures | null = options.pictureSources ? new HubMemberAgentPictures({ current: live, reduce: reduceInWorker, crop: cropInWorker,
        exposures: () => exposures.list().flatMap(row => { const e = row.committed?.exposure; return e && e.state === "published" ? [{ id: e.id, agent: row.agent }] : []; }),
        sources: agent => options.pictureSources!(agent),
        failed: () => options.log("warn", "Shared agents' pictures were not sent to the Hub") }) : null;
      teardown.add("shared agents' pictures", () => pictures?.close());
      client = new HubMemberClient({
        allowOfflineStart: true,
        log: options.log,
        fleetInfo: reportedInfo,
        receiveRecommendations: !!recommendations,
        agentIntro: true,
        agentCatalog: !!catalog,
        agentPictures: !!pictures,
        agentCharacters: !!pictures,
        exposureRequests: !!sharing,
        roomContext: !!options.roomConversationGeneration && !!options.attachRoomInputs,
        roomMentionFeedback:!!options.roomNotify,
        home: options.home,
        hubId,
        capabilities: [...HUB_OPTIONAL_CAPABILITIES, ...(updates ? [HUB_FLEET_UPDATE_CAPABILITY, HUB_ASKER_NAME_CAPABILITY, HUB_QUESTION_CLOSE_CAPABILITY,...(askerStore?[HUB_ROOM_ASKER_IDENTITY_CAPABILITY]:[]),...(options.representative.readState&&options.attachAgentRooms&&options.roomNotify?[HUB_DIRECT_POST_CAPABILITY]:[])] : []),
          ...(options.representative.readState ? [HUB_ROOM_ASK_CAPABILITY, ...(options.attachAgentRooms && options.roomNotify ? [HUB_ROOM_POST_CAPABILITY] : [])] : [])],
        memberOrigin: profile.hub.memberOrigin,
        revocationFloor: () => journal.revocationVersion(),
        // #3429 B: a pending relocation's `to` first, then the anchor; a relocation state that does not verify: none.
        ...(profileDigest ? { dial: () => relocations.dialOrder(profile, profileDigest) } : {}),
        current: live,
        reconcile: async (l) => {
          stopRooms();
          links.relink(l);
          online = null;
          await handshake(l);
          // #3429 B: a fully validated, current welcome on the link dialled to the pending `to` proves that exact relocation.
          if (l.current() && live() && profileDigest) {
            const r = relocations.read(profile, profileDigest);
            if (r.kind === "ok" && r.state.pending && r.state.pending.statement.to === l.endpoint) {
              try {
                promoteHubRelocation({ home: options.home, profile, profileDigest, webOrigin: webNow(), current: () => live() && l.current(),
                  record: recorder(l), trust }, r.state.pending.digest);
              } catch (err) { options.log("warn", "The Hub's relocation was not confirmed yet", { error: (err as Error).message }); }
            }
          }
          if (l.current() && live()) {
            online = l;
            catalog?.connected(l);
            pictures?.connected(l);
            sharingLink?.connected(l);
            quota.start(l);
            terminalHold = false; reportLink("online");
            intro.connected(l);
            updates?.connected(l);
            startRooms(l);
            // Questions admitted while offline (or before a restart, with no input yet) go out on this link.
            service.pump();
            learnDisplay(l);
          }
        },
        receive: (frame, l) => {
          if (frame.type === "exposure.request" && sharingLink) { sharingLink.receive(frame.requestId, frame.payload, l); return Promise.resolve(); }
          if (frame.type === "agent.catalog-refresh" && catalog) { if (l.current() && live()) return catalog.refresh(true); return Promise.resolve(); }
          if (updates && (frame.type === "fleet.update" || frame.type === "fleet.update-cancel" || frame.type === "fleet.update-status-ack")) {
            try {
              if (frame.type === "fleet.update") updates.receive(frame.payload, l);
              else if (frame.type === "fleet.update-cancel") updates.cancel(frame.payload, l);
              else updates.acknowledge(frame.payload, l);
            } catch { options.log("warn", "Hub update control was refused", { phase: "receive" }); }
            return Promise.resolve();
          }
          if (frame.type === "fleet.recommendation" && recommendations) {
            try { recommendations.receive(frame.payload, l); }
            catch { options.log("warn", "Hub version advice was refused", { phase: "receive" }); }
            return Promise.resolve();
          }
          if (frame.type === "room.ask" || frame.type === "room.post-answer") seen(options.sawText, frame.payload);
          if(frame.type === "room.post-answer") {
            if(postLink && roomLink(l).current())posts.receiveAnswer(frame.payload,postLink);
            return Promise.resolve();
          }
          if (frame.type === "room.ask") {
            try { room.accept(frame.payload, roomLink(l)); }
            catch (error) {
              // A racing withdrawal or unready agent refuses only this ask, not unrelated work on the shared link.
              if (!(error instanceof HubProtocolError) || error.code === "backpressure") throw error;
              options.log("warn", "Hub room ask not admitted", { messageId: frame.payload.messageId, reason: error.code });
            }
            return Promise.resolve();
          }
          if (frame.type === "room.answer-ack") { room.acknowledge(frame.payload, roomLink(l)); return Promise.resolve(); }
          // M-3127: a reaction's result — a refusal is logged; nothing is retried (a gesture, not an answer).
          if (frame.type === "room.react-result") { if (!frame.payload.ok) options.log("warn", "Hub room reaction not taken", { messageId: frame.payload.messageId, reason: frame.payload.code }); return Promise.resolve(); }
          return receive(frame, l);
        },
        // M-2901: where the Hub's pages are now. Kept beside the pairing (never in it), only when it verifies against the
        // issuer key pinned at pairing and moves forward; audited in this member's own log either way it is decided.
        webOrigin: (statement, l) => {
          if (!live() || !l.current()) return;
          try {
            learnHubWebOrigin({ home: options.home, profile, current: () => live() && l.current(), log: options.log,
              memberOrigin: l.endpoint, memberOrigins: trustedMemberOrigins(),
              record: createHubWebOriginRecorder({ db, audit, now, fleetId: profile.fleetId, policyVersion: () => l.revocationVersion }) }, statement);
          } catch (err) {
            // Not recorded or not kept: the address is unchanged; the next welcome's statement tries again (no second record).
            options.log("warn", "The Hub's web address was not kept yet", { error: (err as Error).message });
          }
        },
        hold: (code) => {
          catalog?.disconnected();
          pictures?.disconnected();
          sharingLink?.disconnected();
          stopDisplay();
          stopRooms();
          updates?.connected(null);
          quota.stop();
          const state = code === "revoked" ? "revoked" : code === "rejected" || code === "invalid" ? "rejected" : "offline";
          terminalHold = state === "revoked" || state === "rejected";
          reportLink(state);
          options.log("warn", "Hub link held", { code });
        },
        now,
      });
      teardown.add("the Hub connection", () => client?.close());



      return {
        async leave(expected: import("../types.js").HubMemberLeaveBinding) { return live() && await client!.leave(expected); },
        async start() {
          if (!live()) throw new HubStateError("service-unavailable", "the Hub member was switched off while starting");
          options.attachAttention(() => [...service.attentionItems(),...room.attentionItems()], (id) => service.retryHeld(id), (id) => service.closeHeld(id));
          options.attachExposures(api);
          options.attachSharing?.(sharingController);
          options.attachRoomAskers?.({verifiedAsker:(id,expected)=>room.verifiedAsker(id,expected)});
          options.attachAgentRooms?.(posts);
          options.attachShareLapse?.({ lapsed: shareLapsed, agents: lapsedAgents });
          options.representative.attachReports(input => room.report(input) ?? service.report(input), (cid, agent) => {
            if(cid.startsWith("hub-room-post-answer-"))posts.deliveryFailed(cid.slice("hub-room-post-answer-".length),agent);
            if(cid.startsWith("hub-room-mention-feedback-"))feedback.deliveryFailed(cid.slice("hub-room-mention-feedback-".length),agent);
            room.deliveryFailed(cid, agent); service.deliveryFailed(cid, agent);
          });
          options.representative.attachPrivateQuestions?.(agent => service.hasOpenQuestion(agent) || room.hasOpenQuestion(agent));
          options.representative.attachQuestionSettled?.((agent, cid) => (service.questionSettled(cid, agent) ?? room.questionSettled(cid, agent)) === true);
          options.representative.attachReacts?.(input => room.react(input));
          options.attachRoomInputs?.((cid,agent,generation) => room.inputHandoff(cid,agent,generation));
          options.attachRoomOwed?.(room);
          teardown.add("the fleet attachments", () => {
            options.representative.attachReacts?.(null);
            options.representative.attachReports(null, null);
            options.representative.attachPrivateQuestions?.(null);
            options.representative.attachQuestionSettled?.(null);
            options.attachRoomInputs?.(null);options.attachRoomOwed?.(null);options.attachRoomAskers?.(null);
            options.attachExposures(null);
          options.attachSharing?.(null);
            intro.connected(null);
            options.attachAgentRooms?.(null);
            options.attachShareLapse?.(null);
            options.attachAttention(null);
          });
          options.attachUpdates?.(updates);
          if (updates) {
            await updates.start();
            updateTimer = setInterval(() => { void updates.tick(); }, 5_000); updateTimer.unref();
          }
          await client!.start();
        },
        fence() {
          fenced = true;
          catalog?.close();
          stopDisplay();
          updates?.close(); options.attachUpdates?.(null);
          stopRooms();
          quota.stop();
          links.fence();
          client?.fence();
          options.representative.attachReports(null, null);
          options.representative.attachPrivateQuestions?.(null);
          options.representative.attachQuestionSettled?.(null);
            options.attachRoomInputs?.(null);options.attachRoomOwed?.(null);options.attachRoomAskers?.(null);
          options.attachExposures(null);
          options.attachSharing?.(null);
          intro.connected(null);
          options.attachAgentRooms?.(null);
          options.attachShareLapse?.(null);
          // Mount drains failed startup too. Keep its actionable rejection until a different pairing takes over.
          if (!terminalHold) reportLink("offline");
        },
        async close() {
          fenced = true;
          await teardown.run();
        },
        /** Diagnostics seams (not part of HubMountedService). */
        binding,
        representative: service,
      } as HubMountedService & Record<string, unknown>;
    } catch (err) {
      return fail(err);
    }
  };
  const drain = async (): Promise<void> => {
    if (!unconfirmed) return;
    await unconfirmed.run();
    unconfirmed = null;
  };
  return Object.assign(createMember, { drain });
}
