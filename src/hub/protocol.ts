import { questionCloseSchema, questionCloseResultSchema } from "./question-close-model.js";
import {roomAskerIdentitySchema} from './room-asker-identity-model.js';
import {roomMemberOptions,boundedRoomMembersSchema} from "./room-members-model.js";
import {roomBriefSchema} from "./room-brief-model.js";
import {agentIntroSchema,agentIntroResultSchema} from "./agent-intro-model.js";
import { agentPicturesSchema, agentPicturesResultSchema, agentPictureChunkSchema, agentPictureResultSchema } from "./agent-pictures-model.js";
import { agentCatalogSchema, agentCatalogRefreshSchema, exposureRequestSchema, exposureRequestResultSchema, exposureRequestAckSchema, exposureUndoSchema, exposureUndoResultSchema } from "./agent-catalog-model.js";
/** Strict P1 frame schemas; importing this file creates no state, sockets or timers. */
import { z } from "zod";
import {roomMentionFeedbackSchema} from "./room-mention-feedback-model.js";
import { roomContextStateSchema, roomContextRequestSchema, roomContextInputSchema, roomContextResultSchema, roomContextInputResultSchema } from "./room-context-model.js";
export { HUB_ROOM_CONTEXT_CAPABILITY } from "./room-context-model.js";
import { fleetUpdateRequestSchema, fleetUpdateCancelSchema, fleetUpdateStatusSchema, fleetUpdateStatusAckSchema } from "./fleet-update-model.js";
import { epoch, hash, identifier, person, plain, reason, uuid, validated, parseStrictJson } from "./validation.js";
/** Phase 3 receiver offer; old-Hub compatibility is negotiated by the member client. */
export const HUB_FLEET_UPDATE_CAPABILITY = "fleet-update-v1";
/** M-3594: a 1:1 question may carry `askerName`, the asker's display name from the Hub's own directory (the source room asks
 * use), never text the asker typed. Offered only beside fleet-update-v1 (a 32-name hello), and dropped with it on the
 * legacy retry, so a 16-name member hello is unchanged. */
export const HUB_ASKER_NAME_CAPABILITY = "asker-name-v1";
import type { HubMemberFrame, HubServerFrame, HubAuthorizationRequest, HubAskerEnvelope } from "./types.js";
import { validHubAnswerButtons } from "./buttons-model.js";
import { recommendationSchema, recommendationAckSchema } from "./recommendation-model.js";
import { fleetInfoSchema } from "./fleet-info.js";
export const HUB_VERSION = 1;
export const HUB_PATHS = { pair: "/hub/v1/pair", claim: "/hub/v1/claim", connect: "/hub/v1/connect" } as const;
/**
 * M-3205: the member's durable revocation floor, sent on the connect upgrade (a header, so an older Hub ignores it and the
 * strict hello is unchanged). A Hub restored from a backup has a lower authorization version than its Fleets have seen, and
 * every Fleet refuses that welcome as stale for good. A current Hub that authenticates the credential first catches its
 * own version up to the floor (never down): leases issued at any older version stay refused, so the floor keeps its meaning.
 */
export const HUB_REVOCATION_FLOOR_HEADER = "x-agend-revocation-floor";
/** The largest step one authenticated member may move the Hub's version (a restore gap is a handful of changes). */
export const HUB_REVOCATION_CATCH_UP_MAX = 1_000_000;
/** At most one catch-up per this interval, Hub-wide: each one reconnects every Fleet (Fable #4081 F1). */
export const HUB_REVOCATION_CATCH_UP_INTERVAL_MS = 5 * 60_000;
export const HUB_CAPABILITIES = ["identity-v1", "receipts-v1", "reconcile-v1"] as const;
/** Track C's injectable adapter uses these frames; advertised only when live dispatch is composed (R2). */
export const HUB_ROOM_ASK_CAPABILITY = "room-ask-v1";
/** Opted into by the mounted agent room-post adapter, never by an uncomposed member. */
export const HUB_ROOM_POST_CAPABILITY = "room-post-v1";
/** M-3127: a room answer may carry the reply's buttons or poll (answerButtonsSchema); both ends list it. */
export const HUB_ROOM_BUTTONS_CAPABILITY = "room-answer-buttons-v1";
/**
 * M-3127: an agent reacts to the room question it was asked (its `react` tool, the Fleet chat's minimal reply). It rides on
 * room-answer-buttons-v1 (the same release): a capability of its own would make a 17th in a room-post member's hello, which
 * older Hubs refuse and members still must not send (see HUB_OPTIONAL_CAPABILITIES).
 */
