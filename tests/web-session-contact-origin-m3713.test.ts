import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ReplyButtonStore } from "../src/reply-buttons.js";
import { ReplyButtonsController } from "../src/reply-buttons-controller.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { webHumanOrigin, queryHumanReceipt, isWebSessionIdentity } from "../src/human-delivery-receipts.js";
import { noAuthority } from "../src/authority/web-authority.js";
const cleanup:Array<()=>void>=[], token="d".repeat(48),base="http://127.0.0.1:19280";
afterEach(()=>{cleanup.splice(0).forEach(f=>f());});
function rig(owner=true, userId="demo-admin",tier:"admin"|"guest"="admin"){
 const dir=mkdtempSync(join(tmpdir(),"web-origin-")),outbox=new DeliveryOutbox(join(dir,"outbox.db")),buttons=new ReplyButtonStore(join(dir,"buttons.db"));
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{deliveryOutbox:outbox,managerBootId:"demo-boot",adapters:new Map([["demo-bot",{id:"demo-bot",type:"discord"}]]),worlds:new Map(),
  fleetConfig:{channels:[{id:"demo-bot",type:"discord"}],instances:{worker:{}}},contactRoom:()=>({restrictedMode:true}),getInstanceAdapterId:()=>"demo-bot",contactGeneration:()=>"demo-generation",
  isFleetAdmin:(id:string)=>id==="demo-admin",isWebOnlyFleet:()=>false,logger:{warn:vi.fn(),error:vi.fn()}});
 let payload:any;
 const ctl=new ReplyButtonsController({store:buttons,now:Date.now,adapterFor:()=>undefined,mayClick:()=>true,
  deliver:async(_set,_button,by)=>{payload=fm.humanReceiptPayload("worker",{type:"fleet_inbound",content:"[button] Continue",meta:{user_id:"forged-admin",web_verified:"1"}},by.humanOrigin,"[button] Continue");return true;},
  publish:()=>{},admitResults:()=>true,monotonic:()=>performance.now(),logger:{info:()=>{},warn:()=>{}},setTimer:()=>0,clearTimer:()=>{}});
 fm.replyButtons=()=>ctl;
 const set=ctl.prepare({instance:"worker",adapterId:"demo-bot",chatId:"demo-room"},[{label:"Continue",value:"Continue"}]);buttons.bind(set.id,"demo-post");
 const sessions=new WebSessionStore(),session=sessions.create({tier,surface:"local",label:"Demo browser",tokenEpoch:tokenEpoch(token),...(owner?{owner:{adapterId:"demo-bot",userId}}:{})});
 const ctx:any={webToken:token,webSessions:sessions,fleetConfig:fm.fleetConfig,instanceIpcClients:new Map(),emitSseEvent:vi.fn(),logger:fm.logger,sseClients:new Set(),getUiStatus:()=>({instances:[]}),listWebPrompts:()=>[],
  webPerson:()=>({key:"demo",bound:owner,userId,name:"Demo person",voterKey:"demo-voter",set:false}),webAuthority:()=>({authority:noAuthority(0),refusal:"not_verified"}),
  ...(fm.webSessionIdentity?{webSessionIdentity:fm.webSessionIdentity.bind(fm)}:{}),clickWebReplyButton:fm.clickWebReplyButton.bind(fm)};
 cleanup.push(()=>{ctl.stop();buttons.close();outbox.close();rmSync(dir,{recursive:true,force:true});});
 async function click(options:{revoke?:boolean;cookie?:boolean;spoof?:boolean;path?:string;body?:Record<string,unknown>}={}){
  const req:any=Object.assign(new EventEmitter(),{method:"POST",url:options.path??"/ui/reply-button",headers:{host:"127.0.0.1:19280",origin:base,"x-agend-csrf":csrfTokenFor(session.sessionId),...(options.cookie===false?{authorization:`Bearer ${token}`}:{cookie:`agend_session=${session.sessionId}`})},socket:{remoteAddress:"127.0.0.1"},destroy:vi.fn()});
  let status=0,body="";const res:any={headersSent:false,destroyed:false,setHeader:()=>{},writeHead:(n:number)=>{status=n;},end:(s="")=>{body=s;}};
  handleWebRequest(req,res,new URL(req.url,base),ctx);
  if(options.revoke)sessions.revokeByHandle(session.record.handle);
  req.emit("data",Buffer.from(JSON.stringify(options.body??{instance:"worker",id:set.id,index:0,...(options.spoof?{identity:{platform:"discord",adapter_id:"demo-bot",user_id:"demo-admin"}}:{})})));req.emit("end");
  for(let i=0;i<100&&!status;i++)await new Promise<void>(r=>setImmediate(r));
  return {status,body:JSON.parse(body)};
 }
 return {fm,outbox,click,session,ctx,payload:()=>payload};
}
it("an unverified account's actual web button keeps its identity without go-ahead authority",async()=>{
 const r=rig();expect((await r.click()).status).toBe(200);
 expect(r.outbox.contactAuthorizations.origin("worker")).toMatchObject({kind:"human",people:[{platform:"discord",adapterId:"demo-bot",userId:"demo-admin"}]});
 const payload=r.payload(),receipt=r.outbox.getHumanReceipt(payload.meta.human_receipt_id)!;
 expect(JSON.parse(receipt.authority_json!)).toEqual(noAuthority(0));expect(payload.meta.web_verified).toBeUndefined();
 expect(JSON.parse(receipt.origin_json).web_identity).toMatchObject({platform:"discord",adapter_id:"demo-bot",user_id:"demo-admin",session_handle:r.session.record.handle});
});
it("an identified non-admin stays that person rather than unknown, and remains contact-restricted",async()=>{
 const r=rig(true,"demo-member");expect((await r.click({spoof:true})).status).toBe(200);
 const origin=r.outbox.contactAuthorizations.origin("worker")!;expect(origin).toMatchObject({kind:"human",people:[{userId:"demo-member"}]});expect(r.fm.contactAdminOf("worker",origin.people[0])).toBe(false);
});
it("an unbound session cannot acquire the payload's claimed admin identity",async()=>{
 const r=rig(false);expect((await r.click({spoof:true})).status).toBe(200);expect(r.outbox.contactAuthorizations.origin("worker")?.kind).toBe("unknown");
});
it("revocation while reading the body prevents the click and any origin record",async()=>{
 const r=rig();expect((await r.click({revoke:true})).status).toBe(401);expect(r.payload()).toBeUndefined();expect(r.outbox.contactAuthorizations.origin("worker")).toBeUndefined();
});
it("old unknown history is not laundered by a new identified admin input",async()=>{
 const r=rig();r.outbox.contactAuthorizations.inheritOrigin("worker",{kind:"unknown",people:[],receiptIds:[],chain:["worker"]});
 expect((await r.click()).status).toBe(200);expect(r.outbox.contactAuthorizations.origin("worker")?.kind).toBe("unknown");
});

