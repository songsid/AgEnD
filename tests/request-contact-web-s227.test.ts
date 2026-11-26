/** Real admitted sessions, identity resolver, store-bound service and public-link provenance; no browser/account login. */
import {PassThrough} from "node:stream";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {WebSessionStore,csrfTokenFor,tokenEpoch} from "../src/web-session.js";
import {noAuthority} from "../src/authority/web-authority.js";
import {bindGatewayRequest} from "../src/web-request-context.js";
import {isPublicWebRoute} from "../src/public-web-gateway.js";
import {handleWebRequest} from "../src/web-api.js";
const clean:Array<()=>void>=[];afterEach(()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())fn();});
const token="d".repeat(48);
function rig(options:{gateway?:boolean;named?:boolean;tier?:"admin"|"guest"|"read";owner?:boolean;host?:boolean;webOnly?:boolean;adapter?:string}={}){
 const home=mkdtempSync(join(tmpdir(),"s227-web-"));clean.push(()=>rmSync(home,{recursive:true,force:true}));const box=new DeliveryOutbox(join(home,"outbox.db"));clean.push(()=>box.close());const sessions=new WebSessionStore();let verified=false,allowed=true,link=true,epoch=0;
 const session=sessions.create({tier:options.tier??"admin",surface:options.gateway?"gateway":"local",...(options.gateway?{exposureId:"fixture-link"}:{}),label:"Demo browser",tokenEpoch:tokenEpoch(token),...(options.owner===false?{}:{owner:{adapterId:options.adapter??"dc",userId:"demo-admin"}}),...(options.host?{host:true}: {})});
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:home,configPath:join(home,"fleet.yaml"),settingsRuntimeRevision:0,webSessions:sessions,deliveryOutbox:box,
  adapters:new Map([["dc",{id:"dc",type:"discord"}],["sibling",{id:"sibling",type:"discord"}]]),worlds:new Map(),lifecycle:{daemons:new Map()},
  fleetConfig:{defaults:{},channels:[{id:"dc",type:"discord"},{id:"sibling",type:"discord"}],instances:{source:{display_name:"Demo source"},target:{display_name:"Demo target"}}},classicChannels:{getAll:()=>[],isAdmin:()=>false},
  ensureDeliveryOutbox:()=>{},contactGeneration:(name:string)=>`${name}-v1`,isWebOnlyFleet:()=>!!options.webOnly,contactRoom:()=>undefined,getInstanceAdapterId:()=>"dc",getDaemonBootId:()=>"boot",hubContactRestricted:()=>false,
  isFleetAdmin:(id:string)=>allowed&&id==="demo-admin",adminListOf:()=>allowed?["demo-admin"]:[],scheduleDeliveryOutboxPump:vi.fn(),sweepContactAuthorizationOutcomes:vi.fn(),emitSseEvent:vi.fn(),logger:{error:vi.fn(),warn:vi.fn(),debug:vi.fn()},
  webAuthority:()=>({authority:verified?{kind:"web-verified",actor:options.webOnly?{adapter_id:"host",user_id:"operator"}:{adapter_id:options.adapter??"dc",user_id:"demo-admin"},session:{authorized_at:"fixture-authorized"},authority_epoch:epoch}:noAuthority(epoch),refusal:verified?undefined:"not_verified"})});
 Object.defineProperty(fm,"webToken",{get:()=>token});
 const ticket=box.contactAuthorizations.hold({operationId:randomUUID(),source:"source",target:"target",sourceGeneration:"source-v1",targetGeneration:"target-v1",verb:"send_to_instance",origin:{kind:"human",people:[{platform:"discord",adapterId:"dc",userId:"demo-person",label:"Demo person"}],receiptIds:[],chain:[]},message:"PRIVATE_REQUEST",correlationId:randomUUID(),resultRecipient:"source",payload:{type:"fleet_inbound",content:"PRIVATE_REQUEST"}});
 const api=fm.makeRequestContactApi(),ctx:any={requestContactApi:api,webToken:token,webSessions:sessions,logger:fm.logger,getUiStatus:()=>({instances:[]}),listWebPrompts:()=>[],needsYouItems:()=>[],contactPendingCount:()=>({count:99,since:1}),sseClients:new Set()};
 const request=(method="GET",suffix="",csrf=true,header=false)=>{
  const path=suffix==="poll"?"/ui/poll":`/ui/api/request-contact-authorizations/${ticket.id}${suffix}`,origin=options.gateway?"https://fixture.invalid":"http://127.0.0.1:19280";
  const req:any=Object.assign(new PassThrough(),{method,url:path,headers:{host:options.gateway?"fixture.invalid":"127.0.0.1:19280",origin,...(header?{authorization:`Bearer ${token}`}:{cookie:`${options.gateway?"__Host-agend_session":"agend_session"}=${session.sessionId}`}),...(csrf?{"x-agend-csrf":csrfTokenFor(session.sessionId)}:{})},socket:{remoteAddress:"127.0.0.1"}});
  if(options.gateway)bindGatewayRequest(req,{surface:"gateway",named:options.named,exposureId:"fixture-link",expectedOrigin:origin,isCurrent:()=>link});
  let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;}),res:any={destroyed:false,writableEnded:false,headersSent:false,status:0,body:"",setHeader:vi.fn(),writeHead:(status:number)=>{res.status=status;res.headersSent=true;},end:(text:string)=>{res.body=text;res.writableEnded=true;finish();}};
  expect(handleWebRequest(req,res,new URL(path,origin),ctx)).toBe(true);
  return {req,res,done:async()=>{await done;return {status:res.status,body:JSON.parse(res.body)};}};
 };
 return {fm,box,api,session,sessions,ticket,request,verified:(v:boolean)=>{verified=v;epoch++;},allowed:(v:boolean)=>{allowed=v;},link:(v:boolean)=>{link=v;}};
}
it.each([{}, {gateway:true,named:false},{gateway:true,named:true}])("recognized unverified manager reads the full same card on surface %j",options=>{
 const f=rig(options);return f.request().done().then(result=>{expect(result.status).toBe(200);expect(result.body).toMatchObject({ticket:{message:"PRIVATE_REQUEST"},actions:{canDecide:false,requiresVerification:true}});expect(JSON.stringify(result.body)).not.toContain(f.session.record.handle);expect(f.box.listPending()).toEqual([]);});
});
it("sibling-bot session reads the same manager-scoped card",async()=>{const f=rig({adapter:"sibling"});expect((await f.request().done()).status).toBe(200);});
it.each([{tier:"guest" as const},{tier:"read" as const},{owner:false},{owner:false,host:true}])("non-manager identity shape %j cannot obtain a card",async options=>{const f=rig(options);const result=await f.request().done();expect(result.status).toBe(401);expect(JSON.stringify(result)).not.toContain("PRIVATE_REQUEST");});
it("recognized web-only host is readable, without inventing host identity on a chat fleet",async()=>{const f=rig({owner:false,host:true,webOnly:true});expect((await f.request().done()).status).toBe(200);});
it("header token is not the session's PersonKey even if it has administrator API access",async()=>{const f=rig();expect((await f.request("GET","",true,true).done()).status).toBe(401);});
it("current target-manager loss removes read access immediately",async()=>{const f=rig();f.allowed(false);const result=await f.request().done();expect(result.status).toBe(404);expect(JSON.stringify(result)).not.toContain("PRIVATE_REQUEST");});
it.each([false,true])("verified explicit decision works with link=%s; verification alone never admits",async gateway=>{
 const f=rig({gateway});const first=await f.request().done();f.verified(true);expect(f.box.listPending()).toEqual([]);const r=f.request("POST","/decision");r.req.end(JSON.stringify({snapshot:first.body.snapshot,decision:"approve-once"}));expect((await r.done()).status).toBe(200);expect(f.box.listPending()).toHaveLength(1);
});
it("cookie POST without CSRF is refused before the writer",async()=>{const f=rig();f.verified(true);const r=f.request("POST","/decision",false);expect(()=>f.fm.requestContactPrincipal(r.req,new URL(r.req.url,"http://127.0.0.1:19280"))).toThrow(/csrf/);expect((await r.done()).status).toBe(401);expect(f.box.listPending()).toEqual([]);r.req.end();});
it("link retirement during body read refuses continuation",async()=>{const f=rig({gateway:true});f.verified(true);const view=await f.request().done(),r=f.request("POST","/decision");f.link(false);r.req.end(JSON.stringify({snapshot:view.body.snapshot,decision:"approve-once"}));expect([401,403]).toContain((await r.done()).status);expect(f.box.listPending()).toEqual([]);});
it("authority revocation during body read cannot borrow a later verification",async()=>{const f=rig();f.verified(true);const view=await f.request().done(),r=f.request("POST","/decision");f.verified(false);f.verified(true);r.req.end(JSON.stringify({snapshot:view.body.snapshot,decision:"approve-once"}));expect((await r.done()).status).toBe(403);expect(f.box.listPending()).toEqual([]);});
it("new routes are explicitly available over every public-link gateway",()=>{const id=`R${randomUUID()}`;expect(isPublicWebRoute("GET","/ui/api/request-contact-authorizations")).toBe(true);expect(isPublicWebRoute("GET",`/ui/api/request-contact-authorizations/${id}`)).toBe(true);expect(isPublicWebRoute("POST",`/ui/api/request-contact-authorizations/${id}/decision`)).toBe(true);});

it("active-host Needs you supplies scoped ticket ids before verification and never the global count",async()=>{
 const f=rig();const result=await f.request("GET","poll").done();expect(result.status).toBe(200);expect(result.body.needs).toEqual([expect.objectContaining({reason:"contact_request",contactTicket:{id:f.ticket.id,source:"source",target:"target"}})]);f.allowed(false);expect((await f.request("GET","poll").done()).body.needs).toEqual([]);
});