export const HUB_ROOM_REACT_CAPABILITY = HUB_ROOM_BUTTONS_CAPABILITY;
/**
 * M-3125: files on a room ask and its answer (`attachments`). Like reactions, they ride on room-answer-buttons-v1 — unreleased,
 * shipping in the same release as these files — plus attachments-v1 (the file frames). A name of their own would be a 17th in
 * the member hello (Fable #3925). Never room-ask-v1 + attachments-v1: released alpha Fleets list both, and their strict
 * room.ask schema refuses `attachments`. So #3925 must land in the same release as room-answer-buttons-v1 (#3935).
 */
export const roomFilesNegotiated = (features: ReadonlySet<string> | undefined): boolean =>
  !!features && features.has(HUB_ROOM_BUTTONS_CAPABILITY) && features.has("attachments-v1");
/** Optional link features this build offers, never required: an older peer that lacks one keeps working without it.
 * `welcome-caps-v1` lets the Hub answer with its own list; a feature is enabled only when both ends list it. Each feature
 * PR adds its own flag here (#3226: attachments-v1, buttons-v1, quota-band-v1) and checks `features` before sending.
 * LIMIT (M-3127): a member's hello sends HUB_CAPABILITIES + these + room-ask-v1 (+ room-post-v1 when its agent-room adapter
 * is composed). That legacy list makes exactly 16 (pinned by tests/hub-room-agent-react-m3127.test.ts).
 * M-3144 permits 32 sends for fleet-update-v1, with one bounded retry dropping only that offer when an
 * older 16-cap Hub closes before welcome. Do not silently truncate other features. */
export const HUB_OPTIONAL_CAPABILITIES: readonly string[] = ["welcome-caps-v1", "attachments-v1", "buttons-v1", "quota-band-v1", "pairing-notices-v1", "pairing-notices-v2", "pairing-notices-v3", "member-leave-v1", "web-origin-v1", "member-relocation-v1", "room-answer-buttons-v1"];
export const HUB_ATTACHMENT_FILE_MAX = 20 * 1024 * 1024;
export const HUB_ATTACHMENTS_PER_MESSAGE = 10;
/** Raw bytes per attachment chunk: base64 (4/3) plus the frame envelope stays under HUB_LIMITS.frame (256 KiB). */
export const HUB_ATTACHMENT_CHUNK = 180 * 1024;
export const HUB_LIMITS = { frame: 256 * 1024, question: 64 * 1024, answer: 128 * 1024, pending: 32, sendQueue: 1024 * 1024, heartbeat: 15_000, rpcTimeout: 5_000 } as const;
export const askerSchema = z.strictObject({
  v: z.literal(1), issuer: uuid, issuerKeyId: identifier, messageId: uuid, asker: person, owner: person,
  destinationFleetId: uuid, exposureId: uuid, roomId: uuid, grantId: uuid, grantRevision: epoch,
  exposureRevision: epoch, revocationVersion: epoch, contentDigest: hash, issuedAt: epoch, expiresAt: epoch,
  nonce: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const exposureSchema = z.strictObject({ id: uuid, fleetId: uuid, owner: person, displayName: plain(256), revision: epoch,
  state: z.enum(["published", "withdrawn", "frozen"]), dataViewId: identifier, allowedTools: z.array(identifier).max(64), policyDigest: hash });
/** No extensible bag: percentages, provider/profile ids and precise reset times are refused. */
export const quotaSchema = z.union([
  z.strictObject({ band: z.enum(["available", "near_limit", "unknown"]) }),
  z.strictObject({ band: z.literal("exhausted"), resetsAt: epoch.max(8.64e15).refine(n => n % 300_000 === 0).optional() }),
]);
export const exposureQuotaSchema = z.strictObject({ exposureId: uuid, quota: quotaSchema });
/** A file's name as shown and saved: one path segment, no control characters, no leading dot. */
export const attachmentName = plain(255).refine(s => s.length > 0 && !/[\\/\u0000-\u001f\u007f]/.test(s) && !s.startsWith(".") && s.trim() === s, "Invalid file name");
export const attachmentMime = z.string().regex(/^(?:image|application|text)\/[a-z0-9][a-z0-9.+-]{0,99}$/);
export const attachmentRefSchema = z.strictObject({ id: uuid, name: attachmentName, size: z.number().int().min(1).max(HUB_ATTACHMENT_FILE_MAX), mime: attachmentMime, sha256: hash });
const attachmentList = z.array(attachmentRefSchema).min(1).max(HUB_ATTACHMENTS_PER_MESSAGE).refine(list => new Set(list.map(r => r.id)).size === list.length, "Duplicate attachment");
/** `attachments` only ever goes to a peer whose link enabled attachments-v1 (an old peer's strict schema refuses it);
 * `askerName` only to one that enabled asker-name-v1 (M-3594). */
export const questionSchema = z.strictObject({ text: plain(HUB_LIMITS.question), identity: askerSchema, attachments: attachmentList.optional(),
  askerName: plain(256).refine(s => s.trim().length > 0).optional() });
export const receiptSchema = z.strictObject({ messageId: uuid, contentDigest: hash,
  stage: z.enum(["queued", "delivered", "consumed", "answered", "rejected", "cancelled", "failed", "uncertain"]),
  sequence: epoch.min(1), at: epoch, memberDeliveryId: uuid.optional(), reasonCode: reason.optional() });
const scope = { messageId: uuid, operationId: uuid, exposureRevision: epoch };
export const authorizationSchema = z.union([
  z.strictObject({ ...scope, phase: z.enum(["admit", "begin"]) }),
  z.strictObject({ ...scope, phase: z.literal("tool"), tool: z.strictObject({ name: identifier, argumentsDigest: hash }) }),
  z.strictObject({ ...scope, phase: z.literal("release-answer"), answer: z.strictObject({ answerId: uuid, contentDigest: hash }) }),
]);
export const leaseSchema = z.strictObject({ decisionId: uuid, messageId: uuid, operationId: uuid,
  phase: z.enum(["admit", "begin", "tool", "release-answer"]), operationDigest: hash, revocationVersion: epoch,
  exposureRevision: epoch, linkEpoch: epoch.min(1), expiresAt: epoch });
/** buttons-v1 uses the fleet's normalized poll config (the raw tool uses show_voters instead). */
export const answerButtonsSchema = z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/), labels: z.array(z.string()).min(1).max(10),
  values: z.array(z.string()).min(1).max(10).optional(),
  poll: z.strictObject({ seconds: z.number().int().min(10).max(86400), multi: z.boolean(), reveal: z.enum(["close", "live"]),
    showVoters: z.boolean(), question: plain(1200).refine(s => s.length <= 300) }).optional() }).refine(validHubAnswerButtons, "Invalid reply buttons/poll");