it("a raw header token supplies no session account even when its body claims one",async()=>{
 const r=rig();expect((await r.click({cookie:false,spoof:true})).status).toBe(401);expect(r.outbox.contactAuthorizations.origin("worker")).toBeUndefined();
});
it("a plain chat message uses the same server-owned identity without authority",async()=>{
 const r=rig();let saved:any;
 r.ctx.deliverHumanToInstance=async(name:string,payload:any,origin:any,body:string)=>{saved=r.fm.humanReceiptPayload(name,payload,origin,body);return true;};
 expect((await r.click({path:"/ui/send",body:{instance:"worker",message:"Hello"}})).status).toBe(200);
 expect(r.outbox.contactAuthorizations.origin("worker")).toMatchObject({kind:"human",people:[{userId:"demo-admin"}]});
 expect(JSON.parse(r.outbox.getHumanReceipt(saved.meta.human_receipt_id)!.authority_json!).kind).toBe("none");
});
it("web commands receive identity separately from their unchanged authority",async()=>{
 const r=rig();const run=vi.fn(async(..._args:any[])=>({status:200,body:{ok:true}}));r.ctx.webCommand=run;
 expect((await r.click({path:"/ui/command",body:{instance:"worker",command:"steer",args:"Hello"}})).status).toBe(200);
 expect(run.mock.calls[0]?.[1]).toMatchObject({identity:{platform:"discord",user_id:"demo-admin"},authority:{kind:"none",actor:null}});
});
it("the account remains identifiable while its configured adapter is not running",async()=>{
 const r=rig();r.fm.adapters.clear();expect((await r.click()).status).toBe(200);
 expect(r.outbox.contactAuthorizations.origin("worker")).toMatchObject({kind:"human",people:[{platform:"discord",userId:"demo-admin"}]});
});
it("host recognition requires explicit host sign-in provenance on a web-only fleet",()=>{
 const r=rig(false),session=r.session.record;r.fm.isWebOnlyFleet=()=>true;
 expect(r.fm.webSessionIdentity(session)).toBeUndefined();
 expect(r.fm.webSessionIdentity({...session,host:true})).toMatchObject({platform:"host",adapter_id:"host",user_id:"operator"});
 r.fm.isWebOnlyFleet=()=>false;expect(r.fm.webSessionIdentity({...session,host:true})).toBeUndefined();
});

