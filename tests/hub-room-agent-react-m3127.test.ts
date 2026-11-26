/**
 * M-3127 (agents' reactions, riding on room-answer-buttons-v1): an agent's `react` on the Hub room question it was asked —
 * A. the Hub: the `room.react` frame (real HTTP + SQLite, the S3b rig): under the question, one per agent, "" takes it
 *    back, only that delivery's Fleet/owner/exposure, a result (never a broken link) for an archived room;
 * B. the Fleet member: the room adapter's react() and the prompt's line, only where the Hub takes reactions;
 * C. the Fleet manager: a react whose message_id is a room question's correlation id goes to the Hub, never to a chat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";
import { formatRoomAskPrompt, HubRoomAskAdapter, migrateRoomAsks, type RoomAsk, type RoomAskLink } from "../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import * as fleetManagerModule from "../src/fleet-manager.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; vi.unstubAllEnvs(); });

describe("A. the Hub takes an agent's reaction (room.react)", () => {
  const CAPS = ["welcome-caps-v1", "room-ask-v1", "room-answer-buttons-v1"];
  async function world(caps = CAPS) {
    r = await s3bRig({ realAudit: true });
    const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
    const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
    const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
    const id = (await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)] })).json.room.id as string;
    await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id });
    const q = (await r.call(a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Status?", mentions: [e.id], idempotencyKey: randomUUID() })).json;
    await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "room.ask")).toBe(true));
    const ask = r.sent.filter(s => s.frame.type === "room.ask").at(-1)!.frame.payload as HubRoomAsk;
    const react = (emoji: string, over: Record<string, unknown> = {}) => r!.http.receive(r!.frame("room.react", { messageId: ask.messageId, roomId: id, exposureId: e.id, emoji, ...over }, link) as never, link);
    const question = async () => (await r!.call(a, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages.find((m: any) => m.id === q.id);
    const agentMember = (await r.call(admin, "GET", `/hub/v1/rooms/${id}`)).json.members.find((m: any) => m.kind === "agent").id as string;
    const reactVia = (l: any, emoji: string) => r!.http.receive(r!.frame("room.react", { messageId: ask.messageId, roomId: id, exposureId: e.id, emoji }, l) as never, l);
    return { a, admin, e, id, q, react, reactVia, question, agentMember, fleetId, alex };
  }
  it("shows under the question as the agent's; a later one replaces it; \"\" takes it back", async () => {
    const w = await world();
    expect(await w.react("👀")).toMatchObject({ type: "room.react-result", payload: { ok: true } });
    expect((await w.question()).reactions).toEqual([{ emoji: "👀", count: 1, members: [w.agentMember] }]);
    await w.react("✅");
    expect((await w.question()).reactions).toEqual([{ emoji: "✅", count: 1, members: [w.agentMember] }]);
    await w.react("");
    expect(await w.question()).not.toHaveProperty("reactions");
  });
  it("refuses another Fleet's exposure or room, a bad emoji; an archived room is a result, not a broken link", async () => {
    const w = await world();
    expect(await w.react("👍", { exposureId: randomUUID() })).toMatchObject({ payload: { ok: false, code: "denied" } });
    expect(await w.react("👍", { roomId: randomUUID() })).toMatchObject({ payload: { ok: false, code: "denied" } });
    expect(await w.react("abc")).toMatchObject({ payload: { ok: false, code: "invalid" } });
    await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
    expect(await w.react("👍")).toMatchObject({ payload: { ok: false, code: "archived" } });
    expect(await w.question()).not.toHaveProperty("reactions");
  });
  it("another Fleet's link, or another owner's, with the right delivery id: denied, nothing stored (Fable #3935 P2-c)", async () => {
    const w = await world();
    expect(await w.reactVia(r!.link(randomUUID(), r!.admin, 1, CAPS), "👍")).toMatchObject({ payload: { ok: false, code: "denied" } });
    expect(await w.reactVia(r!.link(w.fleetId, w.alex, 2, CAPS), "👍")).toMatchObject({ payload: { ok: false, code: "denied" } });
    expect(await w.question()).not.toHaveProperty("reactions");
  });
  it("an agent removed from the room: revoked, nothing stored (Fable #3935 P2-d)", async () => {
    const w = await world();
    expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${w.agentMember}`)).status).toBe(200);
    expect(await w.react("👍")).toMatchObject({ payload: { ok: false, code: "revoked" } });
    expect(await w.question()).not.toHaveProperty("reactions");
  });
  it("the 12-emoji cap holds on the agent path: a 13th new emoji is refused, one already there is fine (Fable #3935 P3)", async () => {
    const w = await world();
    for (const emoji of ["😀", "😂", "😍", "🤔", "👏", "🙏", "🔥", "✅", "❤️", "🎉", "👀", "🚀"])
      expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages/${w.q.id}/reactions`, { emoji, on: true })).status).toBe(200);
    expect(await w.react("🍕")).toMatchObject({ payload: { ok: false, code: "invalid" } });
    expect(await w.react("🚀")).toMatchObject({ payload: { ok: true } });
  });
  it("a link without room-answer-buttons-v1 takes none", async () => {
    const w = await world(["welcome-caps-v1", "room-ask-v1"]);
    expect(await w.react("👍")).toMatchObject({ payload: { ok: false, code: "revoked" } });
  });
  it("S254 an accepted reaction answers the exact delivery and clears missing-answer presentation without a text post", async () => {
    const w = await world([...CAPS, "room-react-ack-v1", "room-answer-status-v1"]);
    const delivery = r!.db.prepare("SELECT * FROM hub_room_deliveries").get() as any;

    // Exercise recovery from an already displayed no-answer marker without manufacturing another answer.
    r!.db.prepare("UPDATE hub_room_deliveries SET reason_code='finished-without-answer' WHERE id=?").run(delivery.id);
    r!.db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(delivery.reply_id);
    const count = (r!.db.prepare("SELECT COUNT(*) n FROM hub_room_posts").get() as any).n;
    expect(await w.react("👍", {acknowledge:true})).toMatchObject({type:"room.react-result",payload:{ok:true,acknowledged:true}});
    expect((await w.question()).reactions).toEqual([{emoji:"👍",count:1,members:[w.agentMember]}]);
    expect((await w.question()).ask).toEqual({total:1,answered:1,working:0,later:0});
    expect(r!.db.prepare("SELECT state,reason_code,answer_id FROM hub_room_deliveries WHERE id=?").get(delivery.id)).toEqual({state:"answered",reason_code:"acknowledged-by-reaction",answer_id:null});
    const messages=(await r!.call(w.a,"GET",`/hub/v1/rooms/${w.id}/messages`)).json.messages;
    expect(messages.find((m:any)=>m.id===delivery.reply_id)).toMatchObject({stage:"working"});
    expect((r!.db.prepare("SELECT COUNT(*) n FROM hub_room_posts").get() as any).n).toBe(count);
    expect(await w.react("👍", {acknowledge:true})).toMatchObject({payload:{ok:true,acknowledged:true}});
    expect((await w.question()).ask.answered).toBe(1);
  });
  it("S254 a gesture without the new acknowledgement flag keeps the delivery owed", async () => {
    const w=await world([...CAPS,"room-react-ack-v1"]);
    expect(await w.react("👍")).toMatchObject({payload:{ok:true}});
    expect((await w.question()).ask.answered).toBe(0);
  });
  it("S254 refuses expired acknowledgements atomically without adding the reaction", async () => {
    const w=await world([...CAPS,"room-react-ack-v1"]);
    r!.db.prepare("UPDATE hub_room_deliveries SET expires_at=1").run();
    expect(await w.react("👍",{acknowledge:true})).toMatchObject({payload:{ok:false}});
    expect(await w.question()).not.toHaveProperty("reactions");
    expect((r!.db.prepare("SELECT state FROM hub_room_deliveries").get() as any).state).not.toBe("answered");
  });
});

describe("the member hello's capability list (Fable #3935 info)", () => {
  it("the legacy hello keeps16; phase3 can offer a17th — agent reactions add no capability", async () => {
    const { HUB_CAPABILITIES, HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY, HUB_ROOM_REACT_CAPABILITY, HUB_ROOM_BUTTONS_CAPABILITY, memberFrameSchema, encodeMemberFrame } = await import("../src/hub/protocol.js");
    const sent = [...HUB_CAPABILITIES, ...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY];   // compose/member.ts at its fullest
    expect(sent).toHaveLength(16);
    expect(HUB_ROOM_REACT_CAPABILITY).toBe(HUB_ROOM_BUTTONS_CAPABILITY);
    expect(sent).not.toContain("room-react-v1");
    const hello = (capabilities: string[]) => ({ v: 1 as const, type: "hello" as const, requestId: randomUUID(), linkEpoch: 0,
      payload: { supportedVersions: [1], capabilities, memberBootId: randomUUID() } });
    expect(memberFrameSchema.safeParse(hello(sent)).success).toBe(true);
    expect(() => encodeMemberFrame(hello(sent))).not.toThrow();
    const future = hello([...sent, "one-more-v1"]);
    expect(memberFrameSchema.safeParse(future).success).toBe(true);
    expect(() => encodeMemberFrame(future)).not.toThrow(); // phase3 has a bounded legacy retry for older Hubs
  });

});

describe("B. the Fleet member's room adapter", () => {
  function member(features: string[], withSend = true) {
    const db = new Database(":memory:"); migrateRoomAsks(db);
    const ask: RoomAsk = { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: "Weekly", asker: { name: "Alex" }, text: "Status?", context: [] };
    const inputs: HubRepresentativeDelivery[] = [], reacts: any[] = [], exposure = { agent: "notes", consentId: randomUUID(), revision: 1, token: "t" };
    const link: RoomAskLink = { current: () => true, features: new Set(features), sendAnswer: vi.fn(async () => {}),
      ...(withSend ? { sendReact: vi.fn(async (x: any) => { reacts.push(x); }) } : {}) };
    const adapter = new HubRoomAskAdapter({ db, bindingKey: "k", encryptionKey: randomBytes(32), current: () => true,
      localExposure: id => id === ask.exposureId ? exposure : null,
      deliver: vi.fn(async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; }) });
    adapter.connected(link); adapter.accept(ask, link);
    return { db, adapter, ask, inputs, reacts, close: () => { adapter.close(); db.close(); } };
  }
  it("sends the reaction for this agent's own room question; the prompt says how, only where the Hub takes it", async () => {
    const m = member(["welcome-caps-v1", "room-ask-v1", "room-answer-buttons-v1"]); await m.adapter.settled();
    const cid = m.inputs[0]!.correlationId;
    expect(m.inputs[0]!.text).toContain(`use react with message_id="${cid}"`);
    expect(await m.adapter.react({ correlationId: cid, caller: "notes", emoji: "👍" })).toEqual({ ok: true, message: "Reacted in the Hub room." });
    expect(m.reacts).toEqual([{ messageId: m.ask.messageId, roomId: m.ask.roomId, exposureId: m.ask.exposureId, emoji: "👍" }]);
    expect(m.adapter.react({ correlationId: cid, caller: "someone-else", emoji: "👍" })).toBeNull();
    expect(m.adapter.react({ correlationId: "hub-room-" + randomUUID(), caller: "notes", emoji: "👍" })).toBeNull();
    expect(m.adapter.react({ correlationId: "web-123", caller: "notes", emoji: "👍" })).toBeNull();
    expect(await m.adapter.react({ correlationId: cid, caller: "notes", emoji: "" })).toMatchObject({ ok: false });
    expect(await m.adapter.react({ correlationId: cid, caller: "notes", emoji: "👍", callerCurrent: () => false })).toMatchObject({ ok: false });
    m.close();
  });
  it("an older Hub: no line in the prompt, and react says to answer instead", async () => {
    const m = member(["welcome-caps-v1", "room-ask-v1"], false); await m.adapter.settled();
    const cid = m.inputs[0]!.correlationId;
    expect(m.inputs[0]!.text).not.toContain("use react");
    expect(await m.adapter.react({ correlationId: cid, caller: "notes", emoji: "👍" })).toMatchObject({ ok: false, message: expect.stringContaining("report_result") });
    m.close();
    // A link that could send but did not agree room-answer-buttons-v1: still refused, nothing sent.
    const n = member(["welcome-caps-v1", "room-ask-v1"], true); await n.adapter.settled();
    expect(await n.adapter.react({ correlationId: n.inputs[0]!.correlationId, caller: "notes", emoji: "👍" })).toMatchObject({ ok: false });
    expect(n.reacts).toEqual([]);
    n.close();
  });
  it("formatRoomAskPrompt's react line in both languages", () => {
    const ask: RoomAsk = { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: "R", asker: { name: "A" }, text: "t", context: [] };
    expect(formatRoomAskPrompt(ask, "hub-room-x", "zh-TW", { react: true })).toContain('react，message_id="hub-room-x"');
    expect(formatRoomAskPrompt(ask, "hub-room-x", "en")).not.toContain("react with");
  });
});

describe("C. the Fleet manager routes a react on a room question to the Hub", () => {
  async function fleet() {
    const home = mkdtempSync(join(tmpdir(), "agend-test-room-react-"));
    vi.stubEnv("AGEND_HOME", home);
    const fm = new (fleetManagerModule as any).FleetManager(home) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.fleetConfig = { defaults: {}, instances: { dev: { working_directory: home } } };
    const answers: Array<{ result: unknown; error?: string }> = [];
    fm.instanceIpcClients.set("dev", { send: (m: any) => { answers.push({ result: m.result, error: m.error }); return true; } });
    let boot = "boot-1"; fm.getDaemonBootId = () => boot;
    const calls: any[] = [];
    fm.hubReacts = (input: any) => { calls.push({ ...input, current: input.callerCurrent() }); return input.correlationId.endsWith("0") ? null : Promise.resolve({ ok: true, message: "Reacted in the Hub room." }); };
    const react = async (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => { await fm.handleOutboundFromInstance("dev", { tool: "react", args, fleetRequestId: "tool_1_1", ...extra }); return answers.at(-1)!; };
    return { fm, react, calls, setBoot: (b: string) => { boot = b; } };
  }
  const cid = (end = "1") => `hub-room-${randomUUID().slice(0, -1)}${end}`;
  it("goes to the Hub with the caller and emoji; ok comes back", async () => {
    const f = await fleet(), id = cid();
    expect(await f.react({ message_id: id, emoji: "👍" }, { sourceDaemonBootId: "boot-1" })).toEqual({ result: "ok", error: undefined });
    expect(f.calls).toEqual([{ correlationId: id, caller: "dev", emoji: "👍", callerCurrent: expect.any(Function), current: true }]);
  });
  it("not this agent's question: refused with words; a retired daemon generation: refused, never sent", async () => {
    const f = await fleet();
    expect((await f.react({ message_id: cid("0"), emoji: "👍" })).error).toBe("That message_id is not a Hub room question you were asked.");
    const before = f.calls.length;
    expect((await f.react({ message_id: cid(), emoji: "👍" }, { sourceDaemonBootId: "boot-0" })).error).toMatch(/no longer current/);
    expect(f.calls).toHaveLength(before);
  });
  it("any other message id is not taken here (a web id still goes to the web chat)", async () => {
    const f = await fleet();
    await f.react({ message_id: "web-nope", emoji: "👍" });
    expect(f.calls).toHaveLength(0);
  });
});
