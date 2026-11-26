/** Runbook rehearsal only: private homes, real storage/crypto/settings; no Fleet or Hub runtime start. */
import { afterEach, expect, it } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { provisionHubIdentity, readHubMemberTls, verifyHubCertificate } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { HUB_INSTANCE_MIGRATION, applyHubMigrations, bindHubInstance, createHubUnitOfWork, inspectStateSet, openHubDatabase } from "../src/hub/db.js";
import { SERVER_SET, createKeyFile, readKeyFile } from "../src/hub/compose/storage.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { HUB_AUDIT_MIGRATION, createHubAudit } from "../src/hub/audit/index.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { HUB_MEMBER_ADDRESS_MIGRATION, HUB_MEMBER_RELOCATION_MIGRATION, createHubMemberAddressDecision } from "../src/hub/settings-member-address-decision.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";
import { createHubMemberAddressControl } from "../src/hub/settings-member-address-control.js";
import { prepareMemberCertificate } from "../src/hub/init/member-certificate.js";
import { HubMemberProfileStore, type HubMemberProfile } from "../src/hub/profile.js";
import { HubMemberRelocationStore, acceptHubRelocation, relocationDigest, signHubRelocation } from "../src/hub/member-origin.js";
import { sha256 } from "../src/hub/identity.js";
import { HUB_INVENTORY_PATHS, readHubInstallationInventory } from "../src/hub/init/inventory.js";

