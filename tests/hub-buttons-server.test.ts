import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { buttonsDigest } from "../src/hub/buttons-model.js";
import { HubButtonsService } from "../src/hub/buttons.js";
import { messageContentDigest } from "../src/hub/identity.js";
import type { HubAnswerButtons, HubAuthorizationLease, HubExposure, HubRequestContext } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; vi.useRealTimers(); });
const wire = (poll?: Partial<NonNullable<HubAnswerButtons["poll"]>>): HubAnswerButtons => ({ id: randomUUID().replaceAll("-", ""), labels: ["Yes", "No"], values: ["yes", "no"],
  ...(poll ? { poll: { seconds: 10, multi: false, reveal: "close", showVoters: true, question: "Pick", ...poll } } : {}) });
async function world(options: { features?: string[]; askerAdmin?: boolean } = {}) {
  r = await s3bRig();
  const owner = r.addPerson("owner"), asker = options.askerAdmin ? r.admin : r.addPerson("asker");
  const askerLogin = options.askerAdmin ? "admin" : "asker";
  const fleetId = randomUUID(), link = r.link(fleetId, owner);
  for (const feature of options.features ?? ["buttons-v1"]) (link.features as Set<string>).add(feature);
  const exposure: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Representative", revision: 1, state: "published", dataViewId: "agent",
    allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn(askerLogin), admin = await r.signIn("admin");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId: exposure.id, exposureRevision: 1, login: askerLogin, days: 7 });
  expect(grant.status).toBe(200);
  const room = await r.call(a, "POST", "/hub/v1/rooms", { exposureId: exposure.id, grantId: grant.json.grant.id });
  expect(room.status).toBe(200);
  const roomId = room.json.room.id as string;
  const ask = await r.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Question" });
  expect(ask.status).toBe(200);
  const messageId = ask.json.receipt.messageId as string;
  const answer = async (buttons: HubAnswerButtons, over: Record<string, unknown> = {}) => {
    const target = typeof over.messageId === "string" ? over.messageId : messageId;
    const text = "Choose", answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { buttonsDigest: buttonsDigest(buttons) });
    const auth = await r!.http.receive(r!.frame("authorize.request", { messageId: target, operationId: randomUUID(), exposureRevision: 1,
      phase: "release-answer", answer: { answerId, contentDigest } }, link) as never, link) as any;
    expect(auth.payload.ok).toBe(true);
    const body = { messageId: target, answerId, text, contentDigest, buttons, releaseLease: auth.payload.lease as HubAuthorizationLease, ...over };
    return r!.http.receive(r!.frame("answer", body, link) as never, link);
  };
  const click = (buttons: HubAnswerButtons, input: Record<string, unknown> = {}, browser = a) => r!.call(browser, "POST", `/hub/v1/rooms/${roomId}/buttons`,
    { setId: buttons.id, idempotencyKey: randomUUID(), ...input });
  const questions = () => (r!.db.prepare("SELECT question_ref FROM hub_messages WHERE room_id=? AND id<>? ORDER BY sequence").all(roomId, messageId) as { question_ref: string }[])
    .map(q => r!.contents.get(q.question_ref)?.question);
  return { a, o, admin, asker, owner, link, roomId, grant: grant.json.grant, exposure, messageId, answer, click, questions };
}

async function observedWorld() {
  let buttons!: HubButtonsService;
  const start = HubButtonsService.prototype.start;
  const spy = vi.spyOn(HubButtonsService.prototype, "start").mockImplementation(function(this: HubButtonsService) {
    buttons = this; start.call(this);
  });
  try { const w = await world(); return { ...w, buttons }; } finally { spy.mockRestore(); }
}

