import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubAgentCatalogs } from "../src/hub/agent-catalog.js";
import { HubCore } from "../src/hub/http/core.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubRequestContext } from "../src/hub/types.js";
import Database from "better-sqlite3";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
const body = (revision = "a".repeat(64)) => ({ revision, enabled: true, requests: false, agents: [{ instance: "Docs", displayName: "Document helper", description: "Explains documents.", avatar: null, kind: "agent", general: false, shareable: true }] });
async function world() {
  const r = rig = await s3bRig();
  const owner = r.addPerson("owner"), other = r.addPerson("other"), id = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: "Laptop" });
  });
  const link = r.link(id, owner, 1, ["welcome-caps-v1", "agent-catalog-v1"]);
  r.http.memberConnected!(link);
  return { r, owner, other, id, link, report: (v: unknown, l = link) => r.http.receive(r.frame("agent.catalog", v, l) as never, l) };
}
it("keeps unshared metadata owner-only; the administrator and public agent catalog cannot discover it", async () => {
  const { r, id, report } = await world();
  await report(body());
  const owner = await r.signIn("owner"), admin = await r.signIn("admin"), other = await r.signIn("other");
  const response = await r.call(owner, "GET", "/hub/v1/me/agents");
  expect(response.status).toBe(200);
  expect(response.json.fleets).toEqual([{ id, label: "Laptop", connected: true, catalogSupported:true, catalog: { ...body(), at: expect.any(Number) } }]);
  for (const session of [admin, other]) expect((await r.call(session,"GET","/hub/v1/me/agents")).json.fleets).toEqual([]);
  expect(JSON.stringify((await r.call(admin,"GET","/hub/v1/catalog")).json)).not.toContain("Document helper");
  expect((await r.call(null,"GET","/hub/v1/me/agents")).status).toBe(401);
  expect((await r.call(owner,"GET","/hub/v1/me/agents?owner=other")).status).toBe(400);
});
it("retains offline metadata, clears it when switched off, and refuses foreign, stale and unoffered reports", async () => {
  const { r, id, owner, other, link, report } = await world();
  await report(body());
  await expect(report({ ...body(), agents: [{ ...body().agents[0], displayName: "Changed" }] })).rejects.toMatchObject({ code: "conflict" });
  await expect(report(body(), r.link(id, other, 2, ["welcome-caps-v1","agent-catalog-v1"]))).rejects.toMatchObject({ code: "revoked" });
  await expect(report(body(), r.link(id, owner, 3, ["welcome-caps-v1"]))).rejects.toMatchObject({ code: "incompatible" });
  link.alive = false;
  await expect(report(body())).rejects.toMatchObject({ code: "stale" });
  const session = await r.signIn("owner");
  expect((await r.call(session,"GET","/hub/v1/me/agents")).json.fleets[0]).toMatchObject({ connected:false,catalog:body() });
  await r.restartHttp();
  expect((await r.call(session,"GET","/hub/v1/me/agents")).json.fleets[0]).toMatchObject({ connected:false,catalog:body() });
  const fresh=r.link(id,owner,4,["welcome-caps-v1","agent-catalog-v1"]);
  await report({ revision:"b".repeat(64),enabled:false,requests:false,agents:[] },fresh);
  expect((await r.call(session,"GET","/hub/v1/me/agents")).json.fleets[0].catalog).toMatchObject({enabled:false,agents:[]});
  r.setEligible("owner",false);
  expect((await r.call(session,"GET","/hub/v1/me/agents")).status).toBe(401);
});
it("purges a removed Fleet's private catalog and never shows it after revocation", async () => {
  const {r,id,report}=await world();await report(body());const session=await r.signIn("owner");
  r.store.mutate({requestId:randomUUID(),at:Date.now(),actor:{kind:"local-host"},action:"fixture.revoke",result:"completed"},state=>{
    const f=state.fleets.find(f=>f.id===id)!;f.status="revoked";f.credentialHash=null;
  });
  expect((await r.call(session,"GET","/hub/v1/me/agents")).json.fleets).toEqual([]);
  expect(r.db.prepare("SELECT fleet_id FROM hub_agent_catalogs").all()).toEqual([]);
});
it("requires a real current cookie session, never a directory-shaped app context or administrator substitution",async()=>{
  const {r,owner,report}=await world();await report(body());await r.signIn("owner");
  const service=new HubAgentCatalogs(new HubCore(r.httpDeps,r.sql));
  const session=r.db.prepare("SELECT id FROM hub_sessions WHERE person=?").get(personKeyString(owner)) as {id:string};
  let current=true;
  const ctx:HubRequestContext={requestId:randomUUID(),current:async()=>({kind:"directory",person:owner,sessionId:session.id}),
    requirePerson:async()=>owner,requireAdmin:async()=>{throw Error("not used");},isCurrent:()=>current};
  expect((await service.view(ctx)).fleets).toHaveLength(1);
  for(const altered of [
    {...ctx,current:async()=>({kind:"directory" as const,person:owner,sessionId:`mcp:${randomUUID()}`})},
    {...ctx,current:async()=>({kind:"directory" as const,person:owner,sessionId:randomUUID()})},
    {...ctx,current:async()=>({kind:"directory" as const,person:r.admin,sessionId:session.id})},
  ])await expect(service.view(altered)).rejects.toMatchObject({code:expect.stringMatching(/denied|revoked/)});
  current=false;await expect(service.view(ctx)).rejects.toMatchObject({code:"denied"});
});
it("upgrades the catalog independently without rewriting exposures and refuses the older registry",()=>{
  const db=new Database(":memory:"),older=HUB_HTTP_MIGRATIONS.filter(m=>m.component!=="s3-agent-catalog");
  try {
    applyHubMigrations(db,older);
    db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Docs',1,'published','agent','[]',?,42)")
      .run(randomUUID(),randomUUID(),`corp/${randomUUID()}`,"a".repeat(64));
    const before=db.prepare("SELECT * FROM hub_exposures").all();
    applyHubMigrations(db,HUB_HTTP_MIGRATIONS);applyHubMigrations(db,HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_exposures").all()).toEqual(before);
    expect(db.prepare("SELECT version FROM hub_schema WHERE component='s3-agent-catalog'").get()).toEqual({version:1});
    expect(db.prepare("SELECT * FROM hub_agent_catalogs").all()).toEqual([]);
    expect(()=>applyHubMigrations(db,older)).toThrow(/s3-agent-catalog/);
  }finally{db.close();}
});
