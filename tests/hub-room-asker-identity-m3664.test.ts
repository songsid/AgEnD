import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {issuerKeyId} from '../src/hub/identity.js';
import {roomAskBaseSchema,roomAskSchema} from '../src/hub/protocol.js';
import {roomAskIdentityDigest,signRoomAsker,verifyRoomAsker,roomAskerSnapshot,type RoomAskerBinding} from '../src/hub/room-asker-identity.js';
import type {HubRoomAskerIdentity} from '../src/hub/room-asker-identity-model.js';
function fixture(){
 const keys=generateKeyPairSync('ed25519'),now=1_000_000;
 const ask={messageId:randomUUID(),roomId:randomUUID(),exposureId:randomUUID(),roomName:'Example room',asker:{name:'Example asker'},text:'A fixture question',context:[{author:'Example member',text:'Earlier words',at:now-1}]};
 const binding:RoomAskerBinding={hubId:randomUUID(),issuerKeyId:issuerKeyId(keys.publicKey),issuerPublicKey:keys.publicKey,fleetId:randomUUID(),linkEpoch:3,exposureRevision:2,now};
 const unsigned:Omit<HubRoomAskerIdentity,'signature'>={v:1,issuer:binding.hubId,issuerKeyId:binding.issuerKeyId,destinationFleetId:binding.fleetId,messageId:ask.messageId,roomId:ask.roomId,exposureId:ask.exposureId,exposureRevision:2,linkEpoch:3,subject:{kind:'person',id:'example/person-a',displayName:'Example asker'},contentDigest:roomAskIdentityDigest(ask),issuedAt:now,expiresAt:now+120000,retainedUntil:now+3600000,nonce:'a'.repeat(64)};
 return{ask,binding,keys,unsigned,proof:signRoomAsker(unsigned,keys.privateKey)};
}
describe('M3664 signed room asker proof',()=>{
 it.each(['person','agent','assistant']as const)('preserves %s as an opaque stable identity, never a human owner',kind=>{
  const f=fixture(),proof=signRoomAsker({...f.unsigned,subject:{kind,id:'example/stable-id',displayName:'Same name'}},f.keys.privateKey);const p=verifyRoomAsker(proof,f.ask,f.binding);
  expect(roomAskerSnapshot(p)).toEqual({hubId:f.binding.hubId,kind,id:'example/stable-id',displayName:'Same name'});expect(Object.isFrozen(roomAskerSnapshot(p))).toBe(true);expect(roomAskerSnapshot(p)).not.toHaveProperty('owner');expect(roomAskerSnapshot(p)).not.toHaveProperty('authority');
 });
 it('keeps the legacy schema strict and unchanged while the optional wire shape accepts the proof',()=>{const f=fixture();expect(roomAskBaseSchema.safeParse({...f.ask,askerIdentity:f.proof}).success).toBe(false);expect(roomAskSchema.safeParse(f.ask).success).toBe(true);expect(roomAskSchema.safeParse({...f.ask,askerIdentity:f.proof}).success).toBe(true);});
 it('canonicalizes object key order without omitting text, context or name',()=>{const f=fixture();const reordered={context:f.ask.context.map(r=>({at:r.at,text:r.text,author:r.author})),text:f.ask.text,asker:{name:f.ask.asker.name},exposureId:f.ask.exposureId,roomName:f.ask.roomName,roomId:f.ask.roomId,messageId:f.ask.messageId};expect(roomAskIdentityDigest(reordered)).toBe(roomAskIdentityDigest(f.ask));expect(verifyRoomAsker(f.proof,reordered,f.binding)).toEqual(f.proof);});
 it.each(['issuer','issuerKeyId','destinationFleetId','messageId','roomId','exposureId','exposureRevision','linkEpoch','contentDigest','issuedAt','expiresAt','retainedUntil','nonce','signature','subject']as const)('refuses tampering with signed %s',field=>{
  const f=fixture();const proof:any=structuredClone(f.proof);proof[field]=field==='subject'?{...proof.subject,kind:'agent'}:typeof proof[field]==='number'?proof[field]+1:field==='signature'?Buffer.alloc(64,1).toString('base64url'):field==='issuerKeyId'||field==='contentDigest'||field==='nonce'?'b'.repeat(64):randomUUID();expect(()=>verifyRoomAsker(proof,f.ask,f.binding)).toThrow();
 });
 it.each(['text','context','asker','roomName']as const)('binds the exact accepted payload field %s',field=>{const f=fixture(),ask:any=structuredClone(f.ask);ask[field]=field==='context'?[]:field==='asker'?{name:'Another same-role name'}:'Other words';expect(()=>verifyRoomAsker(f.proof,ask,f.binding)).toThrow();});
 it.each(['hubId','issuerKeyId','fleetId','linkEpoch','exposureRevision']as const)('refuses wrong expected %s',field=>{const f=fixture(),b:any={...f.binding};b[field]=typeof b[field]==='number'?b[field]+1:field==='issuerKeyId'?'b'.repeat(64):randomUUID();expect(()=>verifyRoomAsker(f.proof,f.ask,b)).toThrow();});
 it('refuses a different issuer key despite matching metadata',()=>{const f=fixture();expect(()=>verifyRoomAsker(f.proof,f.ask,{...f.binding,issuerPublicKey:generateKeyPairSync('ed25519').publicKey})).toThrow();});
 it('rejects a late FIRST admission, future issue, overlong freshness and overlong retention',()=>{
  const f=fixture();expect(()=>verifyRoomAsker(f.proof,f.ask,{...f.binding,now:f.proof.expiresAt})).toThrow();
  for(const delta of[{issuedAt:f.binding.now+5001},{expiresAt:f.binding.now+120001},{retainedUntil:f.binding.now+86400001}]){const proof=signRoomAsker({...f.unsigned,...delta},f.keys.privateKey);expect(()=>verifyRoomAsker(proof,f.ask,f.binding)).toThrow();}
 });
 it.each(['attachments','contextState','brief']as const)('binds negotiated %s rather than a words-only projection',field=>{const f=fixture();const additions={attachments:[{id:randomUUID(),name:'example.txt',mime:'text/plain',size:1,sha256:'b'.repeat(64)}],contextState:{generation:randomUUID(),after:0,through:2},brief:{kind:'first' as const,purpose:'Example purpose',people:2,agents:1}};const ask={...f.ask,[field]:additions[field]};const proof=signRoomAsker({...f.unsigned,contentDigest:roomAskIdentityDigest(ask)},f.keys.privateKey);expect(()=>verifyRoomAsker(proof,ask,f.binding)).not.toThrow();expect(()=>verifyRoomAsker(proof,f.ask,f.binding)).toThrow();});
 it('does not confuse same-name subjects or accept body/tool-field identity bags',()=>{const f=fixture(),other=signRoomAsker({...f.unsigned,subject:{...f.unsigned.subject,id:'example/person-b'}},f.keys.privateKey);expect(roomAskerSnapshot(f.proof).id).not.toBe(roomAskerSnapshot(other).id);expect(()=>roomAskIdentityDigest({...f.ask,verifiedAsker:{id:'owner'}})).toThrow();expect(roomAskSchema.safeParse({...f.ask,askerIdentity:{...f.proof,authority:'owner'}}).success).toBe(false);});
});
