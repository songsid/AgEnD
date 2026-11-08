import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { HubRoomsService } from "../src/hub/rooms.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
async function chat(options: { now?: () => number } = {}) {
  rig = await s3bRig(options);
  const owner = rig.addPerson("owner"), asker = rig.addPerson("asker");
  const link = rig.link(randomUUID(), owner), exposureId = randomUUID();
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Reload agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await rig.signIn("owner"), a = await rig.signIn("asker");
  const grant = (await rig.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
  const roomId = (await rig.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room.id;
  const path = `/hub/v1/rooms/${roomId}/messages`;
  expect((await rig.call(a, "POST", path, { idempotencyKey: randomUUID(), text: "History survives an immediate reload" })).status).toBe(200);
  return { a, o, path, roomId, grant, owner, asker, link, exposureId };
}
it("an immediate same-session reload returns the actual chat instead of429", async () => {
  const { a, path } = await chat();
  const first = await rig!.call(a, "GET", path), reload = await rig!.call(a, "GET", path);
  expect(first.status).toBe(200);
  expect(reload.status).toBe(200);
  expect(reload.json.entries).toEqual(first.json.entries);
  expect(reload.json.entries[0].question).toBe("History survives an immediate reload");
});
it("rechecks the grant on an immediate reload, without a cached allow", async () => {
  const { a, o, path, grant } = await chat();
  expect((await rig!.call(a, "GET", path)).status).toBe(200);
  expect((await rig!.call(o, "DELETE", `/hub/v1/grants/${grant.id}?revision=1`)).status).toBe(200);
  const revoked = await rig!.call(a, "GET", path);
  expect(revoked.status).toBe(403);expect(revoked.text).not.toContain("History survives");
});
it("rechecks owner eligibility and the exact session before disclosing a reload", async () => {
  const { a, path } = await chat();
  expect((await rig!.call(a, "GET", path)).status).toBe(200);
  rig!.setEligible("owner", false);
  const denied = await rig!.call(a, "GET", path);expect(denied.status).toBe(403);expect(denied.text).not.toContain("History survives");
  rig!.setEligible("owner", true);await rig!.call(a, "DELETE", "/hub/v1/session");
  expect((await rig!.call(a, "GET", path)).status).toBe(401);
});
it("reading then sending another question returns the new history, not a stale snapshot", async () => {
  const { a, path } = await chat();
  const first = await rig!.call(a, "GET", path);
  expect((await rig!.call(a, "POST", path, { idempotencyKey: randomUUID(), text: "A newer question" })).status).toBe(200);
  const reload = await rig!.call(a, "GET", path);expect(reload.status).toBe(200);
  expect(reload.json.entries.length).toBe(first.json.entries.length + 1);
  expect(reload.json.entries.at(-1).question).toBe("A newer question");
});
it("a real request burst is bounded before more directory work, with Retry-After", async () => {
  const { a, path } = await chat();
  const time = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    for (let i = 0; i < 8; i++) expect((await rig!.call(a, "GET", path)).status).toBe(200);
    const before = rig!.directoryCalls, busy = await rig!.call(a, "GET", path);
    expect(busy.status).toBe(429);expect(busy.headers.get("retry-after")).toBe("10");
    expect(rig!.directoryCalls).toBe(before);
  } finally { time.mockRestore(); }
});
it("different rooms and cursors share the same session work allowance", async () => {
  const { a, o, path, link, owner } = await chat();
  const id = randomUUID();
  await rig!.http.receive(rig!.frame("exposure.snapshot", { revision: 2, exposures: [{ id, fleetId: link.fleetId, owner,
    displayName: "Other room", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "c".repeat(64) }] }, link) as never, link);
  const g = (await rig!.call(o,"POST","/hub/v1/grants",{exposureId:id,exposureRevision:1,login:"asker",days:7})).json.grant;
  const second = (await rig!.call(a,"POST","/hub/v1/rooms",{exposureId:id,grantId:g.id})).json.room.id;
  // Publishing the second snapshot withdraws the old exposure; use the new room and varying cursors.
  const time = vi.spyOn(performance,"now").mockReturnValue(1000);
  try {
    expect((await rig!.call(a,"GET",path)).status).toBe(403); // Refused work counts, too.
    for(let i=0;i<7;i++)expect((await rig!.call(a,"GET",`/hub/v1/rooms/${second}/messages?after=${i}`)).status).toBe(200);
    expect((await rig!.call(a,"GET",`/hub/v1/rooms/${second}/messages?after=99`)).status).toBe(429);
  } finally {time.mockRestore();}
});
it("held reads keep both physical slots and a refusal adds no directory work", async () => {
  const {a,path,asker}=await chat(),directory=rig!.directory,original=directory.checkEligibility.bind(directory);
  let release!:()=>void,entered!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),both=new Promise<void>(r=>entered=r);
  directory.checkEligibility=async person=>{if(person.objectId===asker.objectId&&count<2){count++;if(count===2)entered();await gate;}return original(person);};
  const pending=[rig!.call(a,"GET",path),rig!.call(a,"GET",path)];
  try{await both;const busy=await rig!.call(a,"GET",path);expect(busy.status).toBe(429);expect(count).toBe(2);}
  finally{release();directory.checkEligibility=original;}
  expect((await Promise.all(pending)).map(r=>r.status)).toEqual([200,200]);
  expect((await rig!.call(a,"GET",path)).status).toBe(200);
});
it("a grant expiring during an awaited owner check cannot disclose history", async () => {
  let now=1000;const {a,path,grant,owner}=await chat({now:()=>now});
  rig!.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(now+100,grant.id);
  const directory=rig!.directory,original=directory.checkEligibility.bind(directory);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  directory.checkEligibility=async person=>{if(person.objectId===owner.objectId){entered();await gate;}return original(person);};
  const pending=rig!.call(a,"GET",path);
  try{await started;now+=101;}finally{release();directory.checkEligibility=original;}
  const denied=await pending;expect(denied.status).toBe(403);expect(denied.text).not.toContain("History survives");
});
it("rechecks expiry at disclosure after projecting the current content", async () => {
  let now=1000;const {a,path,grant}=await chat({now:()=>now});
  rig!.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(now+100,grant.id);
  const content=rig!.httpDeps.content,original=content.get.bind(content);
  content.get=ref=>{const value=original(ref);now+=101;return value;};
  const denied=await rig!.call(a,"GET",path);expect(denied.status).toBe(403);expect(denied.text).not.toContain("History survives");
});

