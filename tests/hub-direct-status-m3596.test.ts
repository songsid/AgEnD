/**
 * M-3596 (the user, 11-24): a Hub 1:1 chat was silent until the answer — the asker couldn't tell queued from working. Under
 * "Hub chat copies the Fleet chat" it now has the Fleet chat's status line, live, from what the Hub itself knows:
 * - an open question's answer row (no text yet) rides in the 1:1 projection: `queued` with `ahead` (how many open questions
 *   to the same agent came first: a count only, never whose or what), then `working` with `startedAt` once the Hub issued
 *   the begin lease (the member asks for it right before the hand-off; receipts stay evidence-only); the answer replaces it;
 * - the begin lease pushes that row to the asker (message.updated), so it turns live;
 * - the agent's reported state (agent.state: working, paused) reaches the 1:1 room's presence and pushes room.changed;
 * - the thread words it: directStatus() — working, or waiting and why (behind, busy, paused, offline, just sent).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure } from "../src/hub/types.js";
import { LEASE_MS } from "../src/hub/policy.js";
import { setLang } from "/assets/app-i18n.js";
import { directStatus, HANDOFF_GRACE_MS } from "/ui/js/hub-room-working.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; setLang("en", { store: false }); });
beforeAll(async () => { await import("/ui/js/hub-room-strings.js"); });
const caps = ["welcome-caps-v1", "room-ask-v1"];

async function world() {
  let at = Date.now(); r = await s3bRig({ now: () => at, realAudit: true });
  r.addPerson("alex", "Alex"); r.addPerson("bea", "Bea");
  const owner = await r.signIn("admin"), a = await r.signIn("alex"), b = await r.signIn("bea");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const room = async (who: typeof a, login: string) => {
    const grant = await r!.call(owner, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login, days: 7 });
    const opened = await r!.call(who, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: grant.json.grant.id });
    expect(opened.status).toBe(200); return opened.json.room.id as string;
  };
  return { a, b, link, e, ra: await room(a, "alex"), rb: await room(b, "bea"), advance: (n: number) => { at += n; }, now: () => at };
}
const ask = async (who: any, roomId: string, text: string) => {
  const res = await r!.call(who, "POST", `/hub/v1/rooms/${roomId}/messages`, { text, mentions: [], idempotencyKey: randomUUID() });
  expect(res.status).toBe(200); return res.json.id as string;
};
const page = async (who: any, roomId: string) => (await r!.call(who, "GET", `/hub/v1/rooms/${roomId}/messages`)).json;
const pending = (p: any, id: string) => p.messages.find((m: any) => m.id === `${id}:answer`);
const begin = (link: any, messageId: string) => r!.http.receive(r!.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" }, link) as never, link) as any;

describe("the 1:1 projection", () => {
  it("an open question's answer row: queued with how many came first (a count, never whose); working once handed; the answer replaces it", async () => {
    const w = await world();
    const q1 = await ask(w.a, w.ra, "Alex asks first"); w.advance(1000);
    const q2 = await ask(w.b, w.rb, "Bea asks second");
    const pa = await page(w.a, w.ra), pb = await page(w.b, w.rb);
    expect(pending(pa, q1)).toMatchObject({ answerTo: q1, text: "", stage: "queued", ahead: 0, author: { kind: "agent", name: "Notes" } });
    expect(pending(pb, q2)).toMatchObject({ stage: "queued", ahead: 1 });
    // Bea learns only that one question is ahead: nothing of Alex's in her room.
    expect(JSON.stringify(pb)).not.toContain("Alex asks first");
    expect(JSON.stringify(pb)).not.toContain(q1);

    // The begin lease (issued right before the hand-off) turns Alex's row "working", from that moment.
    const leaseAt = w.now(), granted = await begin(w.link, q1);
    expect(granted.payload.ok).toBe(true);
    expect(granted.payload.lease.expiresAt - LEASE_MS).toBe(leaseAt);
    const working = pending(await page(w.a, w.ra), q1);
    expect(working).toMatchObject({ stage: "working", startedAt: leaseAt });
    expect(working.ahead).toBeUndefined();
    expect(pending(await page(w.b, w.rb), q2)).toMatchObject({ stage: "queued", ahead: 1 });   // still behind Alex's

    // Answered: the row is the answer now (no placeholder), and Bea's question has nobody ahead.
    const text = "Done", answerId = randomUUID(), { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(text).digest("hex");
    const release = await r!.http.receive(r!.frame("authorize.request", { messageId: q1, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: digest } }, w.link) as never, w.link) as any;
    await r!.http.receive(r!.frame("answer", { messageId: q1, answerId, text, contentDigest: digest, releaseLease: release.payload.lease }, w.link) as never, w.link);
    const after = await page(w.a, w.ra), answers = after.messages.filter((m: any) => m.id === `${q1}:answer`);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ text: "Done" });
    expect(answers[0].stage).toBeUndefined();
    expect(pending(await page(w.b, w.rb), q2)).toMatchObject({ stage: "queued", ahead: 0 });
  });

  it("the begin lease reaches the asker at once: message.updated with the working row (their stream only)", async () => {
    const w = await world();
    const q1 = await ask(w.a, w.ra, "Live please");
    const stop = new AbortController(), deadline = setTimeout(() => stop.abort(), 5000);
    try {
      const stream = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: w.a.cookie }, signal: stop.signal }), reader = stream.body!.getReader();
      expect((await begin(w.link, q1)).payload.ok).toBe(true);
      let events = "";
      while (!events.includes(`${q1}:answer`)) { const chunk = await reader.read(); expect(chunk.done).toBe(false); events += new TextDecoder().decode(chunk.value); }
      expect(events).toContain("event: message.updated");
      expect(events).toContain('"stage":"working"');
    } finally { clearTimeout(deadline); stop.abort(); }
  });

  it("the agent's reported state reaches the 1:1 room: working, paused (with its reason), idle again", async () => {
    const w = await world();
    const presence = async () => ((await r!.call(w.a, "GET", "/hub/v1/rooms?v=2")).json.rooms.find((x: any) => x.id === w.ra)).agent.presence;
    expect(await presence()).toBe("idle");
    const state = (s: object) => r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, ...s }, w.link) as never, w.link);
    await state({ state: "working" }); expect(await presence()).toBe("working");
    const detail = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.ra}`)).json;
    expect(detail.room.agent.presence).toBe("working");
    await state({ state: "paused", reason: "quota" }); expect(await presence()).toBe("paused");
    await state({ state: "idle" }); expect(await presence()).toBe("idle");
  });

  it("a state change is pushed to the room's asker (room.changed with the new presence)", async () => {
    const w = await world();
    const stop = new AbortController(), deadline = setTimeout(() => stop.abort(), 5000);
    try {
      const stream = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: w.a.cookie }, signal: stop.signal }), reader = stream.body!.getReader();
      await r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, state: "working" }, w.link) as never, w.link);
      let events = "";
      while (!events.includes('"presence":"working"')) { const chunk = await reader.read(); expect(chunk.done).toBe(false); events += new TextDecoder().decode(chunk.value); }
      expect(events).toContain("event: room.changed");
    } finally { clearTimeout(deadline); stop.abort(); }
  });
});

describe("a hand-off that never reached the agent (Prism #4400 P2)", () => {
  it("a begin lease then a hold before input: the agent reports idle, the room says so (reported), and the line reads not started after the grace; a later attempt restarts it", async () => {
    const w = await world();
    const q1 = await ask(w.a, w.ra, "Held after the lease");
    const roomOf = async () => (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.ra}`)).json.room;
    expect((await roomOf()).agent.reported).toBeUndefined();               // nothing reported yet (an older member never does)
    const first = w.now(); expect((await begin(w.link, q1)).payload.ok).toBe(true);
    // The member held it before input (stale): no receipt reaches the Hub; its agent reports idle.
    await r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, state: "idle" }, w.link) as never, w.link);
    const room = await roomOf(), row = pending(await page(w.a, w.ra), q1);
    expect([room.agent.presence, room.agent.reported, row.stage, row.startedAt]).toEqual(["idle", true, "working", first]);
    const agent = { name: "Notes", presence: room.agent.presence, reported: room.agent.reported };
    expect(directStatus([row], agent, first + 5_000)!.kind).toBe("working");                     // within the grace: still its turn
    expect(directStatus([row], agent, first + HANDOFF_GRACE_MS + 1)).toEqual({ kind: "awaiting", text: "Sent to Notes; waiting for it to start" });
    // A later attempt (after the hold): its own lease restarts "working" from then.
    w.advance(120_000); const second = w.now(); expect((await begin(w.link, q1)).payload.ok).toBe(true);
    expect(pending(await page(w.a, w.ra), q1).startedAt).toBe(second);
    await r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, state: "working" }, w.link) as never, w.link);
    const busy = (await roomOf()).agent;
    expect(directStatus([pending(await page(w.a, w.ra), q1)], { name: "Notes", presence: busy.presence, reported: busy.reported }, second + 10 * HANDOFF_GRACE_MS)!.kind).toBe("working");
  });
});

describe("a hand-off with no reported agent state (an older member; Prism #4400 R1)", () => {
  it("a begin lease and then nothing (a hold before input, no agent.state ever): the room has no reported state, and the line says only that it was handed — an hour on too", async () => {
    const w = await world();
    const q1 = await ask(w.a, w.ra, "Held, and nobody says");
    const first = w.now(); expect((await begin(w.link, q1)).payload.ok).toBe(true);
    w.advance(3_600_000);
    const room = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.ra}`)).json.room, row = pending(await page(w.a, w.ra), q1);
    expect([room.agent.presence, room.agent.reported, row.stage, row.startedAt]).toEqual(["idle", undefined, "working", first]);
    expect(directStatus([row], { name: "Notes", presence: room.agent.presence, reported: room.agent.reported === true }, w.now()))
      .toEqual({ kind: "awaiting", text: "Handed to Notes; waiting for its answer" });
  });
});

describe("directStatus: the 1:1 status line's words", () => {
  const row = (over: object = {}) => ({ id: "q:answer", answerTo: "q", text: "", author: { kind: "agent", name: "Notes" }, at: 1000, ...over });
  it("working (with when it started), or waiting and why; nothing open: none", () => {
    expect(directStatus([row({ stage: "working", startedAt: 5000 })], { name: "Notes", presence: "working", reported: true })).toEqual({ kind: "working", text: "Notes is working on it", since: 5000 });
    const why = (over: object, presence?: string) => directStatus([row({ stage: "queued", ...over })], { name: "Notes", presence })!.text;
    expect(why({ ahead: 1 }, "working")).toBe("Waiting: Notes is answering another question first");
    expect(why({ ahead: 3 }, "idle")).toBe("Waiting: Notes has 3 questions to answer first");
    expect(why({ ahead: 0 }, "working")).toBe("Waiting: Notes is busy with other work");
    expect(why({ ahead: 2 }, "paused")).toBe("Waiting: Notes is paused; it gets your question when it resumes");
    expect(why({ ahead: 0 }, "offline")).toBe("Waiting: Notes is offline; it gets your question when it's back");
    expect(why({ ahead: 0 }, "idle")).toBe("Sent to Notes; waiting for it to start");
    expect(directStatus([], { name: "Notes", presence: "working" })).toBeNull();
    expect(directStatus([row({ stage: "working", text: "an answer" })], { name: "Notes" })).toBeNull();   // answered: not open
  });
  it("working, then the agent pauses or goes offline: that wins over the timer; resumed, working again (Prism #4400 P2)", () => {
    const w = row({ stage: "working", startedAt: 1000 });
    expect(directStatus([w], { name: "Notes", presence: "paused", reported: true }, 2000)).toEqual({ kind: "awaiting", text: "Paused: Notes continues with your question when it resumes" });
    expect(directStatus([w], { name: "Notes", presence: "offline" }, 2000)).toEqual({ kind: "awaiting", text: "Offline: Notes continues with your question when it's back" });
    expect(directStatus([w], { name: "Notes", presence: "working", reported: true }, 2000)).toEqual({ kind: "working", text: "Notes is working on it", since: 1000 });
    // Idle long after the hand-off (reported): not started. Long work while it reports working: still working, an hour on.
    expect(directStatus([w], { name: "Notes", presence: "idle", reported: true }, 1000 + HANDOFF_GRACE_MS + 1)!.kind).toBe("awaiting");
    expect(directStatus([w], { name: "Notes", presence: "working", reported: true }, 1000 + 3_600_000)!.kind).toBe("working");
    // No state reported (an older member): only that a hand-off was tried, at once and an hour on — never "working" (Prism R1).
    for (const at of [1500, 1000 + 3_600_000]) expect(directStatus([w], { name: "Notes", presence: "idle" }, at)).toEqual({ kind: "awaiting", text: "Handed to Notes; waiting for its answer" });
  });
  it("zh-TW", () => {
    setLang("zh-TW", { store: false });
    expect(directStatus([row({ stage: "working", startedAt: 1 })], { name: "Notes", presence: "working", reported: true }, 2)!.text).toBe("Notes 正在處理");
    expect(directStatus([row({ stage: "working", startedAt: 1 })], { name: "Notes" })!.text).toBe("已交給 Notes，等它回答");
    expect(directStatus([row({ stage: "queued", ahead: 1 })], { name: "Notes", presence: "working" })!.text).toBe("等待中：Notes 正在先回答另一個問題");
    expect(directStatus([row({ stage: "queued", ahead: 0 })], { name: "Notes", presence: "idle" })!.text).toBe("已送給 Notes，等它開始處理");
    expect(directStatus([row({ stage: "working", startedAt: 1 })], { name: "Notes", presence: "paused" })!.text).toBe("已暫停：Notes 恢復後會繼續處理你的問題");
  });
});
