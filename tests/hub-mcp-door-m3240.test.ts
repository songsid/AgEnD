import { afterEach, expect, it, vi } from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {personKeyString} from "../src/hub/identity.js";
import type {HubExposure} from "../src/hub/types.js";
import {HUB_MCP_SCOPES} from "../src/hub/mcp/auth.js";
import {HubGroupRooms} from "../src/hub/rooms/service.js";
import {HubRoomsService} from "../src/hub/rooms.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
const clients:Client[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const client of clients.splice(0))await client.close();await rig?.close();rig=undefined;});
const resource="https://hub.example.test/mcp",redirect="http://127.0.0.1:43123/callback",verifier="v".repeat(43);
async function world(enabled=true,attachments=false,realAudit=false) {
  let now=Date.now();rig=await s3bRig({now:()=>now,attachments,realAudit});const member=rig.addPerson("member","Example Person"),other=rig.addPerson("other","Other Person");
  const admin=await rig.signIn("admin"),browser=await rig.signIn("member"),outsider=await rig.signIn("other");
  const made=await rig.call(admin,"POST","/hub/v1/rooms",{name:"Project",people:[personKeyString(member)]});expect(made.status).toBe(200);const roomId=made.json.room.id as string;
  const settings=async (value:Record<string,unknown>)=>{const current=await rig!.call(admin,"GET","/hub/v1/admin/ai-apps");return rig!.call(admin,"PATCH","/hub/v1/admin/ai-apps",{...current.json,...value});};
  if(enabled)expect((await settings({enabled:true})).status).toBe(200);
  const form=async (path:string,value:Record<string,string>)=>fetch(rig!.base+path,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(value)});
  const registered=async()=>{const r=await rig!.call(null,"POST","/mcp/oauth/register",{client_name:"Example AI",redirect_uris:[redirect],token_endpoint_auth_method:"none"});expect(r.status).toBe(201);return r.json.client_id as string;};
  const pending=async(clientId:string)=>{
    const query=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:"code",resource,state:"app-state",code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
    const r=await fetch(rig!.base+"/mcp/oauth/authorize?"+query,{redirect:"manual"});expect(r.status).toBe(302);
    return new URL(r.headers.get("location")!,rig!.base).searchParams.get("request")!;
  };
  const app=async(scopes:readonly string[]=HUB_MCP_SCOPES,who=browser)=>{
    const clientId=await registered(),request=await pending(clientId),consent=await rig!.call(who,"POST","/hub/v1/mcp/consent",{request,scopes});expect(consent.status).toBe(200);
    const callback=new URL(consent.json.location),token=await form("/mcp/oauth/token",{grant_type:"authorization_code",client_id:clientId,code:callback.searchParams.get("code")!,code_verifier:verifier,redirect_uri:redirect,resource});
    expect(token.status).toBe(200);const credentials=await token.json() as {access_token:string;refresh_token:string};
    const client=new Client({name:"Owned connector rig",version:"1"});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(rig!.base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${credentials.access_token}`}}}));
    const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});return JSON.parse((result.content as {type:string;text:string}[])[0]!.text);};
    return {client,clientId,request,credentials,call};
  };
  const exposure=async()=>{const fleetId=randomUUID(),link=rig!.link(fleetId,rig!.admin,1,["welcome-caps-v1","room-ask-v1"]);
    const e:HubExposure={id:randomUUID(),fleetId,owner:rig!.admin,displayName:"Project helper",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)};
    await rig!.http.receive(rig!.frame("exposure.snapshot",{revision:1,exposures:[e]},link) as never,link);
    expect((await rig!.call(admin,"POST",`/hub/v1/rooms/${roomId}/members`,{kind:"agent",id:e.id})).status).toBe(200);
    const grant=await rig!.call(admin,"POST","/hub/v1/grants",{exposureId:e.id,exposureRevision:1,login:"member",days:7});expect(grant.status).toBe(200);return {e,link,grant:grant.json.grant};};
  return {admin,browser,outsider,member,other,roomId,settings,registered,pending,form,app,exposure,advance:(ms:number)=>{now+=ms;}};
}
it("advertises direct Hub OAuth resource discovery without installing a local connector",async()=>{
  rig=await s3bRig();
  const response=await fetch(rig.base+"/.well-known/oauth-protected-resource/mcp");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({resource:"https://hub.example.test/mcp",authorization_servers:["https://hub.example.test"]});
});
it("requires a bearer app credential, never a Hub browser cookie, at the remote MCP door",async()=>{
  const w=await world();
  const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Cookie:w.browser.cookie,"Content-Type":"application/json"},body:"{}"});
  expect(r.status).toBe(401);expect(r.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
});
it("keeps the eight person tools static and excludes administration and Fleet tools",async()=>{
  const w=await world(),a=await w.app(),list=await a.client.listTools();
  expect(list.tools.map(t=>t.name).sort()).toEqual(["hub_room_list","hub_room_members","hub_room_read","hub_room_post","hub_agent_list","hub_ask","hub_ask_result","hub_people_search"].sort());
  expect(await a.call("hub_room_list")).toMatchObject({data:{rooms:[{id:w.roomId,name:"Project",aiApps:true}]}});
  expect(await a.call("create_instance",{name:"not-allowed"})).toMatchObject({ok:false,code:"denied"});
});
it("default-off feature denies consent and only a browser administrator can enable it",async()=>{
  const w=await world(false),id=await w.registered(),request=await w.pending(id);
  expect((await rig!.call(w.browser,"GET","/hub/v1/mcp/consent?request="+request)).status).toBe(403);
  expect((await rig!.call(w.browser,"PATCH","/hub/v1/admin/ai-apps",{revision:1,enabled:true,everyone:true,subjects:[]})).status).toBe(403);
  expect((await w.settings({enabled:true})).status).toBe(200);
});
it("separates consent browser/CSRF authority from a read-only app token",async()=>{
  const w=await world(),a=await w.app(["rooms:read"]),request=await w.pending(a.clientId);
  const bearer={Authorization:`Bearer ${a.credentials.access_token}`};
  expect((await rig!.call(null,"POST","/hub/v1/mcp/consent",{request,scopes:HUB_MCP_SCOPES},bearer)).status).toBe(403);
  expect((await rig!.call(w.browser,"POST","/hub/v1/mcp/consent",{request,scopes:HUB_MCP_SCOPES},{"X-AgEnD-Hub-CSRF":"x"})).status).toBe(403);
  expect(await a.call("hub_room_post",{room:w.roomId,text:"No scope"})).toMatchObject({ok:false,code:"denied"});
  expect((await rig!.call(null,"GET","/hub/v1/me/ai-apps",undefined,bearer)).status).toBe(403);
});
it("posts once as the company person via the app and replays an exact operation without spending a second budget",async()=>{
  const w=await world(),a=await w.app(),operationId=randomUUID(),input={room:w.roomId,text:"The test is ready.",operationId};
  const first=await a.call("hub_room_post",input);expect(first).toMatchObject({ok:true,operationId,roomId:w.roomId});
  expect(await a.call("hub_room_post",input)).toEqual(first);
  const page=await rig!.call(w.browser,"GET",`/hub/v1/rooms/${w.roomId}/messages`),messages=page.json.messages.filter((m:{text:string})=>m.text===input.text);
  expect(messages).toHaveLength(1);expect(messages[0].author).toMatchObject({kind:"person",name:"Example Person",via:{kind:"app",name:"Example AI"}});
  expect(rig!.db.prepare("SELECT used FROM hub_mcp_budgets WHERE kind='post'").get()).toEqual({used:1});
  expect(await a.call("hub_room_post",{...input,text:"Changed"})).toMatchObject({ok:false,code:"conflict"});
});
it("refuses guesses outside the person's rooms and all/assistant or attachment requests",async()=>{
  const w=await world(),a=await w.app();
  const privateRoom=await rig!.call(w.admin,"POST","/hub/v1/rooms",{name:"Private",people:[]});
  expect(await a.call("hub_room_read",{room:privateRoom.json.room.id})).toMatchObject({ok:false,code:"not-found"});
  expect(await a.call("hub_room_post",{room:w.roomId,text:"@all please answer"})).toMatchObject({ok:false,code:"all-refused"});
  expect(await a.call("hub_room_post",{room:w.roomId,text:"No",mentions:["assistant"]})).toMatchObject({ok:false,code:"invalid"});
  expect(await a.call("hub_room_post",{room:w.roomId,text:"No",files:[randomUUID()]})).toMatchObject({ok:false,code:"invalid"});
});
it("shows a disabled room but refuses its app reads/posts while the browser remains usable",async()=>{
  const w=await world(),a=await w.app();
  expect((await rig!.call(w.browser,"PATCH",`/hub/v1/rooms/${w.roomId}/ai-apps`,{enabled:false})).status).toBe(403);
  expect((await rig!.call(w.admin,"PATCH",`/hub/v1/rooms/${w.roomId}/ai-apps`,{enabled:false})).status).toBe(200);
  expect(await a.call("hub_room_list")).toMatchObject({data:{rooms:[{id:w.roomId,aiApps:false}]}});
  expect(await a.call("hub_room_read",{room:w.roomId})).toMatchObject({ok:false,code:"room-apps-off"});
  expect(await a.call("hub_room_post",{room:w.roomId,text:"No"})).toMatchObject({ok:false,code:"room-apps-off"});
  expect((await rig!.call(w.browser,"POST",`/hub/v1/rooms/${w.roomId}/messages`,{text:"A browser still works",idempotencyKey:randomUUID()})).status).toBe(200);
});
it("applies the five-post person ceiling across separate app grants",async()=>{
  const w=await world(),a=await w.app(),b=await w.app();
  for(let i=0;i<5;i++)expect(await(i%2?a:b).call("hub_room_post",{room:w.roomId,text:`Post ${i}`})).toMatchObject({ok:true});
  expect(await a.call("hub_room_post",{room:w.roomId,text:"Over limit"})).toMatchObject({ok:false,code:"backpressure"});
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_room_posts").get()).toEqual({n:5});
  for(let i=0;i<3;i++)await a.call("hub_room_post",{room:w.roomId,text:"Still over the limit"});
  const page=await rig!.call(w.browser,"GET",`/hub/v1/rooms/${w.roomId}/messages`);
  expect(page.json.messages.filter((m:{system?:{kind:string}})=>m.system?.kind==="app-rate-limited")).toHaveLength(1);
});
it("retains actual person attribution when an app mentions a room agent",async()=>{
  const w=await world(),{e}=await w.exposure(),a=await w.app();
  expect(await a.call("hub_room_post",{room:w.roomId,text:"Status?",mentions:[e.id]})).toMatchObject({ok:true});
  await vi.waitFor(()=>expect(rig!.sent.filter(s=>s.frame.type==="room.ask")).toHaveLength(1));
  const frame=rig!.sent.find(s=>s.frame.type==="room.ask")!.frame;
  expect(frame.payload).toMatchObject({asker:{name:"Example Person via Example AI"},text:"Status?",exposureId:e.id});
});
it("uses only current grants for direct asks and keeps ask-result IDs private to the app",async()=>{
  const w=await world(),{e,grant}=await w.exposure(),a=await w.app(),b=await w.app();
  expect(await a.call("hub_agent_list")).toMatchObject({data:{agents:[{id:e.id}]}});
  const operationId=randomUUID(),asked=await a.call("hub_ask",{agent:e.id,text:"Question",operationId});
  expect(asked).toMatchObject({ok:true,id:operationId,status:"still-working"});
  expect(await a.call("hub_ask",{agent:e.id,text:"Question",operationId})).toEqual(asked);
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get()).toEqual({n:1});
  const direct=rig!.db.prepare("SELECT room_id FROM hub_mcp_calls WHERE operation_id=?").get(operationId) as {room_id:string};
  const page=await rig!.call(w.browser,"GET",`/hub/v1/rooms/${direct.room_id}/messages`);
  expect(page.json.messages[0].author).toMatchObject({kind:"person",name:"Example Person",via:{kind:"app",name:"Example AI"}});
  expect(await b.call("hub_ask_result",{id:operationId})).toMatchObject({ok:false,code:"not-found"});
  expect((await rig!.call(w.admin,"DELETE",`/hub/v1/grants/${grant.id}?revision=${grant.revision}`)).status).toBe(200);
  expect(await a.call("hub_ask_result",{id:operationId})).toMatchObject({ok:false,code:"revoked"});
});
it("ends unused tokens on a real feature disable/re-enable transaction",async()=>{
  const w=await world(),a=await w.app(),b=await w.app();
  expect((await w.settings({enabled:false})).status).toBe(200);expect((await w.settings({enabled:true})).status).toBe(200);
  for(const app of[a,b]){const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${app.credentials.access_token}`,"Content-Type":"application/json"},body:"{}"});expect(r.status).toBe(401);}
});
it("ends unused grants when an allowed-list edit removes and then re-adds their person",async()=>{
  const w=await world(),subjects=[{kind:"person",id:personKeyString(w.member),name:"Example Person"},{kind:"person",id:personKeyString(w.other),name:"Other Person"}];
  expect((await w.settings({everyone:false,subjects})).status).toBe(200);
  const a=await w.app(),b=await w.app();
  expect((await w.settings({everyone:false,subjects:[{kind:"person",id:personKeyString(w.other),name:"Other Person"}]})).status).toBe(200);
  expect((await w.settings({subjects})).status).toBe(200);
  for(const app of[a,b]){const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${app.credentials.access_token}`,"Content-Type":"application/json"},body:"{}"});expect(r.status).toBe(401);}
});
it("keeps a current app token through subject additions, label edits and everyone-on widening",async()=>{
  const w=await world(),member={kind:"person",id:personKeyString(w.member),name:"Example Person"},other={kind:"person",id:personKeyString(w.other),name:"Other Person"};
  expect((await w.settings({everyone:false,subjects:[member]})).status).toBe(200);const a=await w.app();
  const live=async()=>{const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${a.credentials.access_token}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});expect(r.status).toBe(200);expect((await r.json() as {result:{tools:unknown[]}}).result.tools).toHaveLength(8);};
  expect((await w.settings({subjects:[member,other]})).status).toBe(200);await live();
  expect((await w.settings({subjects:[other,{...member,name:"Updated display label"}]})).status).toBe(200);await live();
  expect((await w.settings({everyone:true,subjects:[]})).status).toBe(200);await live();
  expect(rig!.db.prepare("SELECT state FROM hub_mcp_apps").all()).toEqual([{state:"active"}]);
});
it("ends an unused token when everyone-on is narrowed to selected subjects",async()=>{
  const w=await world(),a=await w.app();
  expect((await w.settings({everyone:false,subjects:[{kind:"person",id:personKeyString(w.member),name:"Example Person"}]})).status).toBe(200);
  const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${a.credentials.access_token}`,"Content-Type":"application/json"},body:"{}"});expect(r.status).toBe(401);
});
it("keeps the Hub assistant out of app lists and prevents the read tool from creating its conversation",async()=>{
  const w=await world();
  rig!.httpDeps.roomAssistant={available:()=>({enabled:true,backend:"owned-stub",running:0,cap:3,state:"idle"}),ask:async()=>{throw new Error("No model call allowed");},forget(){}};
  await rig!.restartHttp();const a=await w.app();await a.call("hub_room_list");
  expect(rig!.db.prepare("SELECT id FROM hub_group_rooms WHERE assistant_for=?").get(personKeyString(w.member))).toBeUndefined();
  const browser=await rig!.call(w.browser,"GET","/hub/v1/rooms?v=2"),assistant=browser.json.rooms.find((r:{assistant?:boolean})=>r.assistant);
  expect(assistant).toBeDefined();const list=await a.call("hub_room_list");
  expect(list.data.rooms.some((r:{id:string})=>r.id===assistant.id)).toBe(false);
  expect(await a.call("hub_room_read",{room:assistant.id})).toMatchObject({ok:false,code:"not-found"});
});
it("uses live Team and person subjects in the app allowed list without exposing a roster",async()=>{
  const w=await world(),teamId=randomUUID();let member=true,revision=1;
  const snapshot=()=>({id:teamId,revision,name:"Project",department:null,lead:personKeyString(rig!.admin),leads:[personKeyString(rig!.admin)],members:[personKeyString(rig!.admin),...(member?[personKeyString(w.member)]:[])]});
  rig!.httpDeps.roomTeams={read:(_db,id)=>id===teamId?snapshot():null,expand:()=>({teams:[{id:teamId,revision}],people:snapshot().members,missing:[]}),
    isMember:(_db,id,person)=>id===teamId?{revision,member:snapshot().members.includes(person)}:null};
  expect((await w.settings({everyone:false,subjects:[{kind:"team",id:teamId,name:"Project"}]})).status).toBe(200);
  const a=await w.app();expect(await a.call("hub_room_list")).toMatchObject({data:{rooms:[{id:w.roomId}]}});
  member=false;revision++;
  const denied=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${a.credentials.access_token}`,"Content-Type":"application/json"},body:"{}"});expect(denied.status).toBe(401);
  expect(rig!.db.prepare("SELECT state FROM hub_mcp_apps").all()).toEqual([{state:"ended"}]);
  expect((await w.settings({subjects:[{kind:"person",id:personKeyString(w.member),name:"Example Person"}]})).status).toBe(200);
  expect(await(await w.app()).call("hub_room_list")).toMatchObject({data:{rooms:[{id:w.roomId}]}});
});
it("unions current AD group membership and ends the person's apps after a complete negative",async()=>{
  const w=await world(),groupId=randomUUID();let joined=true;
  Object.defineProperty(rig!.directory,"groupPolicy",{value:"ad-direct-guid",configurable:true});
  rig!.directory.checkPolicyGroup=async key=>({ok:true,group:{key,dn:"CN=Example,DC=example,DC=test"}});
  rig!.directory.readPolicyGroups=async person=>({kind:"complete",person,groups:joined?[groupId]:[],observedAt:Date.now()});
  expect((await w.settings({everyone:false,subjects:[{kind:"group",id:groupId,name:"Example"}]})).status).toBe(200);
  const a=await w.app();expect(await a.call("hub_room_list")).toMatchObject({data:{rooms:[{id:w.roomId}]}});joined=false;
  const r=await fetch(rig!.base+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${a.credentials.access_token}`,"Content-Type":"application/json"},body:"{}"});expect(r.status).toBe(401);
});
it("bounds people search to display/sign-in names and thirty reads per person per minute",async()=>{
  const w=await world();let reads=0;
  rig!.directory.searchGrantPeople=async()=>{reads++;return {ok:true,truncated:false,people:[{person:w.other,login:"other",displayName:"Other Person"}]};};
  const a=await w.app();const first=await a.call("hub_people_search",{q:"Other"});
  expect(first.data).toEqual({people:[{id:personKeyString(w.other),name:"Other Person",login:"other"}],truncated:false});
  for(let i=1;i<30;i++)await a.call("hub_people_search",{q:"Other"});
  expect(await a.call("hub_people_search",{q:"Other"})).toMatchObject({ok:false,code:"backpressure",retryAt:expect.any(Number)});expect(reads).toBe(30);
});
it("caps new direct asks at thirty an hour without charging an exact duplicate",async()=>{
  const w=await world(),{e}=await w.exposure(),a=await w.app(),operationId=randomUUID();
  const first={agent:e.id,text:"Question 0",operationId};expect(await a.call("hub_ask",first)).toMatchObject({ok:true});
  expect(await a.call("hub_ask",first)).toMatchObject({ok:true});
  for(let i=1;i<30;i++)expect(await a.call("hub_ask",{agent:e.id,text:`Question ${i}`})).toMatchObject({ok:true});
  expect(await a.call("hub_ask",{agent:e.id,text:"Over limit"})).toMatchObject({ok:false,code:"backpressure",message:"Not asked: 30 questions an hour is the limit."});
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get()).toEqual({n:30});
});
it("returns the actual leased answer to this app without another browser question's text",async()=>{
  const w=await world(),{e,link}=await w.exposure(),a=await w.app();
  await rig!.http.receive(rig!.frame("reconcile",{afterReceiptSequence:0,messages:[]},link) as never,link);
  const asked=await a.call("hub_ask",{agent:e.id,text:"Status?"});expect(asked).toMatchObject({ok:true,status:"still-working"});
  await vi.waitFor(()=>expect(rig!.sent.some(s=>s.frame.type==="question")).toBe(true));
  const question=rig!.sent.find(s=>s.frame.type==="question")!.frame.payload as {identity:{messageId:string}},messageId=question.identity.messageId;
  const answerId=randomUUID(),text="Owned fixture agent answer",digest=createHash("sha256").update(text).digest("hex");
  const released=await rig!.http.receive(rig!.frame("authorize.request",{messageId,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},link) as never,link);
  expect(released?.payload).toMatchObject({ok:true});
  await rig!.http.receive(rig!.frame("answer",{messageId,answerId,text,contentDigest:digest,releaseLease:(released!.payload as {lease:unknown}).lease},link) as never,link);
  const row=rig!.db.prepare("SELECT room_id FROM hub_mcp_calls WHERE operation_id=?").get(asked.id) as {room_id:string};
  expect((await rig!.call(w.browser,"POST",`/hub/v1/rooms/${row.room_id}/messages`,{text:"A different browser question",idempotencyKey:randomUUID()})).status).toBe(200);
  const result=await a.call("hub_ask_result",{id:asked.id});expect(result).toMatchObject({ok:true,status:"answered",answer:text});
  expect(JSON.stringify(result)).not.toContain("different browser question");
});
it("keeps app posts and question handoff readable with the real encrypted store without audit content pointers",async()=>{
 const w=await world(true,false,true),{e,link}=await w.exposure(),a=await w.app();
 const post=await a.call("hub_room_post",{room:w.roomId,text:"Visible app post"});expect(post.ok).toBe(true);
 const page=await rig!.call(w.browser,"GET",`/hub/v1/rooms/${w.roomId}/messages`);
 expect(page.json.messages.find((m:{id:string})=>m.id===post.messageId)?.text).toBe("Visible app post");
 await rig!.http.receive(rig!.frame("reconcile",{afterReceiptSequence:0,messages:[]},link) as never,link);
 const asked=await a.call("hub_ask",{agent:e.id,text:"Real encrypted question"});expect(asked.status).toBe("still-working");
 await vi.waitFor(()=>expect(rig!.sent.some(s=>s.frame.type==="question")).toBe(true));
 const question=rig!.sent.find(s=>s.frame.type==="question")!.frame.payload as {text:string;identity:{messageId:string}};
 expect(question.text).toBe("Real encrypted question");
 const messageId=question.identity.messageId,answerId=randomUUID(),text="Real encrypted answer",digest=createHash("sha256").update(text).digest("hex");
 const released=await rig!.http.receive(rig!.frame("authorize.request",{messageId,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},link) as never,link);expect(released?.payload).toMatchObject({ok:true});
 await rig!.http.receive(rig!.frame("answer",{messageId,answerId,text,contentDigest:digest,releaseLease:(released!.payload as {lease:unknown}).lease},link) as never,link);
 expect(await a.call("hub_ask_result",{id:asked.id})).toMatchObject({status:"answered",answer:text});
 expect(rig!.db.prepare("SELECT content_ref FROM hub_audit WHERE message_id=? AND action='room.message'").get(post.messageId)).toEqual({content_ref:null});
 expect(rig!.db.prepare("SELECT content_ref FROM hub_audit WHERE message_id=? AND action='question.accepted'").get(messageId)).toEqual({content_ref:null});
 expect(rig!.db.prepare("SELECT record_id FROM hub_audit_content WHERE ref=(SELECT question_ref FROM hub_messages WHERE id=?)").get(messageId)).toEqual({record_id:`message:${messageId}`});
});
it("refuses app writes when the content binding provider is missing without affecting browser posts",async()=>{
 const w=await world(true,false,true),{e}=await w.exposure(),a=await w.app();rig!.httpDeps.content.bindMessage=undefined;
 const before=(rig!.db.prepare("SELECT count(*) AS n FROM hub_audit_content").get() as {n:number}).n;
 expect(await a.call("hub_room_post",{room:w.roomId,text:"Missing provider"})).toMatchObject({ok:false,code:"unavailable"});
 expect(await a.call("hub_ask",{agent:e.id,text:"Missing provider"})).toMatchObject({ok:false,code:"unavailable"});
 expect(rig!.db.prepare("SELECT count(*) AS n FROM hub_messages").get()).toEqual({n:0});
 expect((rig!.db.prepare("SELECT count(*) AS n FROM hub_audit_content").get() as {n:number}).n).toBe(before);
 expect((await rig!.call(w.browser,"POST",`/hub/v1/rooms/${w.roomId}/messages`,{text:"Browser works",idempotencyKey:randomUUID()})).status).toBe(200);
});
it("preserves the original post and person budget when an exact request is retried after a mount restart",async()=>{
  const w=await world(),a=await w.app(),input={room:w.roomId,text:"A retained post",operationId:randomUUID()},first=await a.call("hub_room_post",input);
  await rig!.restartHttp();expect(await a.call("hub_room_post",input)).toEqual(first);
  expect(rig!.db.prepare("SELECT used FROM hub_mcp_budgets WHERE kind='post'").get()).toEqual({used:1});
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_room_posts").get()).toEqual({n:1});
});
it("keeps pre-join history behind the existing audience floor",async()=>{
  const w=await world(),a=await w.app();
  const old=await rig!.call(w.admin,"POST","/hub/v1/rooms",{name:"Later join",people:[]}),roomId=old.json.room.id;
  expect((await rig!.call(w.admin,"POST",`/hub/v1/rooms/${roomId}/messages`,{text:"Before joining",idempotencyKey:randomUUID()})).status).toBe(200);
  expect((await rig!.call(w.admin,"POST",`/hub/v1/rooms/${roomId}/members`,{kind:"person",id:personKeyString(w.member)})).status).toBe(200);
  expect((await rig!.call(w.admin,"POST",`/hub/v1/rooms/${roomId}/messages`,{text:"After joining",idempotencyKey:randomUUID()})).status).toBe(200);
  const result=await a.call("hub_room_read",{room:roomId});expect(result.data.messages.some((m:{text:string})=>m.text==="After joining")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("Before joining");
});
it("returns at most fifty recent messages and reports no extra new page after a recent since anchor",async()=>{
  const w=await world(),a=await w.app();
  for(let i=0;i<55;i++)expect((await rig!.call(w.admin,"POST",`/hub/v1/rooms/${w.roomId}/messages`,{text:`Message ${i}`,idempotencyKey:randomUUID()})).status).toBe(200);
  const recent=await a.call("hub_room_read",{room:w.roomId});expect(recent.data.messages).toHaveLength(50);expect(recent.data.more).toBe(true);
  const last=recent.data.messages.at(-3),delta=await a.call("hub_room_read",{room:w.roomId,since:last.id});
  expect(delta.data.messages).toHaveLength(2);expect(delta.data.more).toBe(false);
  expect(await a.call("hub_room_read",{room:w.roomId,limit:51})).toMatchObject({ok:false,code:"invalid"});
});
it("projects attached files as names without file handles, URLs or contents",async()=>{
  const w=await world(true,true),a=await w.app();
  const uploaded=await fetch(rig!.base+`/hub/v1/rooms/${w.roomId}/files`,{method:"POST",body:"private file content",headers:{Origin:"https://hub.example.test",Cookie:w.browser.cookie,"X-AgEnD-Hub-CSRF":w.browser.csrf,"X-File-Name":"notes.txt"}});
  expect(uploaded.status).toBe(200);const file=(await uploaded.json() as {file:{id:string}}).file;
  const posted=await rig!.call(w.browser,"POST",`/hub/v1/rooms/${w.roomId}/messages`,{text:"Attached notes",files:[file.id],idempotencyKey:randomUUID()});expect(posted.status).toBe(200);
  const page=await a.call("hub_room_read",{room:w.roomId}),message=page.data.messages.find((m:{id:string})=>m.id===posted.json.id);
  expect(message.files).toEqual([{name:"notes.txt"}]);expect(JSON.stringify(page)).not.toContain(file.id);expect(JSON.stringify(page)).not.toContain("private file content");
});
it("recovers exact post and ask operations whose accepted result was lost without repeating delivery or quota",async()=>{
  const w=await world(),{e}=await w.exposure(),a=await w.app();
  const post=HubGroupRooms.prototype.post,ask=HubRoomsService.prototype.ask;
  vi.spyOn(HubGroupRooms.prototype,"post").mockImplementationOnce(async function(this:HubGroupRooms,...args){await post.apply(this,args);throw new Error("Owned lost result");});
  const input={room:w.roomId,text:"A possibly committed post",operationId:randomUUID()};
  expect(await a.call("hub_room_post",input)).toMatchObject({ok:false,operationId:input.operationId});
  expect(await a.call("hub_room_post",input)).toMatchObject({ok:true});
  vi.spyOn(HubRoomsService.prototype,"ask").mockImplementationOnce(async function(this:HubRoomsService,...args){await ask.apply(this,args);throw new Error("Owned lost result");});
  const question={agent:e.id,text:"A possibly committed ask",operationId:randomUUID()};
  expect(await a.call("hub_ask",question)).toMatchObject({ok:false,operationId:question.operationId});
  expect(await a.call("hub_ask",question)).toMatchObject({ok:true,id:question.operationId,status:"still-working"});
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_room_posts").get()).toEqual({n:1});
  expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get()).toEqual({n:1});
  expect(rig!.db.prepare("SELECT kind,used FROM hub_mcp_budgets ORDER BY kind").all()).toEqual([{kind:"ask",used:1},{kind:"post",used:1}]);
});
it("rejects duplicate OAuth form/query fields before issuing a code or consuming it",async()=>{
  const w=await world(),id=await w.registered();
  const query=new URLSearchParams({client_id:id,redirect_uri:redirect,response_type:"code",resource,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});query.append("client_id",id);
  expect((await fetch(rig!.base+"/mcp/oauth/authorize?"+query,{redirect:"manual"})).status).toBe(400);
  const token=await fetch(rig!.base+"/mcp/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=authorization_code&grant_type=refresh_token"});
  expect(token.status).toBe(400);expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_apps").get()).toEqual({n:0});
});
