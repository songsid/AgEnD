import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {roomAskBaseSchema,HUB_LIMITS} from './protocol.js';
import {HubProtocolError,validated} from './validation.js';
import {issuerKeyId} from './identity.js';
import {roomAskerIdentitySchema,ROOM_ASKER_FRESH_MS,ROOM_ASKER_RETENTION_MS,type HubRoomAskerIdentity,type VerifiedHubAsker} from './room-asker-identity-model.js';

/** Canonicalizes only the bounded, validated legacy payload; never truncates a signed field. */
export function roomAskIdentityDigest(input:unknown):string{
 const value=validated(roomAskBaseSchema,input);
 const ordered=(v:unknown):unknown=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,ordered(x)])):v;
 const bytes=JSON.stringify(ordered(value));if(Buffer.byteLength(bytes)>HUB_LIMITS.frame-1024)throw new HubProtocolError('invalid');
 return createHash('sha256').update('agend-hub-room-ask-content-v1\0').update(bytes).digest('hex');
}
function tuple(p:HubRoomAskerIdentity):Buffer{return Buffer.from(JSON.stringify(['agend-hub-room-asker-identity-v1',p.v,p.issuer,p.issuerKeyId,p.destinationFleetId,p.messageId,p.roomId,p.exposureId,p.exposureRevision,p.linkEpoch,p.subject.kind,p.subject.id,p.subject.displayName??null,p.contentDigest,p.issuedAt,p.expiresAt,p.retainedUntil,p.nonce]));}
export function signRoomAsker(input:Omit<HubRoomAskerIdentity,'signature'>,key:KeyObject):HubRoomAskerIdentity{
 const p=validated(roomAskerIdentitySchema,{...input,signature:'A'.repeat(86)});
 if(key.type!=='private'||key.asymmetricKeyType!=='ed25519'||issuerKeyId(createPublicKey(key))!==p.issuerKeyId)throw new HubProtocolError('invalid');
 return{...p,signature:sign(null,tuple(p),key).toString('base64url')};
}
export interface RoomAskerBinding {hubId:string;issuerKeyId:string;issuerPublicKey:KeyObject;fleetId:string;linkEpoch:number;exposureRevision:number;now:number}
/** Authenticated proof only: distinguish a clock/freshness hold from malformed or forged data. */
export class HubRoomAskerClockError extends HubProtocolError {constructor(){super('denied');}}
/** now is the daemon's first admission time (or its authenticated historical value), never a supplied timestamp. */
export function verifyRoomAsker(input:unknown,ask:unknown,b:RoomAskerBinding):HubRoomAskerIdentity{
 const p=validated(roomAskerIdentitySchema,input),body=validated(roomAskBaseSchema,ask),key=b.issuerPublicKey;
 if(key.type!=='public'||key.asymmetricKeyType!=='ed25519'||issuerKeyId(key)!==b.issuerKeyId
  ||p.issuer!==b.hubId||p.issuerKeyId!==b.issuerKeyId||p.destinationFleetId!==b.fleetId
  ||p.messageId!==body.messageId||p.roomId!==body.roomId||p.exposureId!==body.exposureId
  ||p.exposureRevision!==b.exposureRevision||p.linkEpoch!==b.linkEpoch||p.contentDigest!==roomAskIdentityDigest(body)
  ||!Number.isSafeInteger(b.now)||p.expiresAt<=p.issuedAt||p.expiresAt-p.issuedAt>ROOM_ASKER_FRESH_MS
  ||p.retainedUntil<p.expiresAt||p.retainedUntil-p.issuedAt>ROOM_ASKER_RETENTION_MS
  ||Buffer.from(p.signature,'base64url').toString('base64url')!==p.signature||!verify(null,tuple(p),key,Buffer.from(p.signature,'base64url')))throw new HubProtocolError('denied');
 // Authenticate FIRST, so arbitrary timestamps in a forged frame cannot create a clock-warning card.
 if(p.issuedAt>b.now+5000||p.expiresAt<=b.now||p.retainedUntil<=b.now)throw new HubRoomAskerClockError();
 return p;
}
export function roomAskerSnapshot(p:HubRoomAskerIdentity):VerifiedHubAsker{return Object.freeze({hubId:p.issuer,id:p.subject.id,kind:p.subject.kind,...(p.subject.displayName===undefined?{}:{displayName:p.subject.displayName})});}