const cleanup: Array<()=>void> = [];
afterEach(()=>{ for(const stop of cleanup.splice(0).reverse()) stop(); });
const A="https://member-a.example.test:19443", B="https://member-b.example.test:19443";
const migrations=[HUB_INSTANCE_MIGRATION,HUB_TRANSPORT_MIGRATION,HUB_AUDIT_MIGRATION,HUB_COMPANY_JOIN_MIGRATION,HUB_MEMBER_ADDRESS_MIGRATION,HUB_MEMBER_RELOCATION_MIGRATION];
async function fixture(){
 const parent=mkdtempSync(join(tmpdir(),"hub-move-rehearsal-"));chmodSync(parent,0o700);cleanup.push(()=>rmSync(parent,{recursive:true,force:true}));
 const source=join(parent,"source"),destination=join(parent,"destination"),member=join(parent,"member");
 for(const p of [source,destination,member])mkdirSync(p,{mode:0o700});
 const identity=await provisionHubIdentity({home:source,memberOrigin:A});
 const hub:any={enabled:true,hubId:identity.hubId,name:"Example Hub",memberOrigin:A,webOrigin:"https://hub.example.test:18444",memberListen:{host:"127.0.0.1",port:19443},webListen:{host:"127.0.0.1",port:18444},webTls:{certificateFile:"hub/browser/cert.pem",keyFile:"hub/browser/key.pem"},directory:{realm:"example"},administrator:{realm:"example",objectId:randomUUID()},retention:{contentDays:30,eventDays:90},coexistence:"dedicated"};
 const at=new Date().toISOString(),confirmationId="a".repeat(32),planDigest=hubPlanDigest(hub);
 writeFileSync(join(source,"fleet.yaml"),yaml.dump({hub}),{mode:0o600});
 writeFileSync(join(source,"hub/init-manifest.json"),JSON.stringify({v:1,hubId:identity.hubId,planDigest,committedAt:at,confirmationId,signature:sealHubInitialization({home:source,planDigest,committedAt:at,confirmationId})}),{mode:0o600});
 writeFileSync(join(source,"hub/install-inventory.json"),JSON.stringify({v:1,purpose:"installation-record",recordedAt:at,hubId:identity.hubId,webOrigin:hub.webOrigin,memberOrigin:A,spkiSha256:identity.spkiSha256,coexistence:"dedicated",serviceLabel:"com.agend.fleet",paths:HUB_INVENTORY_PATHS}),{mode:0o600});
 new HubFileVersionFloor(source,"hub/floors/transport").initialize();createKeyFile(source,"hub/keys/content.key");
 const open=(home:string,create=false)=>{
  const db=openHubDatabase(home,"hub/hub.sqlite",{create});cleanup.push(()=>{if(db.open)db.close();});
  applyHubMigrations(db,migrations);bindHubInstance(db,identity.hubId,create?"new":"complete",Date.now());
  const audit=createHubAudit({db,contentKey:readKeyFile(home,"hub/keys/content.key")});
  const store=new HubTransportStore(db,{floor:new HubFileVersionFloor(home,"hub/floors/transport"),appendAudit:(record,tx)=>audit.appendInTransaction(record,tx)});
  if(create)store.initialize();return{home,db,store,audit};
 };
 const src=open(source,true),owner={realm:"example",objectId:randomUUID()},fleetId=randomUUID(),offlineId=randomUUID(),credential=randomBytes(32).toString("hex");
 src.store.mutate({at:Date.now(),requestId:"fixture",actor:{kind:"local-host"},action:"fixture.fleets",result:"completed"},s=>{for(const id of [fleetId,offlineId])s.fleets.push({id,owner,generation:2,credentialHash:sha256(credential),status:"active"});});
 const profile:HubMemberProfile={v:1,hub:{...identity,memberOrigin:A,webOrigin:hub.webOrigin},owner,fleetId,credential,certificatePem:readHubMemberTls({home:source}).certificatePem,issuerKeyId:identity.issuerKeyId};
 // HubPairingIdentity does not include issuerKeyId; keep the strict wire shape.
 delete (profile.hub as any).issuerKeyId;
 const profiles=new HubMemberProfileStore(member,identity.hubId);profiles.saveProfile(profile,null,()=>true);const digest=profiles.profileDigest()!;
 const mount=(state:ReturnType<typeof open>)=>{
  const config=()=>((yaml.load(readFileSync(join(state.home,"fleet.yaml"),"utf8")) as any).hub);
  const decision=createHubMemberAddressDecision({db:state.db,home:state.home,hubId:identity.hubId,transport:state.store});
  const writer=createHubSettingsWriter({home:state.home,readHub:config,saveHub:patches=>{const h=config();for(const p of patches)h[p.path[1]!]=p.value;writeFileSync(join(state.home,"fleet.yaml"),yaml.dump({hub:h}),{mode:0o600});},memberAddressDecision:()=>decision});
  return{decision,writer,config};
 };
 const copy=()=>{expect(src.db.open).toBe(false);for(const rel of ["hub","fleet.yaml"])cpSync(join(source,rel),join(destination,rel),{recursive:true});
  // Ownership is this fixture's UID; repair destination permissions before any opener, as the runbook requires.
  const privateModes=(p:string)=>{const stat=lstatSync(p);expect(stat.isSymbolicLink()).toBe(false);chmodSync(p,stat.isDirectory()?0o700:0o600);if(stat.isDirectory())for(const name of readdirSync(p))privateModes(join(p,name));};privateModes(destination);
  return open(destination);};
 const verify=(home:string)=>{const h=(yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8")) as any).hub;return verifyHubInitialization({home,hubId:identity.hubId,memberOrigin:h.memberOrigin,planDigest:hubPlanDigest(h)});};
 return{...src,src,source,destination,member,identity,profile,profiles,digest,fleetId,offlineId,copy,open,mount,verify};
}

it("cold pair keeps identity, seal, DB/floor, encrypted content and historical inventory across a different home",async()=>{
 const f=await fixture(),message=randomUUID();
 const ref=createHubUnitOfWork(f.db).atomic(tx=>{const ref=f.audit.content.put(tx,{question:"Synthetic retained question"});f.audit.content.bindMessage(tx,ref,message);return ref;});
 const before=f.store.read(),manifest=readFileSync(join(f.source,"hub/init-manifest.json"));
 f.db.pragma("wal_checkpoint(TRUNCATE)");f.db.close();const dest=f.copy();
 expect(inspectStateSet(f.destination,SERVER_SET)).toBe("complete");expect(readHubMemberTls({home:f.destination}).identity).toEqual(f.identity);
 expect(dest.store.read()).toEqual(before);expect(dest.audit.content.get(ref)).toEqual({question:"Synthetic retained question"});
 expect(f.verify(f.destination)).toBeTruthy();expect(readFileSync(join(f.destination,"hub/init-manifest.json"))).toEqual(manifest);
 expect(readHubInstallationInventory(f.destination).memberOrigin).toBe(A);
 const h=(yaml.load(readFileSync(join(f.destination,"fleet.yaml"),"utf8")) as any).hub;h.memberOrigin=B;
 expect(()=>verifyHubInitialization({home:f.destination,hubId:f.identity.hubId,memberOrigin:B,planDigest:hubPlanDigest(h)})).toThrow();
 rmSync(join(f.destination,"hub/keys/content.key"));expect(()=>inspectStateSet(f.destination,SERVER_SET)).toThrow(/partial/);
});

it("signed move keeps only the current acked Fleet; cold destination and higher-revision return preserve its pairing",async()=>{
 const f=await fixture(),m=f.mount(f.src),before=f.store.read().fleets.find(x=>x.id===f.fleetId)!,pairingBytes=readFileSync(join(f.member,`hub-member/${f.identity.hubId}/pairing.json`));
 const originStore=new HubMemberRelocationStore(f.member,f.identity.hubId);
 async function move(state:ReturnType<typeof f.open>,mounted:ReturnType<typeof f.mount>,from:string,to:string){
  const key=createPrivateKey(readFileSync(join(state.home,"hub/keys/issuer-key.pem")));
  mounted.decision.relocator={sign:(id,input)=>signHubRelocation({hubId:f.identity.hubId,issuerKeyId:f.identity.issuerKeyId,fleetId:id},{...input,spkiSha256:f.identity.spkiSha256},key),send:async(id,statement,digest)=>{
   if(id!==f.fleetId)return null;const result=acceptHubRelocation({home:f.member,profile:f.profile,profileDigest:f.digest,webOrigins:[],current:()=>true,log:()=>{},record:()=>{}},statement);
   expect(result).toMatchObject({ack:{digest}});return{fleetId:id,linkEpoch:1,digest,revision:statement.revision,link:{}};
  },linkCurrent:()=>true};
  const control=createHubMemberAddressControl({home:state.home,writer:mounted.writer,readConfig:()=>({hub:mounted.config()}),running:()=>true,settle:async()=>{},withDecision:async work=>work(mounted.decision),probe:async()=>{}});
  const context={actor:{kind:"host-owner" as const,sessionId:"fixture",requestId:"move"},ownerKey:{},authorityEpoch:1,current:()=>true};
  const prepared=await control.prepare({origin:to,listen:{host:"127.0.0.1",port:to===B?19445:19446}},context);const result=await control.commit({ref:prepared.ref},context);
  expect(mounted.config().memberOrigin).toBe(to);expect(from).not.toBe(to);expect(f.verify(state.home)).toBeTruthy();return result;
 }
 const result=await move(f.src,m,A,B);expect(result.followed).toBe(1);expect(result.reconnect.map(x=>x.id)).toEqual([f.offlineId]);
 expect(f.store.read().fleets.find(x=>x.id===f.fleetId)).toEqual(before);expect(f.store.read().fleets.find(x=>x.id===f.offlineId)).toMatchObject({generation:3,status:"revoked",credentialHash:null});
 expect(originStore.dialOrder(f.profile,f.digest)).toEqual([B,A]);
 f.db.pragma("wal_checkpoint(TRUNCATE)");f.db.close();const dest=f.copy(),dm=f.mount(dest);dm.decision.assertMounted(dm.config());
 expect(dest.store.read().fleets.find(x=>x.id===f.fleetId)).toEqual(before);expect(readHubMemberTls({home:f.destination}).identity).toEqual(f.identity);
 const pending=(originStore.read(f.profile,f.digest) as any).state.pending;originStore.promote(f.profile,f.digest,relocationDigest(pending.statement),()=>true);
 expect(originStore.dialOrder(f.profile,f.digest)).toEqual([B]);
 const rollback=await move(dest,dm,B,A);expect(rollback.followed).toBe(1);expect(originStore.dialOrder(f.profile,f.digest)).toEqual([A,B]);
 const beforeRetry=originStore.read(f.profile,f.digest);
 expect(acceptHubRelocation({home:f.member,profile:f.profile,profileDigest:f.digest,webOrigins:[],current:()=>true,log:()=>{},record:()=>{}},pending.statement)).toMatchObject({ack:{revision:1}});
 expect(originStore.read(f.profile,f.digest)).toEqual(beforeRetry);expect(originStore.dialOrder(f.profile,f.digest)).toEqual([A,B]);
 expect(readFileSync(join(f.member,`hub-member/${f.identity.hubId}/pairing.json`))).toEqual(pairingBytes);
 expect(readHubInstallationInventory(f.destination).memberOrigin).toBe(A); // historical setup evidence stays unchanged
 expect(dest.store.read().fleets.find(x=>x.id===f.offlineId)?.status).toBe("revoked");
});

it("a new-host certificate keeps the member pin but must never be served on the old hostname",async()=>{
 const f=await fixture(),certificate=await prepareMemberCertificate(f.source,B);
 expect(()=>verifyHubCertificate(certificate,B,f.identity.spkiSha256)).not.toThrow();
 expect(()=>verifyHubCertificate(certificate,A,f.identity.spkiSha256)).toThrow();
 expect(readHubMemberTls({home:f.source}).metadata.memberOrigin).toBe(A);
});

it("an actual pinned member reconnects to a stopped-copy destination at the unchanged origin without re-pairing",async()=>{
 const {hubRig}=await import("./helpers/hub-rig.js");
 const {HubPairingService}=await import("../src/hub/pairing.js");
 const {HubServer}=await import("../src/hub/server.js");
 const {default:Database}=await import("better-sqlite3");
 const r=await hubRig();
 const destination=mkdtempSync(join(tmpdir(),"hub-copy-link-"));chmodSync(destination,0o700);
 let server:InstanceType<typeof HubServer>|undefined,db:InstanceType<typeof Database>|undefined;
 try{
  const profile=await r.pair(),first=r.client();await first.value.start();expect(first.state.syncs).toBe(1);
  const pairingPath=join(r.memberHome,`hub-member/${r.identity.hubId}/pairing.json`),bytes=readFileSync(pairingPath);
  await first.value.close();await r.server.close();const before=r.store.read();r.db.pragma("wal_checkpoint(TRUNCATE)");r.db.close();expect(r.db.open).toBe(false);
  for(const rel of ["hub","test.sqlite"])cpSync(join(r.root,rel),join(destination,rel),{recursive:true});
  const privateModes=(p:string)=>{const stat=lstatSync(p);expect(stat.isSymbolicLink()).toBe(false);chmodSync(p,stat.isDirectory()?0o700:0o600);if(stat.isDirectory())for(const name of readdirSync(p))privateModes(join(p,name));};privateModes(destination);
  db=new Database(join(destination,"test.sqlite"));let floor=before.revision;
  const store=new HubTransportStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},appendAudit:(record,tx)=>{tx.prepare("INSERT INTO audit VALUES(?)").run(JSON.stringify(record));}});
  expect(store.read()).toEqual(before);
  const pairing=new HubPairingService({store,directory:r.directory,identity:{...r.identity,memberOrigin:r.memberOrigin,webOrigin:profile.hub.webOrigin},enabled:()=>true,fenceFleet:(id,reason)=>server?.fenceFleet(id,reason),refreshAuthorization:()=>server?.refreshAuthorization()});
  server=new HubServer({home:destination,hubId:r.identity.hubId,memberOrigin:r.memberOrigin,listen:{host:"127.0.0.1",port:Number(new URL(r.memberOrigin).port)},pairing,current:()=>true,hold:()=>{},receive:async(frame,link)=>frame.type==="reconcile"?{v:1,type:"reconcile",requestId:frame.requestId,linkEpoch:link.linkEpoch,payload:{receipts:[],nextReceiptSequence:0,more:false}}:undefined});
  await server.start();const second=r.client();await second.value.start();expect(second.state.syncs).toBe(1);expect(second.state.holds).toEqual([]);expect(readFileSync(pairingPath)).toEqual(bytes);expect(store.read().fleets.find(f=>f.id===profile.fleetId)).toMatchObject(before.fleets.find(f=>f.id===profile.fleetId)!);await second.value.close();
 }finally{await server?.close();db?.close();await r.close();rmSync(destination,{recursive:true,force:true});}
});
