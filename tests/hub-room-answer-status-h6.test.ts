/** M-3126: optional ask.failed / ask.blocked / ask.reason on the room projection. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const caps = ["welcome-caps-v1", "room-ask-v1","room-answer-status-v1"];

async function world(opts: { assistant?: boolean; second?: boolean } = {}) {
  let at = Date.now(), enabled = true;
  r = await s3bRig({ now: () => at, realAudit: true });
  r.httpDeps.roomAssistant = { available: () => ({ enabled, backend: "inert", running: 0, cap: 3, state: enabled ? "idle" : "paused" }),
    ask: async () => ({ text: "Assistant reply" }), forget() {} };
  if (opts.assistant) await r.restartHttp();
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const exposure = (name: string): HubExposure => ({ id: randomUUID(), fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published",
    dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const e = exposure("Notes"), extra = opts.second ? exposure("Planner") : undefined;
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: extra ? [e, extra] : [e] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)], assistant: opts.assistant === true });
  expect(made.status).toBe(200); const id = made.json.room.id as string;
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id })).status).toBe(200);
  if (extra) expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: extra.id })).status).toBe(200);
  return { admin, a, alex, fleetId, link, e, extra, id, advance: (n: number) => { at += n; }, off: () => { enabled = false; } };
}
async function send(w: Awaited<ReturnType<typeof world>>, text = "Status?", mentions = [w.e.id]) {
  const result = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text, mentions, idempotencyKey: randomUUID() });
  expect(result.status).toBe(200); return result.json;
}
const parentAsk = async (w: Awaited<ReturnType<typeof world>>, parentId: string) =>
  (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === parentId).ask;
const asks = () => r!.sent.filter(s => s.frame.type === "room.ask");


it("H6 marker shows audited No answer without sealing an answer; duplicate markers and late real answers are safe",async()=>{
 const w=await world(),post=await send(w);await vi.waitFor(()=>expect(asks()).toHaveLength(1));const input=asks()[0].frame.payload as HubRoomAsk;
 const marker={messageId:input.messageId,roomId:w.id,exposureId:w.e.id,answerId:randomUUID(),text:"",notAnswered:"finished-without-answer" as const};
 const mark=()=>r!.http.receive(r!.frame("room.answer",marker,w.link) as never,w.link);expect(await mark()).toMatchObject({type:"room.answer-ack",payload:{answerId:marker.answerId}});await mark();
 expect(await parentAsk(w,post.id)).toEqual({total:1,answered:0,working:0,later:0,failed:1,reason:"finished-without-answer"});
 let messages=(await r!.call(w.a,"GET",`/hub/v1/rooms/${w.id}/messages`)).json.messages;expect(messages.find((m:any)=>m.answerTo===post.id)).toMatchObject({stage:"not-answered",text:"",reasonCode:"finished-without-answer"});
 expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.answer-missing'").get()).toEqual({n:1});
 const real={...marker,answerId:randomUUID(),text:"Actual late answer"};delete (real as any).notAnswered;await r!.http.receive(r!.frame("room.answer",real,w.link) as never,w.link);
 await mark();messages=(await r!.call(w.a,"GET",`/hub/v1/rooms/${w.id}/messages`)).json.messages;const answer=messages.find((m:any)=>m.answerTo===post.id);expect(answer).toMatchObject({stage:"answered",text:"Actual late answer"});expect(answer.reasonCode).toBeUndefined();expect(await parentAsk(w,post.id)).toEqual({total:1,answered:1,working:0,later:0});
});
it("H6 unsupported or foreign markers never turn into empty answers",async()=>{
 const w=await world(),post=await send(w);await vi.waitFor(()=>expect(asks()).toHaveLength(1));const input=asks()[0].frame.payload as HubRoomAsk;
 const body={messageId:input.messageId,roomId:w.id,exposureId:w.e.id,answerId:randomUUID(),text:"",notAnswered:"finished-without-answer" as const};
 (w.link.features as Set<string>).delete("room-answer-status-v1");await expect(r!.http.receive(r!.frame("room.answer",body,w.link) as never,w.link)).rejects.toMatchObject({code:"incompatible"});
 const foreign=r!.link(randomUUID(),r!.admin,2,caps);await expect(r!.http.receive(r!.frame("room.answer",body,foreign) as never,foreign)).rejects.toMatchObject({code:"denied"});
 expect((await parentAsk(w,post.id)).answered).toBe(0);
});
