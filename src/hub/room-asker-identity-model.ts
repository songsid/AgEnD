import {z} from 'zod';
import {epoch,hash,plain,uuid} from './validation.js';

export const HUB_ROOM_ASKER_IDENTITY_CAPABILITY='room-asker-identity-v1';
export const ROOM_ASKER_PROOF_MAX_BYTES=2048;
export const ROOM_ASKER_FRESH_MS=120_000;
export const ROOM_ASKER_RETENTION_MS=24*60*60_000;
export const roomAskerSchema=z.strictObject({id:plain(512).refine(s=>s.length>0),kind:z.enum(['person','agent','assistant']),displayName:plain(256).optional()});
export const roomAskerIdentitySchema=z.strictObject({
 v:z.literal(1),issuer:uuid,issuerKeyId:hash,destinationFleetId:uuid,
 messageId:uuid,roomId:uuid,exposureId:uuid,exposureRevision:epoch,linkEpoch:epoch,
 subject:roomAskerSchema,contentDigest:hash,issuedAt:epoch,expiresAt:epoch,retainedUntil:epoch,
 nonce:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).refine(p=>Buffer.byteLength(JSON.stringify(p))<=ROOM_ASKER_PROOF_MAX_BYTES);
export type HubRoomAskerIdentity=z.infer<typeof roomAskerIdentitySchema>;
export type VerifiedHubAsker=Readonly<{hubId:string;id:string;kind:'person'|'agent'|'assistant';displayName?:string}>;
/** Daemon-owned accepted destination; this is never a tool/body argument. */
export interface RoomAskerDestination {agent:string;exposureId:string;incarnation:string}