export const answerSchema = z.strictObject({ messageId: uuid, answerId: uuid, text: plain(HUB_LIMITS.answer), contentDigest: hash, releaseLease: leaseSchema,
  attachments: attachmentList.optional(), buttons: answerButtonsSchema.optional() });
export const roomContextSchema = z.strictObject({ author: plain(256), text: plain(HUB_LIMITS.question), at: epoch, repliedTo: z.literal(true).optional() });
export const roomAskBaseSchema = z.strictObject({ messageId: uuid, roomId: uuid, roomName: plain(120), exposureId: uuid,
  asker: z.strictObject({ name: plain(256) }), text: plain(HUB_LIMITS.question), contextState: roomContextStateSchema.optional(), brief:roomBriefSchema.optional(), context: z.array(roomContextSchema).max(31)
    .refine(rows => rows.length <= 30 || rows.filter(r => r.repliedTo).length === 1), attachments: attachmentList.optional() });
export const roomAskSchema=roomAskBaseSchema.extend({askerIdentity:roomAskerIdentitySchema.optional()});
export const roomAnswerSchema = z.strictObject({ notAnswered:z.literal("finished-without-answer").optional(),messageId: uuid, roomId: uuid, exposureId: uuid, answerId: uuid, text: plain(HUB_LIMITS.answer),
  buttons: answerButtonsSchema.optional(), attachments: attachmentList.optional(),mentionFeedback:z.literal(true).optional() }).refine(v=>!v.notAnswered||v.text===""&&!v.buttons&&!v.attachments);
