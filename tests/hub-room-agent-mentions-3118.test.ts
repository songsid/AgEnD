/** M-3118 fail-first: actual Hub HTTP/SQLite/audit, with inert authenticated Fleet links only. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const caps = ["welcome-caps-v1", "room-ask-v1", "room-post-v1"];
async function world(now?: () => number) {
  r = await s3bRig({ realAudit: true, now });
  const person = r.addPerson("alex", "Alex"), alex = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const exposure = (displayName: string): HubExposure => ({ id: randomUUID(), fleetId, owner: r!.admin, displayName,
    revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const a = exposure("Notes"), b = exposure("Planner");
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [a, b] }, link) as never, link);
  const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Agents", people: [personKeyString(person)] });
  expect(room.status).toBe(200); const id = room.json.room.id as string;
  for (const agent of [a, b]) expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: agent.id })).status).toBe(200);
  const asks = () => [...new Map(r!.sent.filter(s => s.frame.type === "room.ask").map(s => { const p = s.frame.payload as HubRoomAsk; return [p.messageId, p] as const; })).values()];
  const page = async () => (await r!.call(alex, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages as any[];
  const human = async () => {
    const out = await r!.call(alex, "POST", `/hub/v1/rooms/${id}/messages`, { text: "@Notes start", mentions: [a.id], idempotencyKey: randomUUID() });
    expect(out.status).toBe(200); await vi.waitFor(() => expect(asks()).toHaveLength(1)); return out.json;
  };
  const answer = (ask: HubRoomAsk, text: string, answerId = randomUUID()) => r!.http.receive(r!.frame("room.answer", {
    messageId: ask.messageId, roomId: id, exposureId: ask.exposureId, answerId, text,
  }, link) as never, link);
  const post = (agent: HubExposure, text: string, room = id, key = randomUUID(), receiptId?: string) => r!.http.receive(r!.frame("room.post", { exposureId: agent.id, room, text, idempotencyKey: key, ...(receiptId ? {onBehalfOf:{receiptId}} : {}) }, link) as never, link);
  return { id, a, b, link, alex, admin, asks, page, human, answer, post };
}

it("turns an agent answer's @person into a real mention and @agent into an attributed ask", async () => {
  const w = await world(); await w.human();
  const detail = (await r!.call(w.alex, "GET", `/hub/v1/rooms/${w.id}`)).json;
  await w.answer(w.asks()[0]!, "@Alex please review. @Planner can you check?");
  const messages = await w.page(), answer = messages.find(m => m.text.includes("please review"));
  expect(answer.mentions).toContain(detail.me.id);
  await vi.waitFor(() => expect(w.asks()).toHaveLength(2));
  expect(w.asks()[1]).toMatchObject({ exposureId: w.b.id, text: "@Alex please review. @Planner can you check?" });
  expect(w.asks()[1]!.asker.name).toContain("Notes");
  const list = (await r!.call(w.alex, "GET", "/hub/v1/rooms?v=2")).json.rooms;
  expect(list.find((room: any) => room.id === w.id)).toMatchObject({ mentioned: true });
});

it("a fail-first two-agent loop stops after depth three and retains the last answer plus a stop line", async () => {
  const w = await world(); await w.human();
  await w.answer(w.asks()[0]!, "@Planner check it");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(2));
  await w.answer(w.asks()[1]!, "@Notes check again");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(3));
  const before = (await w.page()).filter(m => m.author.kind === "system").length;
  const terminal = w.asks()[2]!, answerId = randomUUID();
  await w.answer(terminal, "@Planner one more time", answerId);
  await w.answer(terminal, "@Planner one more time", answerId); // exact answer retry is inert
  const messages = await w.page();
  expect(w.asks()).toHaveLength(3);
  expect(messages.filter(m => m.text === "@Planner one more time")).toHaveLength(1);
  expect(messages.filter(m => m.author.kind === "system")).toHaveLength(before + 1);
});

it("lets a member agent post before any human ask, with exact operation replay", async () => {
  const w = await world(), operation = randomUUID(), body = { exposureId: w.a.id, room: w.id, text: "Morning update", idempotencyKey: operation };
  const post = () => r!.http.receive(r!.frame("room.post", body, w.link) as never, w.link);
  const first = await post();
  expect(first).toMatchObject({ type: "room.post-result", payload: { ok: true, roomId: w.id } });
  const second = await post();
  expect(second).toMatchObject({ payload: (first as any).payload });
  const messages = await w.page();
  expect(messages.filter(m => m.text === "Morning update")).toHaveLength(1);
  expect(messages.find(m => m.text === "Morning update").author).toMatchObject({ kind: "agent", id: w.a.id, name: "Notes" });
});

it("only a fresh proactive post after quiet AND drained asks resets; delayed answers and exact retries do not", async () => {
  let now = Date.now(); const w = await world(() => now);
  const first = await w.post(w.a, "@Planner daily report");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(1));
  now += 31 * 60_000;
  // A still-pending agent ask prevents a timer/quiet reset. B's delayed answer keeps the original lineage.
  await w.answer(w.asks()[0]!, "@Notes follow up");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(2));
  await w.answer(w.asks()[1]!, "@Planner one more");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(3));
  await w.answer(w.asks()[2]!, "@Notes loop");
  expect(w.asks()).toHaveLength(3);
  // Tool switching within this episode inherits B's depth3.
  await w.post(w.b, "@Notes still stopped"); expect(w.asks()).toHaveLength(3);
  now += 31 * 60_000;
  await w.post(w.b, "@Notes next daily report");
  await vi.waitFor(() => expect(w.asks()).toHaveLength(4));
  expect((first as any).payload.ok).toBe(true);
});

it("a pending ask prevents a fresh proactive reset even after31min; a person still resets immediately", async () => {
  let now = Date.now(); const w = await world(() => now); await w.human();
  await w.answer(w.asks()[0]!, "@Planner second"); await vi.waitFor(() => expect(w.asks()).toHaveLength(2));
  await w.answer(w.asks()[1]!, "@Notes third"); await vi.waitFor(() => expect(w.asks()).toHaveLength(3));
  now += 31 * 60_000;
  await w.post(w.a, "@Planner no quiet reset while I have an answer pending"); expect(w.asks()).toHaveLength(3);
  const msg = await r!.call(w.alex, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "@Notes new human question", mentions: [w.a.id], idempotencyKey: randomUUID() });
  expect(msg.status).toBe(200); await vi.waitFor(() => expect(w.asks()).toHaveLength(4));
});

it("keeps exact operation identity across room rename; rejects changed bodies and other room memberships", async () => {
  const w = await world(), key = randomUUID();
  const first = await w.post(w.a, "Update", "Agents", key);
  expect((await r!.call(w.admin,"PATCH",`/hub/v1/rooms/${w.id}`,{name:"Renamed"})).status).toBe(200);
  expect(await w.post(w.a, "Update", "Agents", key)).toMatchObject({payload:(first as any).payload});
  expect(await w.post(w.a, "Changed", "Agents", key)).toMatchObject({payload:{ok:false,code:"conflict"}});
  expect(await w.post(w.a, "Elsewhere", randomUUID())).toMatchObject({payload:{ok:false,code:"not-found"}});
  w.link.alive = false;
  await expect(w.post(w.a, "After disconnect")).rejects.toMatchObject({code:"stale"});
});

it("bounds a source at5 actions/min, keeps a rate stop visible and spends nothing on exact retry", async () => {
  let now = Date.now(); const w = await world(() => now), key = randomUUID();
  const first = await w.post(w.a,"one",w.id,key);
  for(let i=0;i<4;i++) expect((await w.post(w.a,`update${i}`) as any).payload.ok).toBe(true);
  expect(await w.post(w.a,"one",w.id,key)).toMatchObject({payload:(first as any).payload});
  expect(await w.post(w.a,"blocked")).toMatchObject({payload:{ok:false,code:"rate-limited",retryAt:now+60_000}});
  await w.post(w.a,"blocked again");
  expect((await w.page()).filter(m=>m.system?.reason==="rate")).toHaveLength(1);
  now+=60_000; expect((await w.post(w.a,"allowed") as any).payload.ok).toBe(true);
});

it("quietly ignores self, refuses @all, and keeps ambiguous names out of both asks and real people mentions", async () => {
  const w=await world(); await w.post(w.a,"@Notes self");
  expect((await w.page()).filter(m=>m.system?.kind==="agent-mention-stopped")).toHaveLength(0);
  await w.post(w.a,"@All agents @Planner everyone"); expect(w.asks()).toHaveLength(0);
  expect((await w.page()).filter(m=>m.system?.reason==="all")).toHaveLength(1);
  r!.db.prepare("UPDATE hub_exposures SET display_name='Alex' WHERE id=?").run(w.b.id);
  await w.post(w.a,"@Alex which one?"); expect(w.asks()).toHaveLength(0);
  expect((await w.page()).filter(m=>m.system?.reason==="ambiguous")).toHaveLength(1);
});

it("posts a verified owner's request via the agent without fabricating person membership, and respects room @all policy", async () => {
  const w=await world(), detail=(await r!.call(w.alex,"GET",`/hub/v1/rooms/${w.id}`)).json;
  const adminMember=detail.members.find((m:any)=>m.role==="manager");
  expect((await r!.call(w.admin,"PATCH",`/hub/v1/rooms/${w.id}/members/${detail.me.id}`,{role:"manager"})).status).toBe(200);
  expect((await r!.call(w.admin,"DELETE",`/hub/v1/rooms/${w.id}/members/${adminMember.id}`)).status).toBe(200);
  expect((await r!.call(w.alex,"PATCH",`/hub/v1/rooms/${w.id}`,{allMention:false})).status).toBe(200);
  const receipt=`hmsg-${randomUUID()}`;
  expect(await w.post(w.a,"@All agents ask from Telegram",w.id,randomUUID(),receipt)).toMatchObject({payload:{ok:false,code:"denied"}});
  expect((await r!.call(w.alex,"PATCH",`/hub/v1/rooms/${w.id}`,{allMention:true})).status).toBe(200);
  const result=await w.post(w.a,"@All agents ask from Telegram",w.id,randomUUID(),receipt);
  expect(result).toMatchObject({payload:{ok:true}}); await vi.waitFor(()=>expect(w.asks()).toHaveLength(2));
  const post=(await w.page()).find(m=>m.id===(result as any).payload.messageId);
  expect(post.author).toMatchObject({kind:"person",via:{id:w.a.id,name:"Notes"}});
  expect(post.proactive).toBeUndefined(); expect(post.mentions).toContain("all");
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='person'").get(w.id)).toEqual({n:1});
});

it("retains one episode per receipt and never resets it by reusing the same owner instruction", async () => {
  let now=Date.now(); const w=await world(()=>now), receipt=`hmsg-${randomUUID()}`;
  const first=await w.post(w.a,"@Planner original request",w.id,randomUUID(),receipt);
  await vi.waitFor(()=>expect(w.asks()).toHaveLength(1));
  await w.answer(w.asks()[0]!,"@Notes follow up"); await vi.waitFor(()=>expect(w.asks()).toHaveLength(2));
  await w.answer(w.asks()[1]!,"@Planner third"); await vi.waitFor(()=>expect(w.asks()).toHaveLength(3));
  await w.answer(w.asks()[2]!,"@Notes stops");
  now+=31*60_000;
  const reused=await w.post(w.a,"@Planner same instruction",w.id,randomUUID(),receipt);
  const row=r!.db.prepare("SELECT root_id,depth FROM hub_room_post_lineage WHERE post_id=?").get((reused as any).payload.messageId);
  expect(row).toEqual({root_id:(first as any).payload.messageId,depth:2});
  await vi.waitFor(()=>expect(w.asks()).toHaveLength(4));
  await w.answer(w.asks()[3]!,"@Notes still stops"); expect(w.asks()).toHaveLength(4);
  now+=60_000;
  const fresh=await w.post(w.a,"@Planner a new human instruction",w.id,randomUUID(),`hmsg-${randomUUID()}`);
  expect(r!.db.prepare("SELECT root_id,depth FROM hub_room_post_lineage WHERE post_id=?").get((fresh as any).payload.messageId)).toEqual({root_id:(fresh as any).payload.messageId,depth:0});
});

it("durably returns an answer against the original postId until an exact current-link ACK, across HTTP restart", async () => {
  const w=await world(), receipt=`hmsg-${randomUUID()}`, operation=randomUUID(), result=await w.post(w.a,"@Planner answer my manager",w.id,operation,receipt);
  await vi.waitFor(()=>expect(w.asks()).toHaveLength(1));
  const answerId=randomUUID(); await w.answer(w.asks()[0]!,"The answer",answerId);
  const returns=()=>r!.sent.filter(s=>s.frame.type==="room.post-answer").map(s=>s.frame.payload as any);
  await vi.waitFor(()=>expect(returns()).toHaveLength(1));
  const value=returns()[0]; expect(value).toMatchObject({idempotencyKey:operation,postId:(result as any).payload.messageId,roomId:w.id,exposureId:w.a.id,receiptId:receipt,message:{text:"The answer",author:{name:"Planner"}}});
  await w.answer(w.asks()[0]!,"The answer",answerId);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_post_returns").get()).toEqual({n:1});
  w.link.alive=false; await r!.restartHttp(); const link=r!.link(w.link.fleetId,w.link.owner,2,caps);
  await r!.http.receive(r!.frame("agent.state",{exposureId:w.a.id,state:"idle"},link) as never,link);
  await vi.waitFor(()=>expect(returns()).toHaveLength(2)); expect(returns()[1]).toEqual(value);
  const foreign=r!.link(randomUUID(),w.link.owner,1,caps);
  await r!.http.receive(r!.frame("room.post-answer-ack",{id:value.id},foreign) as never,foreign);
  expect(r!.db.prepare("SELECT acked FROM hub_room_post_returns").get()).toEqual({acked:0});
  await r!.http.receive(r!.frame("room.post-answer-ack",{id:value.id},link) as never,link);
  expect(r!.db.prepare("SELECT acked FROM hub_room_post_returns").get()).toEqual({acked:1});
  await r!.http.receive(r!.frame("agent.state",{exposureId:w.a.id,state:"idle"},link) as never,link);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_post_returns").get()).toEqual({n:0});
});

it("returns only the agent's current room members, with presence, and bounds read calls", async () => {
  const w=await world();
  const members=(room:string)=>r!.http.receive(r!.frame("room.members",{exposureId:w.a.id,room},w.link) as never,w.link);
  const first=await members(w.id); expect(first).toMatchObject({type:"room.members-result",payload:{ok:true,roomId:w.id}});
  expect((first as any).payload.members.find((m:any)=>m.name==="Alex")).toMatchObject({kind:"person",presence:"online"});
  expect((first as any).payload.members.find((m:any)=>m.name==="Planner")).toMatchObject({kind:"agent",owner:{name:expect.any(String)}});
  expect(await members(randomUUID())).toMatchObject({payload:{ok:false,code:"not-found"}});
  for(let i=0;i<28;i++) expect((await members(w.id) as any).payload.ok).toBe(true);
  expect(await members(w.id)).toMatchObject({payload:{ok:false,code:"backpressure"}});
});

it("does not disclose chained answers, mentions or unread to somebody who joined after the original question", async () => {
  const w=await world(); await w.human();
  const person=r!.addPerson("late","Late"), late=await r!.signIn("late");
  expect((await r!.call(w.admin,"POST",`/hub/v1/rooms/${w.id}/members`,{kind:"person",id:personKeyString(person)})).status).toBe(200);
  await w.answer(w.asks()[0]!,"@Planner continue"); await vi.waitFor(()=>expect(w.asks()).toHaveLength(2));
  await w.answer(w.asks()[1]!,"@Late original answer");
  const rows=(await r!.call(late,"GET",`/hub/v1/rooms/${w.id}/messages`)).json.messages;
  expect(rows.some((m:any)=>m.text.includes("continue")||m.text.includes("original answer"))).toBe(false);
  expect((await r!.call(late,"GET","/hub/v1/rooms?v=2")).json.rooms.find((m:any)=>m.id===w.id)).toMatchObject({unread:0,mentioned:false});
});

it("uses the same owner-visible person search, strips directory-only fields and fences held reads", async () => {
  const w=await world(), {createHubGroupPolicyStore,groupPolicyMigration}=await import("../src/hub/group-policy/store.js");
  const person=r!.people.get("alex")!.key;
  const lookup=vi.fn(async()=>({ok:true as const,people:[{person,login:"alex",displayName:"Alex"}],truncated:false}));
  r!.directory.searchGrantPeople=lookup;
  groupPolicyMigration(r!.hubId,"corp","directory-v1").up(r!.db);
  const policy=createHubGroupPolicyStore({db:r!.db,hubId:r!.hubId,realm:"corp",generation:"directory-v1",directory:r!.directory,audit:{appendInTransaction(){}} as never,current:()=>true});
  r!.httpDeps.grantDirectory={policy:()=>policy,binding:()=>({kind:"ready"})} as any;
  const ui=await r!.call(w.admin,"POST",`/hub/v1/exposures/${w.a.id}/grant-subjects/search`,{exposureRevision:1,kind:"person",q:"Al"});
  expect(ui.status).toBe(200);
  const found=await r!.http.receive(r!.frame("people.search",{exposureId:w.a.id,q:"Al"},w.link) as never,w.link);
  expect(found).toMatchObject({type:"people.search-result",payload:{ok:true,people:[{id:personKeyString(person),name:ui.json.people[0].displayName,login:ui.json.people[0].login}]}});
  let finish!:(v:any)=>void; r!.directory.searchGrantPeople=()=>new Promise(resolve=>{finish=resolve;});
  const pending=r!.http.receive(r!.frame("people.search",{exposureId:w.a.id,q:"Al"},w.link) as never,w.link);
  await vi.waitFor(()=>expect(finish).toBeTypeOf("function")); w.link.alive=false;
  finish({ok:true,people:[{person,login:"alex",displayName:"Held private name"}],truncated:false});
  expect(await pending).toMatchObject({payload:{ok:false}});
  expect(JSON.stringify(await pending)).not.toContain("Held private name");
});

it("shares the5/source budget across rooms and caps the room at30 accepted actions", async () => {
  const w=await world();
  const other=await r!.call(w.admin,"POST","/hub/v1/rooms",{name:"Other"});
  expect((await r!.call(w.admin,"POST",`/hub/v1/rooms/${other.json.room.id}/members`,{kind:"agent",id:w.a.id})).status).toBe(200);
  for(let i=0;i<5;i++) expect((await w.post(w.a,`update${i}`) as any).payload.ok).toBe(true);
  expect(await w.post(w.a,"sixth across rooms",other.json.room.id)).toMatchObject({payload:{ok:false,code:"rate-limited"}});
  const extras=Array.from({length:5},(_,i)=>({...w.a,id:randomUUID(),displayName:`Agent ${i}`}));
  await r!.http.receive(r!.frame("exposure.snapshot",{revision:2,exposures:[w.a,w.b,...extras]},w.link) as never,w.link);
  for(const e of extras) expect((await r!.call(w.admin,"POST",`/hub/v1/rooms/${w.id}/members`,{kind:"agent",id:e.id})).status).toBe(200);
  for(const agent of [w.b,...extras.slice(0,4)]) for(let i=0;i<5;i++) expect((await w.post(agent,`update${i}`) as any).payload.ok).toBe(true);
  expect(await w.post(extras[4]!,"room31")).toMatchObject({payload:{ok:false,code:"rate-limited"}});
});

it("retains the complete long answer while forwarding a bounded question to another agent", async () => {
  const w=await world();await w.human();const text="@Planner "+"x".repeat(100_000);
  await w.answer(w.asks()[0]!,text);await vi.waitFor(()=>expect(w.asks()).toHaveLength(2));
  expect((await w.page()).find(m=>m.text===text)).toBeDefined();expect(Buffer.byteLength(w.asks()[1]!.text)).toBeLessThanOrEqual(64*1024);
});

it("refuses a foreign Fleet, missing capability, paused publication, and an operation replay after membership replacement", async () => {
  const w=await world(), input={exposureId:w.a.id,room:w.id,text:"owned",idempotencyKey:randomUUID()};
  const send=(link:typeof w.link)=>r!.http.receive(r!.frame("room.post",input,link) as never,link);
  const foreign=r!.link(randomUUID(),w.link.owner,1,caps);
  expect(await send(foreign)).toMatchObject({payload:{ok:false,code:"denied"}});
  const old=r!.link(w.link.fleetId,w.link.owner,2,["welcome-caps-v1","room-ask-v1"]);
  expect(await send(old)).toMatchObject({payload:{ok:false,code:"denied"}});
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1 WHERE id=?").run(w.a.id);
  expect(await send(w.link)).toMatchObject({payload:{ok:false,code:"denied"}});
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=0 WHERE id=?").run(w.a.id);
  expect(await send(w.link)).toMatchObject({payload:{ok:true}});
  const member=r!.db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(w.id,w.a.id) as any;
  r!.db.prepare("UPDATE hub_room_members SET id=? WHERE id=?").run(randomUUID(),member.id);
  expect(await send(w.link)).toMatchObject({payload:{ok:false,code:"denied"}});
});

it("coalesces tool-rate stops within a window and refreshes them in a later window without a new post in that room",async()=>{
  let now=Date.now();const w=await world(()=>now);
  const other=(await r!.call(w.admin,"POST","/hub/v1/rooms",{name:"Other"})).json.room.id;
  await r!.call(w.admin,"POST",`/hub/v1/rooms/${other}/members`,{kind:"agent",id:w.a.id});
  for(let i=0;i<5;i++) await w.post(w.a,`first${i}`);
  await w.post(w.a,"refused");await w.post(w.a,"refused again");
  expect((await w.page()).filter(m=>m.system?.reason==="rate")).toHaveLength(1);
  now+=60_000;
  for(let i=0;i<5;i++) await w.post(w.a,`other${i}`,other);
  await w.post(w.a,"refused next window");
  const stops=(await w.page()).filter(m=>m.system?.reason==="rate");expect(stops).toHaveLength(2);
  expect(stops[1].system.retryAt).toBeGreaterThan(stops[0].system.retryAt);
});
