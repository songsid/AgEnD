/** Own SQLite/Hub contexts and inert company directory; no live Hub, AD or external app. */
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubMcpAuth, HUB_MCP_APP_IDLE, HUB_MCP_ACCESS_TTL, HUB_MCP_SCOPES } from "../src/hub/mcp/auth.js";
import { HubSessions } from "../src/hub/sessions.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { advanceHubSessionEpoch } from "../src/hub/session-epoch.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
const verifier = "v".repeat(43), resource = "https://hub.example.test/mcp", uri = "http://127.0.0.1:43123/callback";
const registration = {client_name:"Example AI",redirect_uris:[uri],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"};
async function world(realAudit = false) {
  let now = 1_800_000_000_000, allowed = true, revision = 1;
  rig = await s3bRig({now:()=>now,realAudit}); rig.addPerson("member","Example Person"); rig.addPerson("other","Other Person");
  const core = new HubCore(rig.httpDeps,rig.sql), sessions = new HubSessions(core);
  const browser = async (login = "member") => { const b = await rig!.signIn(login); return sessions.context({headers:{cookie:b.cookie}} as IncomingMessage); };
  const policy = {authorize:async (_person:unknown,current:()=>boolean) => {
    if(!allowed) throw new HubProtocolError("denied"); const saved = revision;
    return {assertCurrent:()=>{if(!allowed || !current() || saved !== revision) throw new HubProtocolError("denied");}};
  }};
  const auth = new HubMcpAuth(core,policy), client = auth.register(registration);
  const begin = (extra: Record<string,unknown> = {}) => auth.begin({client_id:client.client_id,redirect_uri:uri,response_type:"code",code_challenge_method:"S256",
    code_challenge:createHash("sha256").update(verifier).digest("base64url"),resource,state:"app-state",...extra});
  const approve = async (selection = [...HUB_MCP_SCOPES], ctx?: Awaited<ReturnType<typeof browser>>) => {
    const pending = begin(); const url = new URL(await auth.approve(ctx ?? await browser(),pending.request,selection)); return {code:url.searchParams.get("code")!,url}; };
  const exchange = (code: string, extra: Record<string,unknown> = {}) => auth.exchangeCode({client_id:client.client_id,code,code_verifier:verifier,redirect_uri:uri,resource,...extra});
  const connected = async () => exchange((await approve()).code);
  return {core,sessions,auth,client,browser,begin,approve,exchange,connected,policy,now:()=>now,advance:(ms:number)=>{now+=ms;},disable:()=>{allowed=false;revision++;},enable:()=>{allowed=true;revision++;}};
}
it("registers a bounded public MCP app without a secret or person supplied by the app", async () => {
  rig = await s3bRig();
  const auth = new HubMcpAuth(new HubCore(rig.httpDeps, rig.sql), { authorize: async () => ({ assertCurrent() {} }) });
  expect(auth.register({ client_name: "Example AI", redirect_uris: ["http://127.0.0.1:43123/callback"],
    grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }))
    .toMatchObject({ client_id: expect.any(String), token_endpoint_auth_method: "none" });
});
it("validates public registration and prevents external/injected redirect schemes",async()=>{
  const w=await world();
  for(const value of ["http://example.test/callback","javascript:alert(1)","https://name:pw@example.test/callback","https://example.test/callback#fragment"])
    expect(()=>w.auth.register({...registration,redirect_uris:[value]})).toThrow();
  expect(w.auth.register({...registration,person:"chosen-by-app",client_uri:"https://app.example.test"})).not.toHaveProperty("person");
  expect(()=>w.auth.register({...registration,token_endpoint_auth_method:"client_secret_post"})).toThrow();
  expect(()=>w.auth.register({...registration,client_name:"Example\nAdmin"})).toThrow();
});
it("binds consent, code and tokens to the company person, client, resource, redirect and S256 verifier",async()=>{
  const w=await world(), ctx=await w.browser(), request=w.begin();
  expect(await w.auth.preview(ctx,request.request)).toEqual({name:"Example AI",scopes:[...HUB_MCP_SCOPES],redirectOrigin:new URL(uri).origin});
  const target=new URL(await w.auth.approve(ctx,request.request,["rooms:read"])), code=target.searchParams.get("code")!;
  expect(target.searchParams.get("state")).toBe("app-state");
  for(const extra of [{client_id:"a".repeat(43)},{redirect_uri:"http://127.0.0.1:43124/callback"},{resource:"https://other.test/mcp"},{code_verifier:"x".repeat(43)}])
    await expect(w.exchange(code,extra)).rejects.toMatchObject({error:"invalid_grant"});
  const tokens=await w.exchange(code), identity=await w.auth.authenticate(tokens.access_token);
  expect(identity.scopes).toEqual(["rooms:read"]);
  expect(await identity.context.requirePerson()).toEqual(rig!.people.get("member")!.key);
  await expect(identity.context.requireAdmin()).rejects.toMatchObject({code:"denied"});
  await expect(w.exchange(code)).rejects.toMatchObject({error:"invalid_grant"});
  await expect(w.auth.approve(ctx,request.request,["rooms:read"])).rejects.toMatchObject({error:"invalid_request"});
  const stored=JSON.stringify(rig!.db.prepare("SELECT * FROM hub_mcp_tokens").all());
  expect(stored).not.toContain(tokens.access_token); expect(stored).not.toContain(tokens.refresh_token);
});
it("never redirects to an unregistered callback and permits only the loopback port to vary",async()=>{
  const w=await world();
  for(const extra of [{redirect_uri:"https://other.test/callback"},{redirect_uri:"http://localhost:43123/callback"},{redirect_uri:uri+"/other"},{resource:"https://other.test/mcp"},{code_challenge_method:"plain"},{scope:"admin"}])
    expect(()=>w.begin(extra)).toThrow();
  expect(w.begin({redirect_uri:"http://127.0.0.1:53234/callback"}).request).toBeTruthy();
});
it("refuses an expanded consent selection, cancellation replay and expired pending requests/codes",async()=>{
  const w=await world(), ctx=await w.browser(), pending=w.begin({scope:"rooms:read"});
  await expect(w.auth.approve(ctx,pending.request,["rooms:post"])).rejects.toMatchObject({error:"invalid_scope"});
  const cancelled=new URL(w.auth.cancel(pending.request)); expect(cancelled.searchParams.get("error")).toBe("access_denied");
  await expect(w.auth.preview(ctx,pending.request)).rejects.toThrow();
  const code=(await w.approve()).code;w.advance(60_000); await expect(w.exchange(code)).rejects.toMatchObject({error:"invalid_grant"});
  const old=w.begin();w.advance(10*60_000);await expect(w.auth.preview(await w.browser(),old.request)).rejects.toThrow();
});
it("requires an enabled feature permit and a live directory browser, never local-host repair authority",async()=>{
  const w=await world(), ctx=await w.browser(), pending=w.begin();
  const off=new HubMcpAuth(w.core); await expect(off.preview(ctx,pending.request)).rejects.toMatchObject({error:"temporarily_unavailable"});
  const local={...ctx,current:async()=>({kind:"local-host" as const,sessionId:"host",directoryBinding:rig!.admin})};
  await expect(w.auth.approve(local,pending.request,["rooms:read"])).rejects.toMatchObject({error:"access_denied"});
  rig!.setEligible("member",false); await expect(w.auth.approve(ctx,pending.request,["rooms:read"])).rejects.toThrow();
  expect(rig!.db.prepare("SELECT * FROM hub_mcp_apps").all()).toHaveLength(0);
});
it("rotates refresh tokens, binds them to the client/resource and only narrows consent",async()=>{
  const w=await world(), tokens=await w.connected();
  const refresh=(extra:Record<string,unknown>={})=>w.auth.refresh({client_id:w.client.client_id,refresh_token:tokens.refresh_token,resource,...extra});
  await expect(refresh({client_id:"x".repeat(43)})).rejects.toThrow(); await expect(refresh({resource:"https://other.test/mcp"})).rejects.toThrow();
  const identity=await w.auth.authenticate(tokens.access_token), narrowed=await refresh({scope:"rooms:read"});
  expect(narrowed.scope).toBe("rooms:read"); expect(identity.context.isCurrent!()).toBe(false);
  expect((await w.auth.authenticate(narrowed.access_token)).scopes).toEqual(["rooms:read"]);
  await expect(identity.context.requirePerson()).rejects.toThrow();
  expect((await w.auth.authenticate(narrowed.access_token)).scopes).toEqual(["rooms:read"]);
  await expect(refresh()).rejects.toThrow();
  await expect(w.auth.refresh({client_id:w.client.client_id,refresh_token:narrowed.refresh_token,resource,scope:"rooms:post"})).rejects.toMatchObject({error:"invalid_scope"});
});
it("disconnect is owner-only and immediately fences an already-created context and both token kinds",async()=>{
  const w=await world(), tokens=await w.connected(), identity=await w.auth.authenticate(tokens.access_token);
  await expect(w.auth.disconnect(await w.browser("other"),identity.appId)).rejects.toThrow();
  expect((await w.auth.list(await w.browser()))[0]).toMatchObject({id:identity.appId,name:"Example AI"});
  await w.auth.disconnect(await w.browser(),identity.appId);
  expect(identity.context.isCurrent!()).toBe(false);await expect(identity.context.requirePerson()).rejects.toThrow();
  await expect(w.auth.authenticate(tokens.access_token)).rejects.toThrow();
  await expect(w.auth.refresh({client_id:w.client.client_id,refresh_token:tokens.refresh_token,resource})).rejects.toThrow();
  expect(await w.auth.list(await w.browser())).toEqual([]);
});
it("ends disabled or no-longer-allowed app grants on the next call and audits each end once",async()=>{
  const w=await world(), tokens=await w.connected(), identity=await w.auth.authenticate(tokens.access_token);
  rig!.setEligible("member",false);await expect(w.auth.authenticate(tokens.access_token)).rejects.toThrow();
  expect(identity.context.isCurrent!()).toBe(false);
  expect(rig!.audits.filter(a=>a.action==="mcp.ended")).toHaveLength(1);
  rig!.setEligible("member",true); const second=await w.connected(), secondId=await w.auth.authenticate(second.access_token);
  w.disable(); expect(secondId.context.isCurrent!()).toBe(false);
  await expect(w.auth.authenticate(second.access_token)).rejects.toThrow();
  expect(rig!.audits.filter(a=>a.action==="mcp.ended")).toHaveLength(2);
});
it("uses short access expiry and the exact 30-day idle boundary for refresh",async()=>{
  const w=await world(), tokens=await w.connected();w.advance(HUB_MCP_ACCESS_TTL);
  await expect(w.auth.authenticate(tokens.access_token)).rejects.toThrow();
  w.advance(HUB_MCP_APP_IDLE-HUB_MCP_ACCESS_TTL-1);
  const next=await w.auth.refresh({client_id:w.client.client_id,refresh_token:tokens.refresh_token,resource});
  w.advance(HUB_MCP_APP_IDLE);await expect(w.auth.refresh({client_id:w.client.client_id,refresh_token:next.refresh_token,resource})).rejects.toThrow();
  expect(rig!.audits.filter(a=>a.action==="mcp.ended"&&a.reasonCode==="expired")).toHaveLength(1);
});
it("only one concurrent code exchange and refresh can consume the same credential",async()=>{
  const w=await world(), code=(await w.approve()).code;
  const results=await Promise.allSettled([w.exchange(code),w.exchange(code)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const tokens=(results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof w.exchange>>>).value;
  const value={client_id:w.client.client_id,refresh_token:tokens.refresh_token,resource};
  const refreshed=await Promise.allSettled([w.auth.refresh(value),w.auth.refresh(value)]);
  expect(refreshed.filter(r=>r.status==="fulfilled")).toHaveLength(1);
});
it("refuses a disconnected grant after a held directory check and never revives it",async()=>{
  const w=await world(), tokens=await w.connected(), identity=await w.auth.authenticate(tokens.access_token), ctx=await w.browser();
  let release!:()=>void, entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}), start=new Promise<void>(r=>{entered=r;});
  const check=rig!.directory.checkEligibility.bind(rig!.directory);
  const spy=vi.spyOn(rig!.directory,"checkEligibility").mockImplementationOnce(async p=>{entered();await held;return check(p);});
  const pending=w.auth.authenticate(tokens.access_token);await start;
  await w.auth.disconnect(ctx,identity.appId);release();
  await expect(pending).rejects.toThrow();spy.mockRestore();
  expect(rig!.db.prepare("SELECT state FROM hub_mcp_apps WHERE id=?").get(identity.appId)).toEqual({state:"ended"});
});
it("fails closed on an unavailable directory without permanently ending an eligible grant",async()=>{
  const w=await world(), tokens=await w.connected();
  const spy=vi.spyOn(rig!.directory,"checkEligibility").mockResolvedValueOnce({eligible:false,reason:"unavailable"});
  await expect(w.auth.authenticate(tokens.access_token)).rejects.toThrow();spy.mockRestore();
  expect(rig!.audits.filter(a=>a.action==="mcp.ended")).toHaveLength(0);
  expect((await w.auth.authenticate(tokens.access_token)).name).toBe("Example AI");
});
it("records connect and consent scopes without raw credentials and makes concurrent app use independent",async()=>{
  const w=await world(), tokens=await w.connected();w.advance(1);
  const identities=await Promise.all([w.auth.authenticate(tokens.access_token),w.auth.authenticate(tokens.access_token)]);
  expect(identities.every(i=>i.context.isCurrent!())).toBe(true);
  expect(rig!.audits.filter(a=>a.action==="mcp.consented")).toMatchObject([{reasonCode:HUB_MCP_SCOPES.join(" ")}]);
  const audit=JSON.stringify(rig!.audits);expect(audit).not.toContain(tokens.access_token);expect(audit).not.toContain(tokens.refresh_token);
});
it("writes lifecycle actions through the real transactional Hub audit",async()=>{
  const w=await world(true), tokens=await w.connected(), identity=await w.auth.authenticate(tokens.access_token);
  await w.auth.disconnect(await w.browser(),identity.appId);
  const rows=rig!.db.prepare("SELECT action,reason_code,code_id FROM hub_audit WHERE action LIKE 'mcp.%' ORDER BY sequence").all();
  expect(rows).toMatchObject([{action:"mcp.connected",code_id:identity.appId},
    {action:"mcp.consented",reason_code:HUB_MCP_SCOPES.join(" ")},{action:"mcp.disconnected"}]);
});
it("fences directory epoch changes and rejects browser/member credentials as app tokens",async()=>{
  const w=await world(), tokens=await w.connected(), identity=await w.auth.authenticate(tokens.access_token), browser=await rig!.signIn("member");
  await expect(w.auth.authenticate(browser.cookie.split("=")[1]!)).rejects.toThrow();
  rig!.httpDeps.uow.atomic(tx=>advanceHubSessionEpoch(rig!.sql(tx),w.core.directoryEpoch));
  expect(identity.context.isCurrent!()).toBe(false);await expect(w.auth.authenticate(tokens.access_token)).rejects.toThrow();
});
it("does not consume an authorization code or leave a connected app on an audit failure",async()=>{
  const w=await world(), ctx=await w.browser(), pending=w.begin();
  rig!.setAuditFails(true);await expect(w.auth.approve(ctx,pending.request,["rooms:read"])).rejects.toThrow();
  expect(rig!.db.prepare("SELECT * FROM hub_mcp_apps").all()).toHaveLength(0);
  rig!.setAuditFails(false);expect(await w.auth.approve(ctx,pending.request,["rooms:read"])).toContain("code=");
});
it.each(["preview","approve","list","disconnect"] as const)("refuses an app token context at the browser-only %s boundary",async method=>{
  const w=await world(), tokens=await w.exchange((await w.approve(["rooms:read"])).code), identity=await w.auth.authenticate(tokens.access_token), pending=w.begin();
  const action=method==="preview"?()=>w.auth.preview(identity.context,pending.request):method==="approve"?()=>w.auth.approve(identity.context,pending.request,[...HUB_MCP_SCOPES])
    :method==="list"?()=>w.auth.list(identity.context):()=>w.auth.disconnect(identity.context,identity.appId);
  await expect(action()).rejects.toMatchObject({error:"access_denied"});
  expect(rig!.db.prepare("SELECT scopes,state FROM hub_mcp_apps").all()).toEqual([{scopes:JSON.stringify(["rooms:read"]),state:"active"}]);
});
it("an observed authoritative policy denial ends every app for that person before re-enable",async()=>{
  const w=await world(), a=await w.connected(), b=await w.connected();w.disable();
  await expect(w.auth.authenticate(a.access_token)).rejects.toThrow();w.enable();
  await expect(w.auth.authenticate(a.access_token)).rejects.toThrow();
  await expect(w.auth.authenticate(b.access_token)).rejects.toThrow();
  expect(rig!.db.prepare("SELECT state FROM hub_mcp_apps").all()).toEqual([{state:"ended"},{state:"ended"}]);
});
it("missing policy wiring refuses temporarily without ending any grants",async()=>{
  const w=await world(), tokens=await w.connected(), missing=new HubMcpAuth(w.core);
  await expect(missing.authenticate(tokens.access_token)).rejects.toMatchObject({error:"temporarily_unavailable"});
  expect((await w.auth.authenticate(tokens.access_token)).name).toBe("Example AI");
  expect(rig!.audits.filter(a=>a.action==="mcp.ended")).toEqual([]);
});
it("the policy disable hook ends even unused grants atomically before a later re-enable",async()=>{
  const w=await world(), a=await w.connected(), b=await w.exchange((await w.approve([...HUB_MCP_SCOPES],await w.browser("other"))).code);
  w.core.atomic(()=>w.auth.revokePolicyGrants({kind:"all"},"feature-disabled"));w.disable();w.enable();
  await expect(w.auth.authenticate(a.access_token)).rejects.toThrow();
  await expect(w.auth.authenticate(b.access_token)).rejects.toThrow();
  expect(rig!.audits.filter(a=>a.action==="mcp.ended")).toMatchObject([{reasonCode:"feature-disabled"},{reasonCode:"feature-disabled"}]);
});
it("rolls back the entire policy sweep if its second audit append fails",async()=>{
  const w=await world(), a=await w.connected(), b=await w.connected(), append=rig!.httpDeps.audit.append.bind(rig!.httpDeps.audit);let ends=0;
  const spy=vi.spyOn(rig!.httpDeps.audit,"append").mockImplementation((tx,event)=>{
    if(event.action==="mcp.ended"&&++ends===2)throw new Error("Owned audit failure");return append(tx,event);
  });
  expect(()=>w.auth.revokePolicyGrants({kind:"all"},"feature-disabled")).toThrow("Owned audit failure");spy.mockRestore();
  expect((await w.auth.authenticate(a.access_token)).name).toBe("Example AI");
  expect((await w.auth.authenticate(b.access_token)).name).toBe("Example AI");
});
