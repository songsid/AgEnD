/**
 * #3226 B: the Hub as a chat app.
 * - hubEntryToMessages: one room entry → the fleet thread's messages: the question (the asker's, with its stage as a
 *   delivery mark), then the answer (under the exposure's name) or, unanswered for good, a status line saying why; the
 *   question/answer stay plain strings (an older tab prints them), the files/buttons/quote of D/E/F sit beside them.
 * - createHubChatStore: one read at once, then paced (never faster than POLL_MS; backpressure waits longer); a question
 *   shows at once and the read that brings its entry replaces it; the room comes fresh with each read and what it carries
 *   is kept (G's quota); a revoked/not-found read closes the room and stops reading; nothing is read while hidden.
 * - the server (the real Hub listener over the s3b rig): the rooms list says who each agent answers for, the grant's end,
 *   whether a question waits and when the room last moved (most recent first); the messages answer carries the room;
 *   another person never gets someone else's room (not-found).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let S: any;
// @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
beforeAll(async () => { S = await import("../src/ui/hub-chat-store.js"); });

describe("hubEntryToMessages", () => {
  const room = { id: "r", exposureName: "Sales numbers", ownerName: "Olivia", features: [] };
  const reason = (code: string, stage: string) => `${stage}:${code ?? ""}`;
  it("a question and its answer: the asker's own (with its stage), then the agent's under the exposure's name", () => {
    const m = S.hubEntryToMessages({ messageId: "m", sequence: 3, askedAt: Date.UTC(2026, 10, 6, 9), receipt: { stage: "answered", at: Date.UTC(2026, 10, 6, 10) }, question: "Q?", answer: "A." }, room, { me: "Alex", reason });
    expect(m).toEqual([
      { boot: "hub", id: 6, role: "user", sender: "Alex", ts: "2026-11-06T09:00:00.000Z", text: "Q?", delivery: "delivered" },
      { boot: "hub", id: 7, role: "agent", sender: "Sales numbers", ts: "2026-11-06T10:00:00.000Z", text: "A." },
    ]);
  });
  it("the stages as delivery marks; a question not answered for good says why in a status line", () => {
    const stage = (s: string) => S.hubEntryToMessages({ messageId: "m", sequence: 1, receipt: { stage: s, at: 1, reasonCode: "revoked" }, question: "Q" }, room, { reason });
    expect(["queued", "delivered", "consumed"].map((s) => [stage(s)[0].delivery, stage(s).length])).toEqual([["queued", 1], ["processing", 1], ["processing", 1]]);
    for (const s of ["rejected", "cancelled", "failed", "uncertain"]) {
      const [q, st] = stage(s);
      expect([q.delivery, st.role, st.text], s).toEqual([s === "uncertain" ? "cancelled" : "failed", "status", `${s}:revoked`]);
    }
  });
  it("the strings stay strings; D/E/F's files, buttons and quote are taken from beside them", () => {
    const files = [{ id: "a".repeat(32), name: "a.png", size: 1, mime: "image/png", url: `/hub/v1/rooms/r/files/${"a".repeat(32)}` }];
    const buttons = { id: "b".repeat(32), labels: ["Yes", "No"], state: "open" };
    const [q, a] = S.hubEntryToMessages({ messageId: "m", sequence: 1, receipt: { stage: "answered", at: 1 }, question: "Q", answer: "A",
      questionFiles: files, answerFiles: files, buttons, quote: { kind: "page", fileId: "f", label: "p.html" } }, room, {});
    expect([q.attachments, q.quote, a.attachments, a.buttons]).toEqual([files, { kind: "page", fileId: "f", label: "p.html" }, files, buttons]);
    expect(S.hubEntryToMessages({ messageId: "m", sequence: 1, receipt: { stage: "queued", at: 1 }, question: "Q" }, room, {})[0]).not.toHaveProperty("attachments");
  });
  it("nothing for an entry without a sequence", () => {
    expect([S.hubEntryToMessages(null, room), S.hubEntryToMessages({ messageId: "m" }, room)]).toEqual([[], []]);
  });
});

describe("createHubChatStore", () => {
  function fakeTimers() {
    let next = 1; const due = new Map<number, { at: number; fn: () => void }>(); let now = 0;
    return { setTimeout: (fn: () => void, ms: number) => { const id = next++; due.set(id, { at: now + ms, fn }); return id; }, clearTimeout: (id: number) => { due.delete(id); },
      pending: () => [...due.values()].map((d) => d.at - now), run: () => { const all = [...due.entries()].sort((a, b) => a[1].at - b[1].at); if (!all.length) return; const [id, d] = all[0]!; due.delete(id); now = d.at; d.fn(); } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function client(reads: Array<Record<string, unknown>>) {
    const calls: unknown[][] = [];
    return { calls, read: async (...a: unknown[]) => { calls.push(["read", ...a]); return reads.shift() ?? { ok: true, entries: [] }; },
      ask: async (...a: unknown[]) => { calls.push(["ask", ...a]); return { ok: true, receipt: { messageId: "m9", stage: "queued", at: 5 } }; } };
  }
  const room = { id: "11111111-2222-4333-8444-555555555555", exposureName: "Sales numbers", features: [] };
  it("one read at once, the next only after POLL_MS; backpressure waits as long as the server says (at least POLL_MS)", async () => {
    const t = fakeTimers(), c = client([{ ok: true, entries: [] }, { ok: false, code: "backpressure", retryAfter: 30 }]);
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    expect([c.calls.length, t.pending()]).toEqual([1, [S.POLL_MS]]);
    t.run(); await flush();
    expect([c.calls.length, t.pending()]).toEqual([2, [30_000]]);
    s.stop();
  });
  it("a question shows at once (queued); the read that brings its entry replaces it; a room without quota withdraws it, other fields kept", async () => {
    const t = fakeTimers();
    const c = client([{ ok: true, entries: [], room: { quota: { band: "near_limit" } } },
      { ok: true, entries: [{ messageId: "m9", sequence: 1, receipt: { stage: "delivered", at: 6 }, question: "Q?" }], room: { exposureState: "published" } }]);
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    expect(s.room().quota).toEqual({ band: "near_limit" });
    expect((await s.send("  Q?  ")).ok).toBe(true);
    expect(c.calls[1]![3]).toBe("Q?");
    expect(s.messages().map((m: any) => [m.text, m.delivery])).toEqual([["Q?", "queued"]]);
    t.run(); await flush();
    expect(s.messages().map((m: any) => [m.text, m.delivery])).toEqual([["Q?", "processing"]]);
    // G's quota is the server's to give: a room without it withdraws it (the owner hid it); the other fields stay.
    expect([s.room().quota, s.room().exposureState, s.room().exposureName]).toEqual([undefined, "published", "Sales numbers"]);
    s.stop();
  });
  it("an answer with no room object at all (an older Hub) keeps what is known, quota included", async () => {
    const t = fakeTimers();
    const c = client([{ ok: true, entries: [], room: { quota: { band: "exhausted" } } }, { ok: true, entries: [] }]);
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    t.run(); await flush();
    expect(s.room().quota).toEqual({ band: "exhausted" });
    s.stop();
  });
  it("revoked or not-found closes the room and stops reading; hidden pages do not read", async () => {
    const t = fakeTimers(), c = client([{ ok: false, code: "revoked" }]);
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    expect([s.closed(), t.pending()]).toEqual([true, []]);
    expect((await s.send("x")).code).toBe("invalid");
    s.stop();
    const t2 = fakeTimers(), c2 = client([]);
    const doc = { hidden: true, addEventListener: () => {}, removeEventListener: () => {} };
    const h = S.createHubChatStore(room, { client: c2, timers: t2, doc }); await flush();
    expect([c2.calls.length, t2.pending()]).toEqual([0, [S.POLL_MS]]);
    h.stop();
  });
  it("a full page reads on from its last entry: an old settled-for-good (uncertain) or still-open entry never pins the read (#3246 review)", async () => {
    const page = (from: number, n: number, stage = "answered") => Array.from({ length: n }, (_, i) => ({ messageId: `m${from + i}`, sequence: from + i, receipt: { stage: from + i === 1 ? stage : "answered", at: 1 }, question: "q", answer: "a" }));
    for (const [first, expected] of [["uncertain", [0, 100, 150]], ["queued", [0, 100, 50]]] as const) {   // queued: the tail page (150 - PAGE)
      const t = fakeTimers(), afters: number[] = [];
      const answers = [{ ok: true, entries: page(1, 100, first) }, { ok: true, entries: page(101, 50) }, { ok: true, entries: [] }];
      const c = { read: async (_id: string, after: number) => { afters.push(after); return answers.shift() ?? { ok: true, entries: [] }; } };
      const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
      t.run(); await flush(); t.run(); await flush();
      expect([first, afters], "the reads' `after`").toEqual([first, expected]);
      expect(Math.max(...s.entries().map((e: any) => e.sequence))).toBe(150);
      s.stop();
    }
  });
  it("an open entry older than a page never holds back the tail: the tail page is read each time, the far one every FAR_EVERY-th read", async () => {
    const t = fakeTimers(), afters: number[] = [];
    const entry = (n: number, stage: string) => ({ messageId: `m${n}`, sequence: n, receipt: { stage, at: 1 }, question: "q", ...(stage === "answered" ? { answer: "a" } : {}) });
    const all = Array.from({ length: 250 }, (_, i) => entry(i + 1, i === 0 || i === 248 ? "queued" : "answered"));
    let settled249 = false;
    const c = { read: async (_id: string, after: number) => {
      afters.push(after);
      const rows = all.filter((e) => e.sequence > after).slice(0, 100).map((e) => (e.sequence === 249 && settled249 ? entry(249, "answered") : e));
      return { ok: true, entries: rows };
    } };
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    for (let i = 0; i < 3; i++) { t.run(); await flush(); }                      // 0, 100, 200: all 250 loaded
    settled249 = true;
    t.run(); await flush();
    expect([afters, s.entries().find((e: any) => e.sequence === 249).receipt.stage]).toEqual([afters, "answered"]);   // the tail page, not the far anchor
    for (let i = 0; i < 6; i++) { t.run(); await flush(); }
    expect(afters.slice(0, 3)).toEqual([0, 100, 200]);
    expect(afters.slice(3).filter((a) => a === 0).length, "the far open entry still read now and then").toBeGreaterThanOrEqual(1);
    expect(afters.slice(3).filter((a) => a === 150).length).toBeGreaterThanOrEqual(4);
    s.stop();
  });
  it("two old unsettled entries in different pages are each read again in turn (#3261 review)", async () => {
    const t = fakeTimers(), afters: number[] = [];
    const entry = (n: number, stage: string) => ({ messageId: `m${n}`, sequence: n, receipt: { stage, at: 1 }, question: "q", ...(stage === "answered" ? { answer: "a" } : {}) });
    const all = Array.from({ length: 250 }, (_, i) => entry(i + 1, i === 0 || i === 119 ? "queued" : "answered"));
    let settled120 = false;
    const c = { read: async (_id: string, after: number) => {
      afters.push(after);
      return { ok: true, entries: all.filter((e) => e.sequence > after).slice(0, 100).map((e) => (e.sequence === 120 && settled120 ? entry(120, "answered") : e)) };
    } };
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null }); await flush();
    for (let i = 0; i < 3; i++) { t.run(); await flush(); }
    settled120 = true;
    for (let i = 0; i < 2 * 6 + 2; i++) { t.run(); await flush(); }
    expect(s.entries().find((e: any) => e.sequence === 120).receipt.stage).toBe("answered");
    expect(afters).toContain(119);                                                    // #120's own turn came
    expect(s.entries().find((e: any) => e.sequence === 1).receipt.stage).toBe("queued");   // #1 still open, still visited
    s.stop();
  });
  it("one read at a time: a refresh while a read is out starts no second one", async () => {
    let release!: (v: unknown) => void, reads = 0;
    const c = { read: () => { reads++; return new Promise((r) => { release = r; }); } };
    const t = { setTimeout: (fn: () => void) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} };
    const s = S.createHubChatStore(room, { client: c, timers: t, doc: null });
    s.refresh(); s.refresh(); await flush();
    expect(reads).toBe(1);
    release({ ok: true, entries: [] }); await flush();
    s.stop();
  });
  it("F's hooks are stubs until F: nothing is clicked", async () => {
    const s = S.createHubChatStore(room, { client: client([]), timers: fakeTimers(), doc: null });
    expect([await s.clickButton("x", 0), s.busy("x"), s.mine("x")]).toEqual([{ ok: false, code: "unsupported" }, false, []]);
    s.stop();
  });
});

describe("the Hub's rooms for the chat (the real listener)", () => {
  let rig: any, alex: any, ben: any, olivia: any, link: any, R1 = "", exposureId = "";
  beforeAll(async () => {
    rig = await s3bRig({ attachments: true });                         // D: a Hub that stores files offers attachments-v1
    olivia = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin"); rig.addPerson("ben", "Ben");
    const fleetId = randomUUID(); link = rig.link(fleetId, olivia); exposureId = randomUUID();
    await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner: olivia, displayName: "Sales numbers", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link), link);
    for (const l of ["olivia", "alex", "ben"]) await rig.signIn(l);
    const o = await rig.signIn("olivia");
    const g = (await rig.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 })).json.grant;
    alex = await rig.signIn("alex"); ben = await rig.signIn("ben");
    R1 = (await rig.call(alex, "POST", "/hub/v1/rooms", { exposureId, grantId: g.id })).json.room.id;
  });
  afterAll(async () => { await rig?.close(); });
  it("each person lists only their own rooms", async () => {
    expect((await rig.call(ben, "GET", "/hub/v1/rooms")).json.rooms).toEqual([]);
    expect((await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms.map((r: any) => r.id)).toEqual([R1]);
  });
  it("the list: who it answers for, the grant's end, a waiting question, when it last moved", async () => {
    const before = (await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms;
    expect(before.map((r: any) => [r.id, r.exposureName, r.ownerName, r.waiting, r.exposureState, typeof r.grantExpiresAt, r.features])).toEqual([[R1, "Sales numbers", "Olivia Chen", false, "published", "number", []]]);
    const asked = await rig.call(alex, "POST", `/hub/v1/rooms/${R1}/messages`, { idempotencyKey: randomUUID(), text: "Q3?" });
    expect(asked.status).toBe(200);
    const after = (await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms[0];
    expect([after.waiting, after.lastAt >= before[0].lastAt]).toEqual([true, true]);
  });
  it("features: what the room's current fleet link negotiated (none without a current link)", async () => {
    link.features = new Set(["buttons-v1", "attachments-v1"]);
    expect((await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms[0].features).toEqual(["attachments-v1", "buttons-v1"]);
    link.alive = false;
    expect((await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms[0].features).toEqual([]);
    link.alive = true;
  });
  it("the messages answer carries the room; its entries say when each was asked; another person's read is not-found", async () => {
    const r = await rig.call(alex, "GET", `/hub/v1/rooms/${R1}/messages?after=0`);
    expect([r.status, r.json.room.id, r.json.room.ownerName, typeof r.json.entries[0].askedAt, r.json.entries[0].question]).toEqual([200, R1, "Olivia Chen", "number", "Q3?"]);
    const other = await rig.call(ben, "GET", `/hub/v1/rooms/${R1}/messages?after=0`);
    expect([other.status, other.json.code]).toEqual([404, "not-found"]);
    expect(JSON.stringify(other.json)).not.toContain("Sales numbers");
  });
  it("answered: no longer waiting", async () => {
    const q = rig.sent.map((x: any) => x.frame).find((f: any) => f.type === "question");
    const messageId = q.payload.identity.messageId, answerId = randomUUID(), text = "42.";
    const lease = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: sha(text) } }, link), link);
    await rig.http.receive(rig.frame("answer", { messageId, answerId, text, contentDigest: sha(text), releaseLease: lease.payload.lease }, link), link);
    expect((await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms[0].waiting).toBe(false);
  });
  it("a revoked grant closes the room: still listed (as closed, with its name), its history no longer readable", async () => {
    const o = await rig.signIn("olivia");
    const g = (await rig.call(o, "GET", "/hub/v1/exposures")).json.mine[0].grants[0];
    expect((await rig.call(o, "DELETE", `/hub/v1/grants/${g.id}?revision=${g.revision}`)).status).toBe(200);
    const listed = (await rig.call(alex, "GET", "/hub/v1/rooms")).json.rooms;
    expect(listed.map((r: any) => [r.id, r.state, r.exposureName, r.ownerName, r.grantExpiresAt, r.waiting, r.features])).toEqual([[R1, "closed", "Sales numbers", "Olivia Chen", 0, false, []]]);
    const fresh = await rig.signIn("alex");          // a session of its own: the room's reads are paced per session
    expect((await rig.call(fresh, "GET", `/hub/v1/rooms/${R1}/messages?after=0`)).status).toBe(403);
  });
});