export const roomAnswerAckSchema = z.strictObject({ messageId: uuid, answerId: uuid,mentionRefusals:roomMentionFeedbackSchema.optional() });
/** M-3127 (room-answer-buttons-v1): `messageId` is the delivery (the question as the agent got it); "" takes the agent's reaction back. */
export const roomReactSchema = z.strictObject({ messageId: uuid, roomId: uuid, exposureId: uuid, emoji: z.string().max(16), acknowledge: z.literal(true).optional() });
export const roomReactResultSchema = z.strictObject({ messageId: uuid, ok: z.boolean(), acknowledged: z.literal(true).optional(), code: z.enum(["invalid", "denied", "not-found", "archived", "revoked"]).optional() });
const roomPostRefusalCode = z.enum(["invalid", "denied", "revoked", "not-found", "archived", "ambiguous-room", "rate-limited", "conflict", "unavailable", "stale", "backpressure"]);
const roomPostChoice = z.strictObject({ id: uuid, name: plain(256), kind: z.literal("direct").optional() }).refine(v=>v.kind||Buffer.byteLength(v.name)<=120);
export const roomListSchema = z.strictObject({ exposureId: uuid });
export const roomListResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), exposureId: uuid, rooms: z.array(roomPostChoice).max(200), truncated: z.boolean().optional() }),
  z.strictObject({ ok: z.literal(false), exposureId: uuid, code: roomPostRefusalCode, retryAt: epoch.optional() }),
]);
export const roomPostSchema = z.strictObject({ exposureId: uuid, room: plain(128).refine(s => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s)),
  text: plain(HUB_LIMITS.answer), direct:z.literal(true).optional(), attachments:attachmentList.optional(), idempotencyKey: uuid, onBehalfOf: z.strictObject({ receiptId: z.string().regex(/^hmsg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(s => s.toLowerCase()) }).optional(),mentionFeedback:z.literal(true).optional() }).refine(b=>b.direct ? (b.text.trim().length>0||!!b.attachments?.length)&&!b.onBehalfOf&&!b.mentionFeedback : !b.attachments&&Buffer.byteLength(b.text)<=HUB_LIMITS.question&&b.text.trim().length>0);
export const roomPostResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), roomId: uuid, messageId: uuid, at: epoch,message:plain(512).optional(),mentionRefusals:roomMentionFeedbackSchema.optional() }),
  z.strictObject({ ok: z.literal(false), code: roomPostRefusalCode, message:plain(512).optional(), retryAt: epoch.optional(), rooms: z.array(roomPostChoice).max(200).optional() }),
]);

export const roomMembersSchema = z.strictObject({ exposureId: uuid, room: plain(128).refine(s => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s)),v2:z.literal(true).optional(),...roomMemberOptions }).refine(v=>v.v2||![v.query,v.kind,v.limit,v.cursor].some(x=>x!==undefined));
export const roomMembersResultSchema = z.union([boundedRoomMembersSchema,
  z.strictObject({ ok: z.literal(true), roomId: uuid, members: z.array(z.strictObject({ id: plain(128), kind: z.enum(["person", "agent", "assistant"]), name: plain(256), presence: plain(32),
    owner: z.strictObject({ name: plain(256) }).optional(), presenceReason: plain(32).optional(), presenceNote: plain(256).optional() })).max(200) }),
  z.strictObject({ ok: z.literal(false), code: roomPostRefusalCode, message:plain(512).optional(), retryAt: epoch.optional(), rooms: z.array(roomPostChoice).max(200).optional() }),
]);
export const peopleSearchSchema = z.strictObject({ exposureId: uuid, q: plain(64).refine(s => s.trim() === s && s.length >= 2 && !/[\u0000-\u001f\u007f]/.test(s)) });
export const peopleSearchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), people: z.array(z.strictObject({ id: plain(128), name: plain(256), login: plain(256) })).max(20), truncated: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: roomPostRefusalCode, retryAt: epoch.optional() }),
]);
export const roomPostAnswerSchema = z.strictObject({ id: uuid, idempotencyKey: uuid, postId: uuid, roomId: uuid, exposureId: uuid,
  message: z.strictObject({ id: uuid, author: z.strictObject({ name: plain(256) }), text: plain(HUB_LIMITS.answer), at: epoch }), receiptId: plain(256).optional() });
export const roomPostAnswerAckSchema = z.strictObject({ id: uuid });

export const agentStateSchema = z.strictObject({ exposureId: uuid, state: z.enum(["idle", "working", "paused"]),
  reason: z.enum(["quota", "auth", "approval", "update", "operator", "idle", "capacity", "error", "stopped", "crashed", "stuck", "unknown"]).optional(), note: plain(256).optional() });
