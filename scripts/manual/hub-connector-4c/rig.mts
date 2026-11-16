/** Owned loopback HTTPS -> real Hub HTTP/SQLite/audit; directory and member input are inert. No live Fleet or model. */
import {createServer} from "node:https";
import {mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync} from "node:fs";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {s3bRig} from "../../../tests/helpers/hub-s3b-rig.js";
import {personKeyString} from "../../../src/hub/identity.js";
import {createHubTeams,HUB_TEAMS_MIGRATION,HUB_TEAM_MANAGEMENT_MIGRATION,HUB_TEAM_GRANTS_MIGRATION} from "../../../src/hub/teams/index.js";
import type {HubFleetExposure} from "../../../src/hub/types.js";

export function createOwnedPki(directory:string){
 mkdirSync(directory,{recursive:true,mode:0o700});const at=(name:string)=>join(directory,name);
 const run=(args:string[])=>execFileSync("openssl",args,{stdio:"ignore"});
 run(["req","-x509","-newkey","rsa:2048","-nodes","-days","2","-subj","/CN=AgEnD owned test authority","-keyout",at("ca.key"),"-out",at("ca.pem"),"-addext","basicConstraints=critical,CA:TRUE"]);
 run(["req","-new","-newkey","rsa:2048","-nodes","-subj","/CN=hub.example.com","-keyout",at("server.key"),"-out",at("server.csr")]);
 writeFileSync(at("server.ext"),"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:hub.example.com,IP:127.0.0.1\n");
 run(["x509","-req","-days","2","-in",at("server.csr"),"-CA",at("ca.pem"),"-CAkey",at("ca.key"),"-CAcreateserial","-extfile",at("server.ext"),"-out",at("server.pem")]);
 for(const name of["ca.key","server.key"])chmodSync(at(name),0o600);
 return{directory,ca:at("ca.pem"),cert:at("server.pem"),key:at("server.key")};
}
export function trustOwnedBrowserCa(pki:ReturnType<typeof createOwnedPki>,browserHome:string,certutil:string){
 // Chromium M146+ documents this shared DB: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md
 const db=join(browserHome,".local/share/pki/nssdb");mkdirSync(db,{recursive:true,mode:0o700});
 execFileSync(certutil,["-N","--empty-password","-d",`sql:${db}`],{stdio:"ignore"});
 execFileSync(certutil,["-A","-d",`sql:${db}`,"-t","C,,","-n","agend-owned-4c-authority","-i",pki.ca],{stdio:"ignore"});
}
export async function startOwnedHub(pki:ReturnType<typeof createOwnedPki>,listen:{host?:string;port?:number}={}){
 let hub:Awaited<ReturnType<typeof s3bRig>>|undefined;const callbacks=new Map<string,string>();
 const server=createServer({cert:readFileSync(pki.cert),key:readFileSync(pki.key)},(req,res)=>{
  const url=new URL(req.url||"/","https://hub.example.com");
  if(url.pathname==="/owned-callback"){const code=url.searchParams.get("code");if(code)callbacks.set(url.searchParams.get("state")||"owned",code);res.writeHead(200,{"Content-Type":"text/plain","Cache-Control":"no-store"});res.end("Returned to the owned test app.");return;}
  if(!hub||!hub.http.handle(req,res)){res.writeHead(hub?404:503);res.end();}
 });
 await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(listen.port??0,listen.host??"127.0.0.1",yes);});
 const origin=`https://hub.example.com:${(server.address() as {port:number}).port}`;
 try{
  hub=await s3bRig({webOrigin:origin,realAudit:true,attachments:true});const r=hub,casey=r.addPerson("casey","Casey"),riley=r.addPerson("riley","Riley"),group=randomUUID();
  Object.defineProperty(r.directory,"groupPolicy",{value:"ad-direct-guid",configurable:true});
  r.directory.searchGrantPeople=async q=>({ok:true,truncated:false,people:[...r.people.values()].filter(p=>p.login.includes(q.toLowerCase())||p.name.toLowerCase().includes(q.toLowerCase())).slice(0,20).map(p=>({person:p.key,login:p.login,displayName:p.name}))});
  r.directory.searchPolicyGroups=async()=>({ok:true,truncated:false,groups:[{objectId:group,cn:"Project",dn:"CN=Project,DC=example,DC=com"}]});
  r.directory.checkPolicyGroup=async key=>({ok:true,group:{key,dn:"CN=Project,DC=example,DC=com"}});
  r.directory.readPolicyGroups=async person=>({kind:"complete",person,groups:[group],observedAt:Date.now()});
  for(const migration of[HUB_TEAMS_MIGRATION,HUB_TEAM_MANAGEMENT_MIGRATION,HUB_TEAM_GRANTS_MIGRATION])migration.up(r.db);
  r.httpDeps.teams=core=>createHubTeams(core);await r.restartHttp();
  const admin=await r.signIn("admin"),person=await r.signIn("casey");
  const must=async(p:Promise<{status:number;json:any}>)=>{const out=await p;if(out.status<200||out.status>=300)throw new Error(`Owned setup refused (${out.status})`);return out.json;};
  const room=(await must(r.call(admin,"POST","/hub/v1/rooms",{name:"Project",people:[personKeyString(casey),personKeyString(riley)]}))).room;
  await must(r.call(admin,"POST",`/hub/v1/rooms/${room.id}/messages`,{text:"Welcome to Project.",idempotencyKey:randomUUID()}));
  const team=(await must(r.call(admin,"POST","/hub/v1/teams",{name:"Project team",department:group,leads:[personKeyString(r.admin)],members:[personKeyString(r.admin),personKeyString(casey)]}))).team;
  const link=r.link(randomUUID(),r.admin,1,["welcome-caps-v1","room-ask-v1"]),exposure:HubFleetExposure={id:randomUUID(),fleetId:link.fleetId,owner:r.admin,displayName:"Project helper",revision:1,state:"published",dataViewId:"owned-agent",allowedTools:[],policyDigest:"a".repeat(64)};
  await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[exposure]},link) as never,link);
  await must(r.call(admin,"POST",`/hub/v1/rooms/${room.id}/members`,{kind:"agent",id:exposure.id}));
  await must(r.call(admin,"POST","/hub/v1/grants",{exposureId:exposure.id,exposureRevision:1,login:"casey",days:7}));
  await r.http.receive(r.frame("reconcile",{afterReceiptSequence:0,messages:[]},link) as never,link);
  let running=false,closed=false;const handled=new Set<string>(),deliveries:{id:string;kind:string}[]=[];const failures:string[]=[];
  const timer=setInterval(()=>{if(running||closed)return;running=true;void(async()=>{
   for(const entry of r.sent){const type=entry.frame.type;if(type!=="question"&&type!=="room.ask")continue;const payload=entry.frame.payload as any,id=type==="question"?payload.identity.messageId:payload.messageId;if(handled.has(id))continue;handled.add(id);
    const answerId=randomUUID(),text="LARCH-42. The meeting is Tuesday at 10:00.";
    if(type==="question"){const digest=createHash("sha256").update(text).digest("hex");const released=await r.http.receive(r.frame("authorize.request",{messageId:id,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},link) as never,link);
     if(!(released?.payload as any)?.ok)throw new Error("Owned answer lease refused");await r.http.receive(r.frame("answer",{messageId:id,answerId,text,contentDigest:digest,releaseLease:(released!.payload as any).lease},link) as never,link);
    }else await r.http.receive(r.frame("room.answer",{messageId:id,roomId:payload.roomId,exposureId:exposure.id,answerId,text},link) as never,link);
    deliveries.push({id,kind:type});
   }
  })().catch(error=>failures.push(error instanceof Error?error.message:"Owned delivery failed")).finally(()=>{running=false;});},20);timer.unref();
  const setEnabled=async(enabled:boolean)=>{const current=await must(r.call(admin,"GET","/hub/v1/admin/ai-apps"));return must(r.call(admin,"PATCH","/hub/v1/admin/ai-apps",{...current,enabled}));};
  const begin=async(name="Example AI")=>{const registered=await r.call(null,"POST","/mcp/oauth/register",{client_name:name,redirect_uris:[origin+"/owned-callback"]});if(registered.status!==201)throw new Error("Owned registration failed");
   const verifier="v".repeat(43),state=randomUUID(),query=new URLSearchParams({client_id:registered.json.client_id,redirect_uri:origin+"/owned-callback",response_type:"code",resource:origin+"/mcp",state,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
   const response=await fetch(r.base+"/mcp/oauth/authorize?"+query,{redirect:"manual"});if(response.status!==302)throw new Error("Owned authorization failed");return{path:response.headers.get("location")!,state,clientId:registered.json.client_id,verifier};};
  return{origin,pki,hub:r,admin,person,personKey:personKeyString(casey),roomId:room.id,teamId:team.id,exposureId:exposure.id,deliveries,failures,setEnabled,begin,callbacks,
   async close(){closed=true;clearInterval(timer);while(running)await new Promise(yes=>setTimeout(yes,10));server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));await r.close();}};
 }catch(error){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));await hub?.close();throw error;}
}