it("a host sign-in on a chat fleet is not silently mapped to a chat administrator",()=>{
 const r=rig(false);
 const host=r.ctx.webSessions.create({tier:"admin",surface:"local",label:"Host browser",tokenEpoch:tokenEpoch(token),host:true});
 expect(r.fm.webSessionIdentity(host.record)).toBeUndefined();
 // The machine sign-in names no Discord/Telegram account; an explicit bound account remains identifiable.
 expect(r.fm.webSessionIdentity({...host.record,owner:{adapterId:"demo-bot",userId:"demo-admin"}})).toMatchObject({platform:"discord",user_id:"demo-admin"});
});
it("an approved device on a web-only fleet does not borrow its approving browser's identity",()=>{
 const r=rig(false);r.fm.isWebOnlyFleet=()=>true;
 const device=r.ctx.webSessions.create({tier:"admin",surface:"local",label:"Approved browser",tokenEpoch:tokenEpoch(token),via:"device"});
 expect(device.record).toMatchObject({tier:"admin",via:"device"});
 expect(r.fm.webSessionIdentity(device.record)).toBeUndefined();
 // Device approval supplies access, not an account join or the explicit host sign-in proof.
 expect(r.fm.webSessionIdentity({...device.record,host:true})).toMatchObject({platform:"host",user_id:"operator"});
});

it("a known web account in delivery_status still has authority none",async()=>{
 const r=rig();await r.click();const receipt=r.outbox.getHumanReceipt(r.payload().meta.human_receipt_id)!;
 const item=queryHumanReceipt((r.outbox as any).db,"worker",{messageId:receipt.message_id})!.items[0]!;
 expect(item.source_instance).toBe("human:web:demo-bot:demo-admin");expect(item.authority).toEqual(noAuthority(0));expect(item.origin?.platform).toBe("web");
});
it("receipt identity snapshots cannot be mutated into another account",()=>{
 const r=rig(),identity=r.fm.webSessionIdentity(r.session.record),origin=webHumanOrigin(false,noAuthority(0),identity);
 expect(Object.isFrozen(identity)).toBe(true);expect(origin.web_identity).not.toBe(identity);
 expect(isWebSessionIdentity(Object.create(identity))).toBe(false);
 expect(isWebSessionIdentity({...identity,platform:"host"})).toBe(false);
});
it("web identity cannot be attached to a platform receipt or contradict verified authority",()=>{
 const r=rig(),identity=r.fm.webSessionIdentity(r.session.record),origin=webHumanOrigin(false,noAuthority(0),identity);
 expect(()=>r.outbox.createHumanReceipt({targetInstance:"worker",originalBody:"Hello",managerBootId:"demo-boot",inputKind:"fleet_inbound",origin:{...origin,authority:undefined,platform:"discord",adapter_id:"demo-bot",user_id:"demo-admin",ingress:"message",platform_message_id:"demo-message"}})).toThrow("unavailable");
 const authority={kind:"web-verified",actor:{adapter_id:"demo-bot",user_id:"other"},authority_epoch:0,session:{handle:identity.session_handle,peer:"loopback",signed_in_at:new Date().toISOString(),authorized_at:new Date().toISOString()}} as const;
 expect(()=>r.outbox.createHumanReceipt({targetInstance:"worker",originalBody:"Hello",managerBootId:"demo-boot",inputKind:"fleet_inbound",origin:{...origin,authority}})).toThrow("unavailable");
});

it("an ordinary agent's existing admin origin survives that admin's unverified web click",async()=>{
 const r=rig();r.fm.contactRoom=()=>undefined;
 r.outbox.contactAuthorizations.inheritOrigin("worker",{kind:"human",people:[{platform:"discord",adapterId:"demo-bot",userId:"demo-admin",label:"Demo admin"}],receiptIds:[],chain:["worker"]});
 expect((await r.click()).status).toBe(200);expect(r.outbox.contactAuthorizations.origin("worker")).toMatchObject({kind:"human",people:[{userId:"demo-admin"}]});
});