export const revocationSchema = z.strictObject({ revocationVersion: epoch, reasonCode: reason, scope: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/) }),
  z.strictObject({ kind: z.literal("fleet"), fleetId: uuid }),
  z.strictObject({ kind: z.literal("exposure"), exposureId: uuid }),
  z.strictObject({ kind: z.literal("grant"), grantId: uuid }),
]) });
const errorSchema = z.strictObject({ code: reason, retryable: z.boolean() });
/** Security notice only: no credential, code, raw directory facts or bearer revoke URL. */
export const pairingNoticeSchema = z.strictObject({ id: uuid, fleetId: uuid, generation: epoch.min(1), label: plain(120),
  at: epoch, source: z.literal("group"), revoked: z.boolean() });
export const pairingNoticeV2Schema = pairingNoticeSchema.extend({ source: z.enum(["group", "manual"]) });
export const pairingNoticeV3Schema = z.union([pairingNoticeV2Schema, pairingNoticeSchema.extend({ source: z.literal("code"), codeId: uuid })]);
/** web-origin-v1 (M-2901): the Hub's current web address, signed with its issuer key; signed and verified in web-origin.ts. */
export const webOriginStatementSchema = z.strictObject({ v: z.literal(1), webOrigin: z.string().min(1).max(2048), revision: epoch,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
/** #3429 option B: the Hub's issuer-signed member-address relocation; signed and verified in member-origin.ts. */
export const relocationStatementSchema = z.strictObject({ v: z.literal(1), from: z.string().min(1).max(2048), to: z.string().min(1).max(2048),
  spkiSha256: hash, revision: epoch.min(1), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
const frame = <T extends string, P extends z.ZodType>(type: T, payload: P) => z.strictObject({ v: z.literal(1), type: z.literal(type), requestId: uuid, linkEpoch: epoch, payload });
/** Members can offer 32 names. The client retries a rejected pre-welcome offer once without fleet-update-v1. */
const memberHelloCapabilities = z.array(identifier).max(32);
const hello = z.strictObject({ supportedVersions: z.array(epoch.min(1)).min(1).max(8), capabilities: z.array(identifier).max(32), memberBootId: uuid });
/** Members accept 32 welcome names; Hubs keep at most 16 unless the peer offered fleet-update-v1. */
const hubWelcomeCapabilities = z.array(identifier).max(16).optional();
const welcome = z.strictObject({ selectedVersion: z.literal(1), hubId: uuid, fleetId: uuid, linkEpoch: epoch.min(1), revocationVersion: epoch,
  /** Sent only when the hello offered welcome-caps-v1: the Hub's own optional features. */
  capabilities: z.array(identifier).max(32).optional(),
  /** web-origin-v1 (M-2901): the Hub's current web address, signed with its issuer key (web-origin.ts). Only to a member that asked. */
  webOrigin: webOriginStatementSchema.optional() });
const chunkData = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(HUB_ATTACHMENT_CHUNK / 3) * 4);
const attachmentChunk = z.strictObject({ id: uuid, offset: epoch, total: z.number().int().min(1).max(HUB_ATTACHMENT_FILE_MAX), sha256: hash, data: chunkData });
const reconcile = z.strictObject({ afterReceiptSequence: epoch, messages: z.array(z.strictObject({ messageId: uuid, contentDigest: hash })).max(128) });
/** The authenticated link is the target. No caller-supplied Fleet ID, owner or credential. */
export const memberLeavePayloadSchema = z.strictObject({});
export const memberFrameSchema = z.union([
  frame("question.close", questionCloseSchema),
  frame("agent.intro",agentIntroSchema),
  // agent-pictures-v1 (M-3533 R2b): a Fleet's shared agents' pictures, then the chunks the Hub asked for.
  frame("agent.pictures", agentPicturesSchema), frame("agent.picture", agentPictureChunkSchema),
  frame("agent.catalog", agentCatalogSchema), frame("exposure.request-result", exposureRequestResultSchema), frame("exposure.undo", exposureUndoSchema),
  frame("room.list", roomListSchema), frame("room.post", roomPostSchema), frame("room.members", roomMembersSchema), frame("people.search", peopleSearchSchema), frame("room.post-answer-ack", roomPostAnswerAckSchema),
  frame("room.context-state", roomContextRequestSchema), frame("room.context-input", roomContextInputSchema),
  frame("room.answer", roomAnswerSchema), frame("agent.state", agentStateSchema), frame("room.react", roomReactSchema),
  frame("member.leave", memberLeavePayloadSchema),
  frame("hello", hello), frame("fleet.update-status", fleetUpdateStatusSchema), frame("fleet.info", fleetInfoSchema), frame("fleet.recommendation-ack", recommendationAckSchema), frame("exposure.snapshot", z.strictObject({ revision: epoch, exposures: z.array(exposureSchema).max(64) })),
  frame("receipt", receiptSchema), frame("answer", answerSchema), frame("reconcile", reconcile),
  frame("authorize.request", authorizationSchema), frame("error", errorSchema),
  // attachments-v1 only: pull a question's file; push an answer's file before its answer frame.
  frame("attachment.get", z.strictObject({ id: uuid, offset: epoch })), frame("attachment.put", attachmentChunk),
  frame("exposure.quota", exposureQuotaSchema),
  frame("pairing.notice-ack", z.strictObject({ id: uuid })),
  // member-relocation-v1 only: the member stored this exact relocation durably.
  frame("relocate.ack", z.strictObject({ revision: epoch.min(1), digest: hash })),
]);
export const serverFrameSchema = z.union([
  frame("question.close-result", questionCloseResultSchema),
  frame("agent.intro-result",agentIntroResultSchema),
  frame("agent.pictures-result", agentPicturesResultSchema), frame("agent.picture-result", agentPictureResultSchema),
  frame("agent.catalog-refresh", agentCatalogRefreshSchema), frame("exposure.request", exposureRequestSchema), frame("exposure.request-ack", exposureRequestAckSchema), frame("exposure.undo-result", exposureUndoResultSchema),
  frame("room.list-result", roomListResultSchema), frame("room.post-result", roomPostResultSchema), frame("room.members-result", roomMembersResultSchema), frame("people.search-result", peopleSearchResultSchema), frame("room.post-answer", roomPostAnswerSchema),
  frame("room.context-state-result", roomContextResultSchema), frame("room.context-input-result", roomContextInputResultSchema),
  frame("room.ask", roomAskSchema), frame("room.answer-ack", roomAnswerAckSchema), frame("room.react-result", roomReactResultSchema),
  frame("welcome", welcome), frame("fleet.update", fleetUpdateRequestSchema), frame("fleet.update-cancel", fleetUpdateCancelSchema), frame("fleet.update-status-ack", fleetUpdateStatusAckSchema), frame("fleet.recommendation", recommendationSchema), frame("question", questionSchema), frame("receipt", receiptSchema),
  frame("reconcile", z.strictObject({ receipts: z.array(receiptSchema).max(128), nextReceiptSequence: epoch, more: z.boolean() })),
  frame("authorize.result", z.union([z.strictObject({ ok: z.literal(true), lease: leaseSchema }), z.strictObject({ ok: z.literal(false), reasonCode: reason })])),
  frame("revoke", revocationSchema), frame("error", errorSchema),
  frame("attachment.chunk", attachmentChunk), frame("attachment.ack", z.strictObject({ id: uuid, offset: epoch })),
  frame("pairing.notice", pairingNoticeSchema),
  frame("pairing.notice-v2", pairingNoticeV2Schema),
  frame("pairing.notice-v3", pairingNoticeV3Schema),
  frame("relocate", relocationStatementSchema),
]);
export const parseMemberFrame = (input: string | Buffer): HubMemberFrame => validated(memberFrameSchema, parseStrictJson(input));
export const parseServerFrame = (input: string | Buffer): HubServerFrame => validated(serverFrameSchema, parseStrictJson(input));
export function encodeMemberFrame(value: HubMemberFrame): string {
  const frame = parseMemberFrame(JSON.stringify(value));
  if (frame.type === "hello") validated(memberHelloCapabilities, frame.payload.capabilities);
  return JSON.stringify(frame);
}
export function encodeServerFrame(value: HubServerFrame): string {
  const frame = parseServerFrame(JSON.stringify(value));
  if (frame.type === "welcome" && !frame.payload.capabilities?.includes(HUB_FLEET_UPDATE_CAPABILITY)) validated(hubWelcomeCapabilities, frame.payload.capabilities);
  return JSON.stringify(frame);
}
export const validateAsker = (input: unknown): HubAskerEnvelope => validated(askerSchema, input);
export const validateAuthorization = (input: unknown): HubAuthorizationRequest => validated(authorizationSchema, input);
