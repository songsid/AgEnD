import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
async function world() {
  let now = 1000;
  const r = rig = await s3bRig({ now: () => now, realAudit:true });
  const owner = r.addPerson("owner"), other = r.addPerson("reader"), link = r.link(randomUUID(), owner);
  const e = { id: randomUUID(), fleetId: link.fleetId, owner, displayName: "Guide", revision: 1,
    state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("reader");
  const grant = (await r.call(o,"POST","/hub/v1/grants",{exposureId:e.id,exposureRevision:1,login:"reader",days:7})).json.grant;
  return {r,o,a,e,grant,advance:()=>{now+=1000;},save:(session: typeof o,text:unknown,revision=1)=>r.call(session,"PUT",`/hub/v1/exposures/${e.id}/intro`,{revision,text})};
}
it("starts empty, publishes only an owner's explicit save, and preserves the exposure and grant",async()=>{
  const w=await world();
  expect((await w.r.call(w.o,"GET","/hub/v1/session")).json.features).toContain("agent-intros-v1");
  expect((await w.r.call(w.o,"GET","/hub/v1/exposures")).json.mine[0].intro).toBe("");
  expect((await w.save(w.o,"I handle room questions.")).status).toBe(200);
  const mine=(await w.r.call(w.o,"GET","/hub/v1/exposures")).json.mine[0];
  expect(mine).toMatchObject({intro:"I handle room questions.",introBy:"owner",introAt:1000,revision:1});
  const room=(await w.r.call(w.a,"POST","/hub/v1/rooms",{exposureId:w.e.id,grantId:w.grant.id})).json.room;
  expect((await w.r.call(w.a,"GET",`/hub/v1/rooms/${room.id}`)).json.room.agent.intro).toBe(mine.intro);
  expect(mine.grants[0].revision).toBe(w.grant.revision);
  expect((await w.r.call(w.a,"GET","/hub/v1/exposures")).json.askable[0].exposure.intro).toBe(mine.intro);
  expect((await w.save(w.a,"forged")).status).toBe(404);
  expect((await w.save(w.o,"stale",2)).status).toBe(409);
  w.advance();expect((await w.save(w.o,"")).status).toBe(200);
  expect((await w.r.call(w.o,"GET","/hub/v1/exposures")).json.mine[0]).toMatchObject({intro:"",introAt:2000});
});
it("counts visible graphemes, normalises to a single plain-text line, and refuses 51",async()=>{
  const w=await world(),family="👨‍👩‍👧‍👦";
  expect((await w.save(w.o,family.repeat(50))).status).toBe(200);
  expect((await w.save(w.o,family.repeat(51))).status).toBe(400);
  expect((await w.save(w.o,"  cafe\u0301\n\t@Guide\u001b  ")).status).toBe(200);
  expect((await w.r.call(w.o,"GET","/hub/v1/exposures")).json.mine[0].intro).toBe("café @Guide");
  expect((await w.save(w.o,{text:"bad"})).status).toBe(400);
});