describe("Hub buttons use ordinary durable question delivery", () => {
  it("accepts exactly one choice, returns the same receipt on retry, and projects the existing thread view", async () => {
    const w = await world(), b = wire();
    await w.answer(b);
    const key = randomUUID();
    const first = await w.click(b, { index: 0, idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.json.receipt.stage).toBe("queued");
    expect((await w.click(b, { index: 0, idempotencyKey: key })).json.receipt).toEqual(first.json.receipt);
    expect((await w.click(b, { index: 1, idempotencyKey: key })).status).toBe(409);
    expect((await w.click(b, { index: 1 })).status).toBe(410);
    expect(w.questions()).toEqual(["[button] Yes (value: yes)"]);
    const read = await r!.call(w.a, "GET", `/hub/v1/rooms/${w.roomId}/messages`);
    expect(read.json.entries[0]).toMatchObject({ question: "Question", answer: "Choose", buttons: { id: b.id, labels: b.labels, state: "chosen", chosen: 0, by: "asker" } });
    expect(r!.audits.filter(a => a.action === "buttons.chosen")).toHaveLength(1);
  });
  it.each([undefined, {}, { multi: true }])("neither an owner nor admin can bypass the exact room asker (%j)", async poll => {
    const w = await world(), b = wire(poll); await w.answer(b);
    const selection = poll ? { options: [0] } : { index: 0 };
    expect((await w.click(b, selection, w.o)).status).toBe(403);
    expect((await w.click(b, selection, w.admin)).status).toBe(403);
    expect(w.questions()).toEqual([]);
  });
  it("an admin who IS the granted asker can choose in that person's own room", async () => {
    const w = await world({ askerAdmin: true }), b = wire(); await w.answer(b);
    expect((await w.click(b, { index: 0 })).status).toBe(200);
    expect(w.questions()).toHaveLength(1);
  });
  it("concurrent distinct keys have only one winning choice", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const results = await Promise.all([w.click(b, { index: 0 }), w.click(b, { index: 1 })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 410]);
    expect(w.questions()).toHaveLength(1);
  });
  it("rolls back both choice and question if the button audit fails", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    r!.setAuditFails(true, "buttons.chosen");
    expect((await w.click(b, { index: 0 })).status).toBe(500);
    expect(w.questions()).toEqual([]);
    expect(r!.db.prepare("SELECT state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "open" });
    r!.setAuditFails(false);
    expect((await w.click(b, { index: 1 })).status).toBe(200);
    expect(w.questions()).toEqual(["[button] No (value: no)"]);
  });
  it("requires the grant even for an idempotent repeat and refuses disabled people", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const key = randomUUID(); expect((await w.click(b, { index: 0, idempotencyKey: key })).status).toBe(200);
    expect((await r!.call(w.o, "DELETE", `/hub/v1/grants/${w.grant.id}?revision=${w.grant.revision}`)).status).toBe(200);
    expect((await w.click(b, { index: 0, idempotencyKey: key })).status).toBe(403);
    expect(w.questions()).toHaveLength(1);
  });
  it("a revised grant cannot authorize the earlier answer's continuation", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    r!.db.prepare("UPDATE hub_grants SET revision=revision+1 WHERE id=?").run(w.grant.id);
    expect((await w.click(b, { index: 0 })).status).toBe(409);
    expect(w.questions()).toEqual([]);
  });
  it.each(["revoked", "expired"])("a multi-poll ballot needs its current grant (%s, same revision)", async state => {
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    expect((await w.click(b, { options: [0] })).status).toBe(200);
    const before = r!.db.prepare("SELECT ballot_ref FROM hub_answer_buttons WHERE id=?").get(b.id);
    if (state === "revoked") r!.db.prepare("UPDATE hub_grants SET state='revoked' WHERE id=?").run(w.grant.id);
    else r!.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(Date.now() - 1, w.grant.id);
    expect((await w.click(b, { options: [1] })).status).toBe(403);
    expect(r!.db.prepare("SELECT ballot_ref FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual(before);
    expect(r!.audits.filter(a => a.action === "poll.voted")).toHaveLength(1);
    expect(w.questions()).toEqual([]);
  });
  it("a non-directory current actor cannot consume the directory asker's choice", async () => {
    const w = await observedWorld(), b = wire(); await w.answer(b);
    const ctx: HubRequestContext = { requestId: randomUUID(), requirePerson: async () => w.asker,
      requireAdmin: async () => { throw new Error("not used"); },
      // Deliberately retain a person property to pin the actor kind, rather than rely on a later TypeError.
      current: async () => ({ kind: "local-host", person: w.asker, sessionId: randomUUID() } as any) };
    await expect(w.buttons.click(ctx, w.roomId, { setId: b.id, index: 0, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "denied" });
    expect(w.questions()).toEqual([]);
    expect(r!.db.prepare("SELECT state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "open" });
  });
  it("retained choice content must still match the answer's recorded digest", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const row = r!.db.prepare("SELECT answer_ref FROM hub_messages WHERE id=?").get(w.messageId) as { answer_ref: string };
    const saved = r!.contents.get(row.answer_ref)!;
    r!.contents.set(row.answer_ref, { ...saved, buttons: { ...b, values: ["different", "no"] } } as any);
    const refused = await w.click(b, { index: 0 });
    expect(refused.status).toBe(503); expect(refused.json.code).toBe("uncertain");
    expect(w.questions()).toEqual([]);
  });
  it("duplicate multi-poll options are invalid before any ballot write", async () => {
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    expect((await w.click(b, { options: [0, 0] })).status).toBe(400);
    expect(r!.db.prepare("SELECT ballot_ref FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ ballot_ref: null });
    expect(r!.audits.filter(a => a.action === "poll.voted")).toHaveLength(0);
  });
  it("a results call on an already queued row refuses without another question or audit", async () => {
    const w = await observedWorld(), b = wire({}); await w.answer(b);
    expect((await w.click(b, { options: [0] })).status).toBe(200);
    // queueResults is the final state guard for both click and deadline callers; drainResults' guard avoids
    // entering it for a snapshot that became stale during directory I/O. Test its queued-row refusal directly.
    const service = w.buttons as any;
    expect(() => service.core.atomic((db: any, tx: any) => service.queueResults(db, tx,
      db.prepare("SELECT * FROM hub_answer_buttons WHERE id=?").get(b.id), randomUUID()))).toThrow(/conflict/);
    await w.buttons.sweep();
    expect(w.questions()).toHaveLength(1);
    expect(r!.audits.filter(a => a.action === "poll.results")).toHaveLength(1);
  });
  it("rejects metadata without negotiation or with a changed exact release digest", async () => {
    const w = await world({ features: [] }), b = wire();
    await expect(w.answer(b)).rejects.toMatchObject({ code: "incompatible" });
    (w.link.features as Set<string>).add("buttons-v1");
    await expect(w.answer(b, { buttons: { ...b, values: ["changed", "no"] } })).rejects.toMatchObject({ code: "invalid" });
    expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_answer_buttons").get()).toEqual({ n: 0 });
  });
  it("single-choice poll closes on the asker vote and queues results exactly once", async () => {
    const w = await world(), b = wire({}); await w.answer(b);
    const key = randomUUID();
    const vote = await w.click(b, { options: [1], idempotencyKey: key });
    expect(vote.status).toBe(200);
    expect((await w.click(b, { options: [1], idempotencyKey: key })).json.receipt).toEqual(vote.json.receipt);
    expect(w.questions()).toHaveLength(1);
    expect(w.questions()[0]).toContain("[poll results]");
    expect(w.questions()[0]).toContain("No (value: no) — 1");
    expect(w.questions()[0]).not.toContain("close_poll");
    expect(r!.audits.find(a => a.action === "poll.results")?.actor.kind).toBe("local-host");
  });
  it("multiple-choice retains one current ballot, closes at its deadline, and uses no fabricated human session", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    expect((await w.click(b, { options: [0] })).status).toBe(200);
    expect((await w.click(b, { options: [0, 1] })).status).toBe(200);
    expect(w.questions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r!.db.prepare("SELECT state,result_state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "closed", result_state: "queued" });
    expect(w.questions()).toHaveLength(1);
    expect(w.questions()[0]).toContain("Yes (value: yes) — 1");
    expect(w.questions()[0]).toContain("No (value: no) — 1");
    expect(r!.audits.find(a => a.action === "poll.results")?.actor.kind).toBe("local-host");
    expect((await w.click(b, { options: [1] })).status).toBe(410);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.questions()).toHaveLength(1);
  });
  it("restarts with a past-due poll and queues its empty result once", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    // Advance wall time without running the old timer, then rebuild the HTTP/controller over its durable DB.
    vi.setSystemTime(1_020_000);
    await r!.restartHttp();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.questions()).toHaveLength(1);
    expect(w.questions()[0]).toContain("0 voted");
    await r!.restartHttp();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.questions()).toHaveLength(1);
    expect(r!.audits.filter(a => a.action === "poll.closed")).toHaveLength(1);
  });
  it("a result audit failure keeps it owed without a timer spin, then admits exactly once", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    r!.setAuditFails(true, "poll.results");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.questions()).toEqual([]);
    expect(r!.db.prepare("SELECT state,result_state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "closed", result_state: "owed" });
    const checks = r!.directoryCalls;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r!.directoryCalls).toBe(checks);
    r!.setAuditFails(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.questions()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.questions()).toHaveLength(1);
  });
  it("revocation before a deadline prevents automatic results and admits no question", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    expect((await r!.call(w.o, "DELETE", `/hub/v1/grants/${w.grant.id}?revision=${w.grant.revision}`)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.questions()).toEqual([]);
    expect(r!.db.prepare("SELECT state,result_state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "closed", result_state: "cancelled" });
  });
  it("a leaver or unavailable directory holds automatic results until current eligibility returns", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    r!.setEligible("asker", false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.questions()).toEqual([]);
    expect(r!.db.prepare("SELECT result_state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ result_state: "held" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.questions()).toEqual([]);
    r!.setEligible("asker", true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.questions()).toHaveLength(1);
  });
  it("retention removes the choices instead of reconstructing them from a click", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const ref = (r!.db.prepare("SELECT answer_ref FROM hub_messages WHERE id=?").get(w.messageId) as { answer_ref: string }).answer_ref;
    r!.contents.delete(ref);
    expect((await w.click(b, { index: 0 })).status).toBe(410);
    expect(w.questions()).toEqual([]);
  });
  it("a missing CSRF token or foreign origin never consumes the choice", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const body = { setId: b.id, index: 0, idempotencyKey: randomUUID() };
    const path = `/hub/v1/rooms/${w.roomId}/buttons`;
    expect((await r!.call(w.a, "POST", path, body, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
    expect((await r!.call(w.a, "POST", path, body, { Origin: "https://elsewhere.test" })).status).toBe(403);
    expect(w.questions()).toEqual([]);
  });
  it("grant changes during an eligibility await cannot consume a choice", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const real = r!.directory.checkEligibility.bind(r!.directory);
    const spy = vi.spyOn(r!.directory, "checkEligibility").mockImplementation(async key => {
      if (key.objectId === w.owner.objectId) { entered(); await gate; }
      return real(key);
    });
    const click = w.click(b, { index: 0 });
    await seen;
    r!.db.prepare("UPDATE hub_grants SET state='revoked' WHERE id=?").run(w.grant.id);
    release();
    expect((await click).status).toBe(403);
    expect(w.questions()).toEqual([]);
    spy.mockRestore();
  });

  it("a delayed ballot cannot replace a newer committed ballot", async () => {
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    let release!: () => void, entered!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const real = r!.directory.checkEligibility.bind(r!.directory);
    const spy = vi.spyOn(r!.directory, "checkEligibility").mockImplementation(async key => {
      if (key.objectId === w.owner.objectId && !blocked) { blocked = true; entered(); await gate; }
      return real(key);
    });
    const old = w.click(b, { options: [0] }); await seen;
    expect((await w.click(b, { options: [1] })).status).toBe(200);
    release(); expect((await old).status).toBe(409);
    const ref = (r!.db.prepare("SELECT ballot_ref FROM hub_answer_buttons WHERE id=?").get(b.id) as { ballot_ref: string }).ballot_ref;
    expect((r!.contents.get(ref) as any).pollBallot.options).toEqual([1]);
    spy.mockRestore();
  });
  it("a click cannot reuse a typed question's key as its own source receipt", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const key = randomUUID();
    const typed = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: key, text: "[button] Yes (value: yes)" });
    expect(typed.status).toBe(200);
    const choice = await w.click(b, { index: 0, idempotencyKey: key }); expect(choice.status).toBe(200);
    expect(choice.json.receipt.messageId).not.toBe(typed.json.receipt.messageId);
    expect(w.questions()).toEqual(["[button] Yes (value: yes)", "[button] Yes (value: yes)"]);
    expect((await w.click(b, { index: 0, idempotencyKey: key })).json.receipt).toEqual(choice.json.receipt);
  });
  it("an idempotency key cannot choose another answer's set", async () => {
    const w = await world(), a = wire(); await w.answer(a);
    const key = randomUUID(); expect((await w.click(a, { index: 0, idempotencyKey: key })).status).toBe(200);
    const next = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: randomUUID(), text: "Second" });
    const b = wire(); await w.answer(b, { messageId: next.json.receipt.messageId });
    expect((await w.click(b, { index: 0, idempotencyKey: key })).status).toBe(409);
    expect(r!.db.prepare("SELECT state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ state: "open" });
  });

  it("keeps operation idempotency across a controller restart", async () => {
    const w = await world(), b = wire(); await w.answer(b);
    const key = randomUUID(), first = await w.click(b, { index: 0, idempotencyKey: key });
    expect(first.status).toBe(200);
    await r!.restartHttp();
    expect((await w.click(b, { index: 0, idempotencyKey: key })).json.receipt).toEqual(first.json.receipt);
    expect(w.questions()).toHaveLength(1);
  });
  it("a held results eligibility check cannot delay the next poll's durable deadline", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), a = wire({ multi: true }); await w.answer(a);
    await vi.advanceTimersByTimeAsync(4_000);
    const next = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: randomUUID(), text: "Second" });
    const b = wire({ multi: true }); await w.answer(b, { messageId: next.json.receipt.messageId });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const real = r!.directory.checkEligibility.bind(r!.directory);
    let held = false;
    const spy = vi.spyOn(r!.directory, "checkEligibility").mockImplementation(async key => {
      if (!held && key.objectId === w.asker.objectId) { held = true; await gate; }
      return real(key);
    });
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(held).toBe(true);
      expect(r!.db.prepare("SELECT closed_at FROM hub_answer_buttons WHERE id=?").get(a.id)).toEqual({ closed_at: 1_010_000 });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(r!.db.prepare("SELECT closed_at FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ closed_at: 1_014_000 });
      expect(w.questions().filter(q => q?.startsWith("[poll results]"))).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(w.questions().filter(q => q?.startsWith("[poll results]"))).toHaveLength(2);
    } finally { release(); spy.mockRestore(); }
  });
  it("close drains a held check and prevents its late result from being queued", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const w = await world(), b = wire({ multi: true }); await w.answer(b);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const real = r!.directory.checkEligibility.bind(r!.directory);
    const spy = vi.spyOn(r!.directory, "checkEligibility").mockImplementation(async key => {
      if (key.objectId === w.asker.objectId) await gate;
      return real(key);
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      let closed = false;
      const closing = r!.http.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      release(); await closing;
      expect(w.questions()).toEqual([]);
      expect(r!.db.prepare("SELECT result_state FROM hub_answer_buttons WHERE id=?").get(b.id)).toEqual({ result_state: "owed" });
    } finally { release(); spy.mockRestore(); }
  });

});
