import {afterEach,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {createHash} from "node:crypto";
import {s3bRig} from "./helpers/hub-s3b-rig.js";
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await rig?.close();rig=undefined;vi.restoreAllMocks();});
async function world(){rig=await s3bRig();rig.addPerson("member","Example Person");const admin=await rig.signIn("admin"),member=await rig.signIn("member");return{admin,member};}
it("offers the composed app pages to browser sessions without adding a member-link capability",async()=>{
  const w=await world(),session=await rig!.call(w.member,"GET","/hub/v1/session");expect(session.json.features).toContain("mcp-apps-v1");
  expect((w.member.body as {csrf:string;features?:string[]}).features).toContain("mcp-apps-v1");expect(rig!.http.features).not.toContain("mcp-apps-v1");
});
it("reports the person's default-off app allowance beside the public setup address",async()=>{
  const w=await world();expect((await rig!.call(w.member,"GET","/hub/v1/me/ai-apps")).json).toMatchObject({apps:[],address:"https://hub.example.test/mcp",available:false});
  const policy=await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps");expect((await rig!.call(w.admin,"PATCH","/hub/v1/admin/ai-apps",{...policy.json,enabled:true})).status).toBe(200);
  expect((await rig!.call(w.member,"GET","/hub/v1/me/ai-apps")).json.available).toBe(true);
});
it("uses bounded administrator directory suggestions even before app access is enabled",async()=>{
  const w=await world(),objectId=randomUUID();
  rig!.directory.searchGrantPeople=vi.fn(async()=>({ok:true as const,truncated:false,people:[{person:rig!.admin,login:"admin",displayName:"Example Admin"}]}));
  rig!.directory.searchPolicyGroups=vi.fn(async()=>({ok:true as const,truncated:false,groups:[{objectId,cn:"Project",dn:"CN=Project,DC=example,DC=test"}]}));
  Object.defineProperty(rig!.directory,"groupPolicy",{value:"ad-direct-guid",configurable:true});
  expect((await rig!.call(w.member,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex")).status).toBe(403);
  expect((await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex")).json.people).toEqual([{person:rig!.admin,login:"admin",displayName:"Example Admin"}]);
  expect((await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=group&q=Pr")).json.groups).toEqual([{objectId,cn:"Project",dn:"CN=Project,DC=example,DC=test"}]);
  expect((await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=x")).status).toBe(400);
  for(let i=2;i<30;i++)expect((await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex")).status).toBe(200);
  expect((await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex")).status).toBe(429);
});
it("does not reveal a held directory search after its administrator session ends",async()=>{
 const w=await world();let finish!:(value:any)=>void;rig!.directory.searchGrantPeople=vi.fn(()=>new Promise<any>(r=>{finish=r;}));
 const reading=rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex");await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
 expect((await rig!.call(w.admin,"DELETE","/hub/v1/session")).status).toBe(200);finish({ok:true,truncated:false,people:[{person:rig!.admin,login:"admin",displayName:"Held private result"}]});
 const out=await reading;expect(out.status).toBe(403);expect(JSON.stringify(out.json)).not.toContain("Held private result");
});
it("refuses oversized directory results rather than returning a partial unvalidated suggestion",async()=>{
 const w=await world();rig!.directory.searchGrantPeople=async()=>({ok:true,truncated:false,people:Array.from({length:21},()=>({person:rig!.admin,login:"admin",displayName:"Not returned"}))});
 const out=await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps/search?kind=person&q=Ex");expect(out.status).toBe(400);expect(JSON.stringify(out.json)).not.toContain("Not returned");
});
it.each(["http://127.0.0.1:43123/callback","https://other-app.example/receive?client=owned"])("shows the selected return origin on browser consent without echoing redirect path or query (%s)",async redirect=>{
 const w=await world(),policy=await rig!.call(w.admin,"GET","/hub/v1/admin/ai-apps");await rig!.call(w.admin,"PATCH","/hub/v1/admin/ai-apps",{...policy.json,enabled:true});
 const client=await rig!.call(null,"POST","/mcp/oauth/register",{client_name:"Claude Code",redirect_uris:[redirect]});
 const query=new URLSearchParams({client_id:client.json.client_id,redirect_uri:redirect,response_type:"code",resource:"https://hub.example.test/mcp",code_challenge_method:"S256",code_challenge:createHash("sha256").update("v".repeat(43)).digest("base64url")});
 const response=await fetch(rig!.base+"/mcp/oauth/authorize?"+query,{redirect:"manual"}),request=new URL(response.headers.get("location")!,rig!.base).searchParams.get("request");
 const view=await rig!.call(w.member,"GET","/hub/v1/mcp/consent?request="+request);expect(view.status).toBe(200);expect(view.json).toMatchObject({name:"Claude Code",redirectOrigin:new URL(redirect).origin});expect(view.json.redirectOrigin).not.toContain("receive");
});
