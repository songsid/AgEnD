import {createPrivateKey} from "node:crypto";
import {signRoomAsker,roomAskIdentityDigest} from "../src/hub/room-asker-identity.js";
import {HUB_ROOM_ASKER_IDENTITY_CAPABILITY} from "../src/hub/room-asker-identity-model.js";
/** Owned TLS/WSS + SQLite factory integration. Delivery and state are inert Fleet-host callbacks. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createHubMemberFactory, memberSet, type HubRepresentativeHost } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY } from "../src/hub/protocol.js";
import type { AgentRoomPort } from "../src/hub/member/room-post.js";
import type { HubMountedService } from "../src/hub/mount.js";
import type { HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubRoomAsk } from "../src/hub/types.js";
import type { AgentStateInput } from "../src/hub/member/room-ask.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { beginHubPairing, claimHubPairing } from "../src/hub/pairing-client.js";
import { HubRoomAskAdapter, verifyRoomAskJournal } from "../src/hub/member/room-ask.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { hubRig } from "./helpers/hub-rig.js";

const capabilities = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY];
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [], services: HubMountedService[] = [];
afterEach(async () => { for (const s of services.splice(0)) { s.fence(); await s.close(); } for (const r of rigs.splice(0)) await r.close(); });
async function harness(withState = true, withPost = false, withNotify = true, withIdentity = false) {
  const r = await hubRig({ serverCapabilities: withIdentity?[...capabilities,"fleet-update-v1",HUB_ROOM_ASKER_IDENTITY_CAPABILITY]:capabilities }); rigs.push(r); const profile = await r.pair();
  let epoch = 0;
  const postRoom = randomUUID(), postMessage = randomUUID();
  let rooms: AgentRoomPort | null = null;
  r.setReceive(async (frame, link) => {
    epoch = link.linkEpoch;
    if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch,
      payload: { receipts: [], nextReceiptSequence: 0, more: false } };
    if (frame.type === "room.list") return {v:1,type:"room.list-result",requestId:frame.requestId,linkEpoch:link.linkEpoch,
      payload:{ok:true,exposureId:frame.payload.exposureId,rooms:[{id:postRoom,name:"Weekly"}]}};
    if (frame.type === "room.post") return {v:1,type:"room.post-result",requestId:frame.requestId,linkEpoch:link.linkEpoch,
      payload:{ok:true,roomId:postRoom,messageId:postMessage,at:Date.now()}};
    if(frame.type === "room.members")return {v:1,type:"room.members-result",requestId:frame.requestId,linkEpoch:link.linkEpoch,
      payload:{ok:true,roomId:postRoom,members:[{id:"corp/person-A",kind:"person",name:"Alex",presence:"online"}]}};
    if(frame.type === "people.search")return {v:1,type:"people.search-result",requestId:frame.requestId,linkEpoch:link.linkEpoch,
      payload:{ok:true,people:[{id:"corp/person-A",name:"Alex",login:"alex"}],truncated:false}};
  });
  let api: HubMemberExposureApi | null = null, reports: Parameters<HubRepresentativeHost["attachReports"]>[0] = null;
  let failed: Parameters<HubRepresentativeHost["attachReports"]>[1] = null;
  const logs: { message: string; meta?: Record<string, unknown> }[] = [];
  const inputs: HubRepresentativeDelivery[] = [];
  const notifications: import("../src/hub/member/room-post-answers.js").RoomPostNotification[]=[];
  const seen: string[] = [];   // M-3313: what the Fleet's look (sawText) was handed, as each frame arrived
  let token = "test-current-agent-token";
  const readState = vi.fn((): AgentStateInput => ({ process: "running", execution: "idle" }));
  const representative = {
    agentToken: () => token,
    deliver: async (input: HubRepresentativeDelivery) => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; },
    attachReports: (handler: typeof reports, failure: typeof failed) => { reports = handler; failed = failure; },
    ...(withState ? { readState } : {}),
  };
  let askerPort:Pick<HubRoomAskAdapter,"verifiedAsker">|null=null;
  const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => profile.hub.hubId,
    agents: () => [{ name: "general", display: "General" }], representative,
    attachRoomAskers:port=>{askerPort=port;},
    ...(withIdentity?{fleetInfo:{version:"2.3.5",runsAsService:true},versionRegistry:async()=>"found" as const,updates:{idle:()=>false,canInstall:async()=>false,launch:async()=>false,notify:()=>true}}:{}),
    ...(withPost ? {attachAgentRooms:(value:AgentRoomPort|null)=>{rooms=value;},...(withNotify?{roomNotify:async(input:import("../src/hub/member/room-post-answers.js").RoomPostNotification)=>{
      if(!input.stillCurrent()||!await input.beforeInput())return false;notifications.push(input);return true;}}:{})} : {}),
    attachExposures: value => { api = value; }, attachAttention: () => {}, pokeAttention: () => {}, report: () => {},
    sawText: text => { seen.push(text); },
    log: (_level, message, meta) => { logs.push({ message, meta }); } });
  const start = async () => { const service = await create({}, () => true); services.push(service); await service.start(); return service; };
  const send = (type: "room.ask" | "room.answer-ack" | "room.post-answer", payload: any) => r.server.send(profile.fleetId,
    { v: 1, type, requestId: randomUUID(), linkEpoch: epoch, payload });
  const publish = () => api!.publish({ agent: "general", dataViewId: "agent", tools: [], expectedRevision: 0 });
  const ask = (id: string): HubRoomAsk => ({ messageId: randomUUID(), roomId: randomUUID(), roomName: "Weekly", exposureId: id,
    asker: { name: "Alex" }, text: "What changed?", context: [] });
  const row = (id: string) => { const db = new Database(join(r.memberHome, memberSet(profile.hub.hubId).database), { readonly: true });
    try { return db.prepare("SELECT state FROM hub_room_asks WHERE message_id=?").get(id); } finally { db.close(); } };
  return { r, profile, askerPort:()=>askerPort,inputs, notifications, seen, postRoom, postMessage, readState, start, publish, ask, send, row, representative, logs, epoch: () => epoch, api: () => api!, rooms:()=>rooms,
    replace: () => { token = "replacement-agent-token"; },
    report: (text: string) => reports!({ caller: "general", correlationId: inputs.at(-1)!.correlationId, text, callerCurrent: () => true }),
    failed: () => failed!(inputs.at(-1)!.correlationId, "general") };
}

it("offers room-post only with the composed port and uses the exact current consent on the real member link", async () => {
  const h=await harness(true,true),service=await h.start(),exposure=h.publish();
  const caller={agent:"general",current:()=>true};
  expect(h.rooms()!.available()).toBe(true);
  expect(await h.rooms()!.rooms(caller)).toMatchObject({ok:true,exposureId:exposure.exposureId,rooms:[{name:"Weekly"}]});
  expect(await h.rooms()!.members(caller,"Weekly")).toMatchObject({ok:true,members:[{name:"Alex"}]});
  expect(await h.rooms()!.people(caller,"Al")).toMatchObject({ok:true,people:[{login:"alex"}]});
  const operationId=randomUUID();
  expect(await h.rooms()!.post(caller,{room:"Weekly",text:"Posted",operationId})).toMatchObject({ok:true});
  const sent=h.r.received.find(frame=>frame.type==="room.post");
  expect(sent).toMatchObject({payload:{exposureId:exposure.exposureId,idempotencyKey:operationId,text:"Posted"}});
  h.replace();expect((await h.rooms()!.rooms(caller)).ok).toBe(false);
  service.fence();expect(h.rooms()).toBeNull();
});
it("routes a reply by the saved post, durably inputs once and ACKs it without affecting room asks",async()=>{
  const h=await harness(true,true);await h.start();const exposure=h.publish(),caller={agent:"general",current:()=>true};
  const operationId=randomUUID();await h.rooms()!.post(caller,{room:"Weekly",text:"Update",operationId});
  const frame={id:randomUUID(),idempotencyKey:operationId,postId:h.postMessage,roomId:h.postRoom,exposureId:exposure.exposureId!,message:{id:randomUUID(),author:{name:"Alex"},text:"Reply",at:Date.now()}};
  await h.send("room.post-answer",{...frame,postId:randomUUID()});
  expect(h.notifications).toHaveLength(0);
  await h.send("room.post-answer",frame);await vi.waitFor(()=>expect(h.notifications).toHaveLength(1));
  await vi.waitFor(()=>expect(h.r.received.some(f=>f.type==="room.post-answer-ack"&&f.payload.id===frame.id)).toBe(true));
  await h.send("room.post-answer",frame);await new Promise(resolve=>setTimeout(resolve,25));expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({agent:"general",id:frame.id});expect(h.inputs).toHaveLength(0);
  expect(await h.rooms()!.members(caller,"Weekly")).toMatchObject({ok:true});
});
it("keeps the feature off when answer notification delivery is not composed",async()=>{
  const h=await harness(true,true,false);await h.start();h.publish();expect(h.rooms()!.available()).toBe(false);
  await expect(h.r.server.send(h.profile.fleetId,{v:1,type:"room.post-result",requestId:randomUUID(),linkEpoch:h.epoch(),
    payload:{ok:true,roomId:randomUUID(),messageId:randomUUID(),at:Date.now()}})).rejects.toThrow("incompatible");
});
it("does not advertise room-post on a host without the port even when the Hub offers it", async () => {
  const h=await harness();await h.start();h.publish();
  await expect(h.r.server.send(h.profile.fleetId,{v:1,type:"room.post-result",requestId:randomUUID(),linkEpoch:h.epoch(),
    payload:{ok:true,roomId:randomUUID(),messageId:randomUUID(),at:Date.now()}})).rejects.toThrow("incompatible");
});

it("composes negotiated room delivery, text reports, exact ACK and viewer-neutral presence", async () => {
  const h = await harness(); await h.start(); const exposure = h.publish();
  const ask = h.ask(exposure.exposureId!);
  await expect(h.send("room.ask", ask)).resolves.toBeUndefined();
  await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  expect(h.inputs[0]!.text).toContain("Weekly"); expect(h.row(ask.messageId)).toEqual({ state: "delivered" });
  expect(await h.report("Answer from the existing agent")).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(1));
  const frame = h.r.received.find(f => f.type === "room.answer")!;
  if (frame.type !== "room.answer") throw Error("missing answer");
  await h.send("room.answer-ack", { messageId: ask.messageId, answerId: randomUUID() });
  expect(h.row(ask.messageId)).toEqual({ state: "answered" });
  await h.send("room.answer-ack", { messageId: frame.payload.messageId, answerId: frame.payload.answerId });
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "acked" }));
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toContainEqual(expect.objectContaining({ payload: { exposureId: ask.exposureId, state: "idle" } })));
  expect(h.readState).toHaveBeenCalledWith("general");
  await h.send("room.ask", ask); expect(h.inputs).toHaveLength(1);
});

it("keeps an uncomposed host off room-ask-v1 even when the Hub supports it", async () => {
  const h = await harness(false); await h.start(); const exposure = h.publish();
  await expect(h.send("room.ask", h.ask(exposure.exposureId!))).rejects.toThrow("incompatible");
  expect(h.inputs).toEqual([]); expect(h.readState).not.toHaveBeenCalled();
  expect(h.r.received.filter(f => f.type === "agent.state" || f.type === "room.answer")).toEqual([]);
});

it("flushes the same frozen answer after same-binding restart without replaying agent input", async () => {
  const h = await harness(); const first = await h.start(); const exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1)); await h.report("Frozen answer");
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(1));
  const original = h.r.received.find(f => f.type === "room.answer")!;
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  await h.start();
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(2));
  expect(h.r.received.filter(f => f.type === "room.answer").map(f => f.payload)).toEqual([original.payload, original.payload]);
  expect(h.inputs).toHaveLength(1);
  if (original.type !== "room.answer") throw Error("missing answer");
  await h.send("room.answer-ack", { messageId: original.payload.messageId, answerId: original.payload.answerId });
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "acked" }));
});

it("routes delayed IPC failure to the room intent and detaches reports on fence", async () => {
  const h = await harness(), service = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  h.failed(); expect(h.row(ask.messageId)).toEqual({ state: "held" });
  await h.send("room.ask", ask); expect(h.inputs).toHaveLength(1);
  service.fence(); await service.close();
  expect(h.r.received.filter(f => f.type === "room.answer")).toEqual([]);
});

it("polls current state on the link, deduplicates stable readings and stops after fencing", async () => {
  const h = await harness(), service = await h.start(), exposure = h.publish();
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toHaveLength(1));
  h.readState.mockReturnValue({ process: "crashed", execution: "working" });
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toContainEqual(expect.objectContaining({
    payload: { exposureId: exposure.exposureId, state: "paused", reason: "stopped" } })), { timeout: 7_000 });
  service.fence(); await service.close(); const calls = h.readState.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30)); expect(h.readState).toHaveBeenCalledTimes(calls);
  expect(h.r.received.filter(f => f.type === "agent.state")).toHaveLength(2);
}, 15_000);

it.each(["withdraw", "replace"] as const)("fences a held first input when the local consent becomes %s", async kind => {
  const h = await harness(); let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const normal = h.representative.deliver; h.representative.deliver = async input => { await held; return normal(input); };
  await h.start(); const exposure = h.publish(), ask = h.ask(exposure.exposureId!); await h.send("room.ask", ask);
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "dispatching" }));
  if (kind === "withdraw") await h.api().withdraw(exposure.exposureId!, exposure.revision); else h.replace();
  release(); await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "queued" }));
  expect(h.inputs).toHaveLength(0);
});

it("holds corrupt room history before an unbound legacy set can adopt a pairing or advance its floor", async () => {
  const h = await harness(), first = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  const set = memberSet(h.profile.hub.hubId), path = join(h.r.memberHome, set.database), floor = join(h.r.memberHome, set.floors[0]!);
  const db = new Database(path);
  db.prepare("UPDATE hub_member_meta SET binding=NULL").run(); db.prepare("UPDATE hub_room_asks SET value='corrupt'").run(); db.close();
  const before = readFileSync(floor, "utf8");
  await expect(h.start()).rejects.toThrow("uncertain");
  const after = new Database(path, { readonly: true });
  try { expect(after.prepare("SELECT binding FROM hub_member_meta").get()).toEqual({ binding: null });
    expect(after.prepare("SELECT value FROM hub_room_asks").get()).toEqual({ value: "corrupt" }); }
  finally { after.close(); }
  expect(readFileSync(floor, "utf8")).toBe(before);
});

it("opens a different complete room journal after re-pair and retains the old room input history", async () => {
  const h = await harness(), first = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  const previous = h.row(ask.messageId), profiles = new HubMemberProfileStore(h.r.memberHome, h.profile.hub.hubId);
  const expectedProfileDigest = profiles.profileDigest(), offer = await h.r.pairing.create(h.r.ctx, h.r.owner);
  const pending = await beginHubPairing({ home: h.r.memberHome, memberOrigin: h.r.memberOrigin, code: offer.code, current: () => true });
  await h.r.pairing.confirmOwner(h.r.ctx, pending.pairingId, pending.fingerprint);
  await h.r.pairing.approve(h.r.ctx, pending.pairingId, pending.fingerprint);
  await claimHubPairing({ home: h.r.memberHome, hubId: h.profile.hub.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest, current: () => true });
  const nextProfile = profiles.readProfile(); expect(nextProfile.fleetId).not.toBe(h.profile.fleetId);
  await h.start(); expect(h.inputs).toHaveLength(1); expect(h.row(ask.messageId)).toEqual(previous);
  const db = new Database(join(h.r.memberHome, memberSet(nextProfile.hub.hubId, nextProfile).database), { readonly: true });
  try { expect(db.prepare("SELECT COUNT(*) AS n FROM hub_room_asks").get()).toEqual({ n: 0 }); } finally { db.close(); }
});

it("refuses a withdrawn room ask without dropping the link, then delivers a valid ask on that same link", async () => {
  const h = await harness(); await h.start(); const old = h.publish(), epoch = h.epoch();
  await h.api().withdraw(old.exposureId!, old.revision);
  await h.send("room.ask", h.ask(old.exposureId!));
  await vi.waitFor(() => expect(h.logs).toContainEqual(expect.objectContaining({
    message: "Hub room ask not admitted", meta: expect.objectContaining({ reason: "denied" }) })));
  expect(h.epoch()).toBe(epoch); expect(h.inputs).toHaveLength(0);
  const revision = h.api().list()[0]!.revision;
  const current = h.api().publish({ agent: "general", dataViewId: "agent", tools: [], expectedRevision: revision });
  await h.send("room.ask", h.ask(current.exposureId!));
  await vi.waitFor(() => expect(h.inputs).toHaveLength(1)); expect(h.epoch()).toBe(epoch);
});

it("uses a derived room key so the member audit content key cannot decrypt the room journal", async () => {
  const h = await harness(); await h.start(); const exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  const set = memberSet(h.profile.hub.hubId), db = new Database(join(h.r.memberHome, set.database), { readonly: true });
  const auditKey = Buffer.from(readFileSync(join(h.r.memberHome, set.keys[1]!), "utf8").trim(), "base64");
  try { expect(() => verifyRoomAskJournal(db, { bindingKey: memberSet(h.profile.hub.hubId, h.profile).database,
    encryptionKey: auditKey })).toThrow("uncertain"); } finally { db.close(); }
});

it.each(["backpressure", "unexpected"] as const)("preserves the link failure path for %s instead of swallowing it as a room refusal", async kind => {
  const h = await harness(); await h.start(); const exposure = h.publish();
  const spy = vi.spyOn(HubRoomAskAdapter.prototype, "accept").mockImplementationOnce(() => {
    throw kind === "backpressure" ? new HubProtocolError("backpressure") : new Error("owned storage failure");
  });
  try {
    await h.send("room.ask", h.ask(exposure.exposureId!));
    await vi.waitFor(() => expect(h.logs).toContainEqual({ message: "Hub link held", meta: { code: kind === "backpressure" ? "backpressure" : "unavailable" } }));
    expect(h.logs.filter(row => row.message === "Hub room ask not admitted")).toEqual([]); expect(h.inputs).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

it("M-3313: a room ask (its context too) and a room post's answer are shown to the Fleet's look as the link receives them (Fable #4165 F1)", async () => {
  const h = await harness(true, true); await h.start(); const exposure = h.publish();
  const ask = { ...h.ask(exposure.exposureId!), text: "my code ABCDEFGHJKMNPQRSTVWX", context: [{ author: "Sam", text: "earlier QQQQQQQQQQQQQQQQQQQ2", at: Date.now() }] };
  await h.send("room.ask", ask);
  await vi.waitFor(() => expect(h.seen.some(t => t.includes("ABCDEFGHJKMNPQRSTVWX") && t.includes("QQQQQQQQQQQQQQQQQQQ2"))).toBe(true));
  const caller = { agent: "general", current: () => true }, operationId = randomUUID();
  await h.rooms()!.post(caller, { room: "Weekly", text: "Update", operationId });
  await h.send("room.post-answer", { id: randomUUID(), idempotencyKey: operationId, postId: h.postMessage, roomId: h.postRoom, exposureId: exposure.exposureId!,
    message: { id: randomUUID(), author: { name: "Alex" }, text: "reply ZZZZZZZZZZZZZZZZZZZ3", at: Date.now() } });
  await vi.waitFor(() => expect(h.seen.some(t => t.includes("ZZZZZZZZZZZZZZZZZZZ3"))).toBe(true));
});

it("composes the pinned verifier and destination-bound getter on the actual TLS member path",async()=>{
 const h=await harness(true,false,true,true),service=await h.start(),e=h.publish();
 const ask=h.ask(e.exposureId!),now=Date.now(),proof=signRoomAsker({v:1,issuer:h.profile.hub.hubId,issuerKeyId:h.profile.issuerKeyId,destinationFleetId:h.profile.fleetId,messageId:ask.messageId,roomId:ask.roomId,exposureId:ask.exposureId,exposureRevision:e.revision,linkEpoch:h.epoch(),subject:{kind:"agent",id:`exposure/${randomUUID()}`,displayName:"Actual source agent"},contentDigest:roomAskIdentityDigest(ask),issuedAt:now,expiresAt:now+120000,retainedUntil:now+3600000,nonce:"a".repeat(64)},createPrivateKey(readFileSync(join(h.r.root,"hub/keys/issuer-key.pem"))));
 await h.send("room.ask",{...ask,askerIdentity:proof});await vi.waitFor(()=>expect(h.inputs).toHaveLength(1));const input=h.inputs[0]!;
 expect(input.verifiedHubAsker).toEqual({hubId:h.profile.hub.hubId,...proof.subject});expect(h.askerPort()!.verifiedAsker(ask.messageId,input.roomAskerDestination!)).toEqual(input.verifiedHubAsker);
 await h.report("Answer from the fixture");expect(h.askerPort()!.verifiedAsker(ask.messageId,input.roomAskerDestination!)).toEqual(input.verifiedHubAsker);
 service.fence();await service.close();expect(h.askerPort()).toBeNull();
 // Reopen with no room identity consumer. The selected-set opener/migrations and strict journal reader are unchanged.
 const legacy=createHubMemberFactory({home:h.r.memberHome,boundHub:()=>h.profile.hub.hubId,components:MEMBER_COMPONENTS,agents:()=>[],representative:{deliver:async()=>false,agentToken:()=>null,attachReports:()=>{}},attachExposures:()=>{},attachAttention:()=>{},pokeAttention:()=>{},report:()=>{},log:()=>{}});
 const reopened=await legacy({},()=>true);services.push(reopened);await reopened.start();
});
