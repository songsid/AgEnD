/** Strict P1 frame schemas; importing this file creates no state, sockets or timers. */
import { z } from "zod";
import { epoch, hash, identifier, person, plain, reason, uuid, validated, parseStrictJson } from "./validation.js";
import type { HubMemberFrame, HubServerFrame, HubAuthorizationRequest, HubAskerEnvelope } from "./types.js";
export const HUB_VERSION = 1;
export const HUB_PATHS = { pair: "/hub/v1/pair", claim: "/hub/v1/claim", connect: "/hub/v1/connect" } as const;
export const HUB_CAPABILITIES = ["identity-v1", "receipts-v1", "reconcile-v1"] as const;
/** Optional link features this build offers, never required: an older peer that lacks one keeps working without it.
 * `welcome-caps-v1` lets the Hub answer with its own list; a feature is enabled only when both ends list it. Each feature
 * PR adds its own flag here (#3226: attachments-v1, buttons-v1, quota-band-v1) and checks `features` before sending. */
export const HUB_OPTIONAL_CAPABILITIES: readonly string[] = ["welcome-caps-v1", "quota-band-v1", "attachments-v1"];
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
/** `attachments` only ever goes to a peer whose link enabled attachments-v1 (an old peer's strict schema refuses it). */
export const questionSchema = z.strictObject({ text: plain(HUB_LIMITS.question), identity: askerSchema, attachments: attachmentList.optional() });
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
export const answerSchema = z.strictObject({ messageId: uuid, answerId: uuid, text: plain(HUB_LIMITS.answer), contentDigest: hash, releaseLease: leaseSchema, attachments: attachmentList.optional() });
export const revocationSchema = z.strictObject({ revocationVersion: epoch, reasonCode: reason, scope: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/) }),
  z.strictObject({ kind: z.literal("fleet"), fleetId: uuid }),
  z.strictObject({ kind: z.literal("exposure"), exposureId: uuid }),
  z.strictObject({ kind: z.literal("grant"), grantId: uuid }),
]) });
const errorSchema = z.strictObject({ code: reason, retryable: z.boolean() });
const frame = <T extends string, P extends z.ZodType>(type: T, payload: P) => z.strictObject({ v: z.literal(1), type: z.literal(type), requestId: uuid, linkEpoch: epoch, payload });
const hello = z.strictObject({ supportedVersions: z.array(epoch.min(1)).min(1).max(8), capabilities: z.array(identifier).max(16), memberBootId: uuid });
const welcome = z.strictObject({ selectedVersion: z.literal(1), hubId: uuid, fleetId: uuid, linkEpoch: epoch.min(1), revocationVersion: epoch,
  /** Sent only when the hello offered welcome-caps-v1: the Hub's own optional features. */
  capabilities: z.array(identifier).max(16).optional() });
const chunkData = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(HUB_ATTACHMENT_CHUNK / 3) * 4);
const attachmentChunk = z.strictObject({ id: uuid, offset: epoch, total: z.number().int().min(1).max(HUB_ATTACHMENT_FILE_MAX), sha256: hash, data: chunkData });
const reconcile = z.strictObject({ afterReceiptSequence: epoch, messages: z.array(z.strictObject({ messageId: uuid, contentDigest: hash })).max(128) });
export const memberFrameSchema = z.union([
  frame("hello", hello), frame("exposure.snapshot", z.strictObject({ revision: epoch, exposures: z.array(exposureSchema).max(64) })),
  frame("receipt", receiptSchema), frame("answer", answerSchema), frame("reconcile", reconcile),
  frame("authorize.request", authorizationSchema), frame("error", errorSchema),
  frame("exposure.quota", exposureQuotaSchema),
  // attachments-v1 only: pull a question's file; push an answer's file before its answer frame.
  frame("attachment.get", z.strictObject({ id: uuid, offset: epoch })), frame("attachment.put", attachmentChunk),
]);
export const serverFrameSchema = z.union([
  frame("welcome", welcome), frame("question", questionSchema), frame("receipt", receiptSchema),
  frame("reconcile", z.strictObject({ receipts: z.array(receiptSchema).max(128), nextReceiptSequence: epoch, more: z.boolean() })),
  frame("authorize.result", z.union([z.strictObject({ ok: z.literal(true), lease: leaseSchema }), z.strictObject({ ok: z.literal(false), reasonCode: reason })])),
  frame("revoke", revocationSchema), frame("error", errorSchema),
  frame("attachment.chunk", attachmentChunk), frame("attachment.ack", z.strictObject({ id: uuid, offset: epoch })),
]);
export const parseMemberFrame = (input: string | Buffer): HubMemberFrame => validated(memberFrameSchema, parseStrictJson(input));
export const parseServerFrame = (input: string | Buffer): HubServerFrame => validated(serverFrameSchema, parseStrictJson(input));
export function encodeMemberFrame(value: HubMemberFrame): string { return JSON.stringify(parseMemberFrame(JSON.stringify(value))); }
export function encodeServerFrame(value: HubServerFrame): string { return JSON.stringify(parseServerFrame(JSON.stringify(value))); }
export const validateAsker = (input: unknown): HubAskerEnvelope => validated(askerSchema, input);
export const validateAuthorization = (input: unknown): HubAuthorizationRequest => validated(authorizationSchema, input);