it("holds the reservation through the real HTTP room-view continuation", async () => {
  const {a,path}=await chat(), original=HubRoomsService.prototype.view;
  let release!:()=>void,entered!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),both=new Promise<void>(r=>entered=r);
  const view=vi.spyOn(HubRoomsService.prototype,"view").mockImplementation(async function(this:HubRoomsService,ctx,roomId){
    const value=await original.call(this,ctx,roomId);
    if(count<2){count++;if(count===2)entered();await gate;}
    return value;
  });
  const pending=[rig!.call(a,"GET",path),rig!.call(a,"GET",path)];
  try{await both;expect((await rig!.call(a,"GET",path)).status).toBe(429);expect(count).toBe(2);}
  finally{release();view.mockRestore();}
  expect((await Promise.all(pending)).map(r=>r.status)).toEqual([200,200]);
});
it("cannot disclose history when a grant expires in the final awaited room view", async () => {
  let now=1000;const {a,path,grant}=await chat({now:()=>now}),original=HubRoomsService.prototype.view;
  rig!.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(now+100,grant.id);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const view=vi.spyOn(HubRoomsService.prototype,"view").mockImplementation(async function(this:HubRoomsService,ctx,roomId){
    const value=await original.call(this,ctx,roomId);entered();await gate;return value;
  });
  const pending=rig!.call(a,"GET",path);
  try{await started;now+=101;}finally{release();view.mockRestore();}
  const denied=await pending;expect(denied.status).toBe(403);expect(denied.text).not.toContain("History survives");
});
