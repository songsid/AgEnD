import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";
import { agentPresence, createRoomStatePublisher, formatRoomAskPrompt, HubRoomAskAdapter, migrateRoomAsks, type RoomAsk, type RoomAskOptions, type RoomAskLink, type RoomAnswer, type AgentStateInput, type RoomStateLink } from "../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";

function example(): RoomAsk {
  const fixture = createHubRoomsFixture(), room = fixture.rooms.find(r => r.id === "room-weekly")!;
  const ask = room.messages.find(m => m.mentions.includes("all"))!;
  return { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: room.name,
    asker: { name: ask.author.name }, text: ask.text,
    context: room.messages.filter(m => m.at < ask.at).slice(-30).map(m => ({ author: m.author.name || "System", text: m.text, at: m.at })) };
}

describe("Track C room question presentation", () => {
  it.each(["en", "zh-TW"] as const)("names the fixture's room and asker, ordered context and exact answer correlation (%s)", locale => {
    const ask = example(), cid = `hub-room-${randomUUID()}`, text = formatRoomAskPrompt(ask, cid, locale);
    expect(text).toContain(ask.roomName); expect(text).toContain(ask.asker.name);
    expect(text).toContain("report_result"); expect(text).toContain("agend-hub"); expect(text).toContain(cid);
    expect(text).toContain(ask.text);
    for (const row of ask.context) { expect(text).toContain(row.author); expect(text).toContain(row.text); }
    expect(text.indexOf(ask.context[0]!.text)).toBeLessThan(text.indexOf(ask.context[1]!.text));
    expect(text).toContain(locale === "en" ? "Everyone in this room" : "房間裡的每個人");
  });
  it("keeps the older replied-to row plus the latest30 in order without duplicating it", () => {
    const ask = example(); ask.context = [
      { author: "Earlier", text: "older-replied-row", at: 1, repliedTo: true },
      ...Array.from({ length: 30 }, (_, i) => ({ author: "Colleague", text: `context-${i.toString().padStart(2, "0")}-end`, at: i + 2 })),
    ];
    const text = formatRoomAskPrompt(ask, "hub-room-cid");
    expect(text.split("older-replied-row")).toHaveLength(2);
    expect(text).toContain("Replied-to message");
    expect(text.indexOf("older-replied-row")).toBeLessThan(text.indexOf("context-00-end"));
    expect(text.indexOf("context-00-end")).toBeLessThan(text.indexOf("context-29-end"));
  });
  it.each([
    ["working", { process: "running", execution: "working" }, "working"],
    ["idle", { process: "running", execution: "idle" }, "idle"],
    ["quota", { process: "paused", execution: "working", pauseReason: "quota" }, "paused"],
    ["auth", { process: "paused", execution: "idle", pauseReason: "auth" }, "paused"],
    ["stopped", { process: "stopped", execution: "idle" }, "paused"],
    ["crashed", { process: "crashed", execution: "working" }, "paused"],
    ["stuck", { process: "running", execution: "stuck" }, "paused"],
    ["unknown", { process: "running", execution: null }, "paused"],
  ] as const)("uses actual process/execution state rather than question activity: %s", (_, input, state) => {
    expect(agentPresence(input).state).toBe(state);
  });
  it("localizes the bounded pause reason without exporting the Fleet's detailed activity", () => {
    expect(agentPresence({ process: "paused", execution: "working", pauseReason: "quota" }, "en")).toEqual({ state: "paused", note: "Quota exhausted" });
    expect(agentPresence({ process: "paused", execution: "working", pauseReason: "quota" }, "zh-TW")).toEqual({ state: "paused", note: "額度用完" });
    expect(agentPresence({ process: "running", execution: "idle" })).toEqual({ state: "idle" });
  });
});

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function member() {
  const db = new Database(":memory:"); databases.push(db); migrateRoomAsks(db);
  const ask = example(), inputs: HubRepresentativeDelivery[] = [], sent: RoomAnswer[] = [];
  let live = true, exposure = { agent: "existing-agent", consentId: randomUUID(), revision: 1, token: "life-1" };
  const link: RoomAskLink = { current: () => live, features: new Set(["welcome-caps-v1", "room-ask-v1"]),
    sendAnswer: vi.fn(async a => { sent.push(structuredClone(a)); }) };
  const options: RoomAskOptions = { db, bindingKey: "test-immutable-binding", encryptionKey: randomBytes(32), current: () => live,
    localExposure: id => id === ask.exposureId ? exposure : null,
    deliver: vi.fn(async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; }) };
  const adapter = new HubRoomAskAdapter(options); adapter.connected(link);
  const report = (text = "Room answer") => adapter.report({ caller: exposure.agent, correlationId: inputs[0]!.correlationId, text });
  return { db, ask, inputs, sent, link, options, adapter, report,
    retire: () => { live = false; }, replace: () => { exposure = { ...exposure, token: "replacement" }; } };
}
describe("Track C durable room adapter (injectable Track R seam)", () => {
  it("delivers into the owner's existing agent and preserves the per-agent message identity on replay", async () => {
    const f = member(); expect(f.adapter.accept(f.ask, f.link)).toBe("accepted");
    await f.adapter.settled(); expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0]!.agent).toBe("existing-agent"); expect(f.inputs[0]!.text).toContain(f.ask.roomName);
    expect(f.adapter.accept(structuredClone(f.ask), f.link)).toBe("duplicate"); await f.adapter.settled();
    expect(f.inputs).toHaveLength(1);
    expect(() => f.adapter.accept({ ...f.ask, text: "different" }, f.link)).toThrow("conflict");
  });
  it("freezes an answer before send, retries the exact bytes until the matching ACK, and never re-executes", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
    expect(await f.report()).toMatchObject({ ok: true }); expect(f.sent).toHaveLength(1);
    const first = f.sent[0]!; expect(first).toMatchObject({ messageId: f.ask.messageId, exposureId: f.ask.exposureId, roomId: f.ask.roomId, text: "Room answer" });
    expect(first.answerId).toMatch(/^[a-f0-9-]{36}$/);
    await f.adapter.flush(); expect(f.sent).toEqual([first, first]);
    expect(f.adapter.acknowledge({ messageId: first.messageId, answerId: randomUUID() }, f.link)).toBe(false);
    expect(f.adapter.acknowledge(first, f.link)).toBe(true); await f.adapter.flush(); expect(f.sent).toHaveLength(2);
    expect(await f.report()).toMatchObject({ ok: true }); expect(f.sent).toHaveLength(2);
    expect(await f.report("changed answer")).toMatchObject({ ok: false });
    f.adapter.accept(f.ask, f.link); await f.adapter.settled(); expect(f.inputs).toHaveLength(1);
    expect(f.db.prepare("SELECT value FROM hub_room_asks").get()).not.toEqual(expect.objectContaining({ value: expect.stringContaining("Room answer") }));
  });
  it("retains a send failure for reconnect, with the same answerId and no direct-chat release lease", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
    vi.mocked(f.link.sendAnswer).mockRejectedValueOnce(Error("offline"));
    expect(await f.report()).toMatchObject({ ok: true }); f.adapter.close();
    const reopened = new HubRoomAskAdapter(f.options), next = { ...f.link, sendAnswer: vi.fn(async a => { f.sent.push(a); }) };
    reopened.connected(next); await reopened.flush(); expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).not.toHaveProperty("releaseLease"); expect(f.inputs).toHaveLength(1);
    expect(reopened.acknowledge(f.sent[0]!, f.link)).toBe(false);
    expect(reopened.acknowledge(f.sent[0]!, next)).toBe(true);
  });
  it("can consume an ACK during send without overwriting it on completion", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
    vi.mocked(f.link.sendAnswer).mockImplementation(async a => { expect(f.adapter.acknowledge(a, f.link)).toBe(true); });
    expect(await f.report()).toMatchObject({ ok: true }); await f.adapter.flush(); expect(f.link.sendAnswer).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "acked" });
  });
  it("keeps ACK/control handling independent from a held agent delivery", async () => {
    const f = member(), waiting = deferred<boolean>();
    f.adapter.accept(f.ask, f.link); await f.adapter.settled(); await f.report();
    f.options.deliver = async input => { if (await input.beforeInput()) return waiting.promise; return false; };
    const other = { ...f.ask, messageId: randomUUID() };
    expect(f.adapter.accept(other, f.link)).toBe("accepted");
    expect(f.adapter.acknowledge(f.sent[0]!, f.link)).toBe(true);
    waiting.resolve(true); await f.adapter.settled();
  });
  it.each(["link", "binding", "exposure"])("checks %s again immediately before the ordinary input handoff", async kind => {
    const f = member(), gate = deferred<void>(); let allowed: boolean | undefined;
    f.options.deliver = async input => { await gate.promise; allowed = await input.beforeInput(); return allowed; };
    f.adapter.accept(f.ask, f.link);
    await Promise.resolve();
    if (kind === "link") f.adapter.connected(null); else if (kind === "binding") f.retire(); else f.replace();
    gate.resolve(); await f.adapter.settled(); expect(allowed).toBe(false); expect(f.inputs).toHaveLength(0);
  });
  it("refuses unnegotiated/stale sources and unknown exposures without storing work", () => {
    const f = member();
    expect(() => f.adapter.accept(f.ask, { ...f.link, features: new Set() })).toThrow();
    expect(() => f.adapter.accept({ ...f.ask, exposureId: randomUUID() }, f.link)).toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM hub_room_asks").get()).toEqual({ n: 0 });
  });
  it("routes only its own correlation/agent and refuses unsupported answer extras or a stale caller", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled(); const cid = f.inputs[0]!.correlationId;
    expect(f.adapter.report({ caller: "different", correlationId: cid, text: "answer" })).toBeNull();
    expect(f.adapter.report({ caller: "existing-agent", correlationId: "hub-unowned", text: "answer" })).toBeNull();
    expect(await f.adapter.report({ caller: "existing-agent", correlationId: cid, text: "answer", extras: { files: ["private-file"] } })).toMatchObject({ ok: false });
    expect(await f.adapter.report({ caller: "existing-agent", correlationId: cid, text: "answer", callerCurrent: () => false })).toMatchObject({ ok: false });
    expect(f.sent).toHaveLength(0); expect(await f.report()).toMatchObject({ ok: true });
  });
  it("holds an interrupted first input instead of replaying executable work, but accepts its eventual answer", async () => {
    const f = member(); let cid = ""; const attempted = vi.fn(async (input: HubRepresentativeDelivery) => {
      cid = input.correlationId; expect(await input.beforeInput()).toBe(true); throw Error("lost handoff result");
    }); f.options.deliver = attempted;
    f.adapter.accept(f.ask, f.link); await f.adapter.settled(); f.adapter.close();
    // The durable correlation survives the crash; no second input may be attempted.
    const reopened = new HubRoomAskAdapter(f.options); reopened.connected(f.link);
    reopened.accept(f.ask, f.link); await reopened.settled();
    expect(f.db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "held" });
    expect(attempted).toHaveBeenCalledTimes(1);
    expect(await reopened.report({ correlationId: cid, caller: "existing-agent", text: "Late answer" })).toMatchObject({ ok: true });
    expect(f.sent[0]?.text).toBe("Late answer");
  });
  it("recovers an actual persisted first-input intent as held while its old handoff result is still missing", async () => {
    const f = member(), entered = deferred<void>(), result = deferred<boolean>();
    f.options.deliver = vi.fn(async input => { expect(await input.beforeInput()).toBe(true); entered.resolve(); return result.promise; });
    f.adapter.accept(f.ask, f.link); await entered.promise;
    expect(f.db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "input" }); f.adapter.close();
    const reopened = new HubRoomAskAdapter(f.options);
    try {
      expect(f.db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "held" });
      reopened.connected(f.link); reopened.accept(f.ask, f.link); await reopened.settled();
      expect(f.options.deliver).toHaveBeenCalledTimes(1);
    } finally { result.resolve(false); await f.adapter.settled(); reopened.close(); }
  });
  it("rejects altered ciphertext, another binding and another key instead of falling back to empty history", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled(); f.adapter.close();
    expect(() => new HubRoomAskAdapter({ ...f.options, bindingKey: "different-binding" })).toThrow("uncertain");
    expect(() => new HubRoomAskAdapter({ ...f.options, encryptionKey: randomBytes(32) })).toThrow("uncertain");
    f.db.prepare("UPDATE hub_room_asks SET value='broken'").run();
    expect(() => new HubRoomAskAdapter(f.options)).toThrow("uncertain");
  });
  it("does not execute retained queued work until the current Hub explicitly redelivers it", async () => {
    const f = member(), gate = deferred<void>(); let first: HubRepresentativeDelivery | undefined;
    f.options.deliver = async input => { first = input; await gate.promise; return input.beforeInput(); };
    f.adapter.accept(f.ask, f.link); await Promise.resolve(); f.adapter.close(); gate.resolve(); await f.adapter.settled();
    expect(await first!.beforeInput()).toBe(false);
    f.options.deliver = async input => { if (!await input.beforeInput()) return false; f.inputs.push(input); return true; };
    const reopened = new HubRoomAskAdapter(f.options); reopened.connected(f.link); await reopened.settled();
    expect(f.inputs).toHaveLength(0); reopened.accept(f.ask, f.link); await reopened.settled(); expect(f.inputs).toHaveLength(1);
  });
  it("cannot start two inputs when beforeInput is invoked twice, and report during delivery cannot be overwritten", async () => {
    const f = member(); f.options.deliver = async input => {
      expect(await input.beforeInput()).toBe(true); expect(await input.beforeInput()).toBe(false);
      expect(await f.adapter.report({ caller: input.agent, correlationId: input.correlationId, text: "Answer during handoff" })).toMatchObject({ ok: true });
      expect(f.adapter.acknowledge(f.sent[0]!, f.link)).toBe(true); return true;
    };
    f.adapter.accept(f.ask, f.link); await f.adapter.settled(); expect(f.db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "acked" });
  });
  it("holds answers after local consent changes, and ignores later old-link ACKs", async () => {
    const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled(); await f.report();
    const next = { ...f.link }; f.adapter.connected(next);
    expect(f.adapter.acknowledge(f.sent[0]!, f.link)).toBe(false);
    f.replace(); await f.adapter.flush(); expect(f.sent).toHaveLength(1);
    expect(f.adapter.acknowledge(f.sent[0]!, next)).toBe(false);
    expect(await f.report()).toMatchObject({ ok: false });
  });
  it.each([
    ["invalid id", { messageId: "not-a-uuid" }], ["empty question", { text: " " }], ["oversized question", { text: "x".repeat(65537) }],
    ["too many context rows", { context: Array.from({ length: 32 }, () => ({ author: "A", text: "text", at: 1 })) }],
  ] as const)("rejects %s before creating executable history", (_, change) => {
    const f = member(); expect(() => f.adapter.accept({ ...f.ask, ...change }, f.link)).toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM hub_room_asks").get()).toEqual({ n: 0 });
  });
  it("accepts a 31st older replied-to context row, while refusing 31 ordinary rows", async () => {
    const f = member(), rows = Array.from({ length: 31 }, (_, i) => ({ author: "Colleague", text: `row ${i}`, at: i }));
    expect(() => f.adapter.accept({ ...f.ask, context: rows }, f.link)).toThrow();
    f.adapter.accept({ ...f.ask, context: [{ ...rows[0]!, repliedTo: true }, ...rows.slice(1)] }, f.link); await f.adapter.settled();
    expect(f.inputs).toHaveLength(1); expect(f.inputs[0]!.text).toContain("Replied-to message"); expect(f.inputs[0]!.text).toContain("row 30");
  });
  it("reopens a real on-disk journal with the same frozen answer and no plaintext room content", async () => {
    const f = member(), directory = mkdtempSync(join(tmpdir(), "agend-room-ask-")), file = join(directory, "member.sqlite");
    f.adapter.close(); let db = new Database(file), adapter: HubRoomAskAdapter | undefined;
    try {
      migrateRoomAsks(db); adapter = new HubRoomAskAdapter({ ...f.options, db }); adapter.connected(f.link);
      adapter.accept(f.ask, f.link); await adapter.settled();
      await adapter.report({ caller: "existing-agent", correlationId: f.inputs[0]!.correlationId, text: "Private room answer" });
      const answer = f.sent[0]!; adapter.close(); db.close();
      const bytes = readFileSync(file); expect(bytes.includes(Buffer.from(f.ask.text))).toBe(false); expect(bytes.includes(Buffer.from("Private room answer"))).toBe(false);
      db = new Database(file); adapter = new HubRoomAskAdapter({ ...f.options, db }); adapter.connected(f.link);
      await adapter.flush(); expect(f.sent).toEqual([answer, answer]);
      adapter.accept(f.ask, f.link); await adapter.settled(); expect(f.inputs).toHaveLength(1);
    } finally { adapter?.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("Track C current-link agent.state publisher", () => {
  function publisher() {
    let entries = [{ exposureId: randomUUID(), agent: "owner-agent" }];
    let state: AgentStateInput = { process: "running", execution: "idle" };
    const link: RoomStateLink = { current: () => true, features: new Set(["welcome-caps-v1", "room-ask-v1"]), sendState: vi.fn(async () => {}) };
    const read = vi.fn(async () => state), p = createRoomStatePublisher({ exposures: () => entries, read });
    p.connected(link); return { p, link, read, entries, setState: (next: AgentStateInput) => { state = next; }, withdraw: () => { entries = []; } };
  }
  it("publishes the actual state once, sends only changes and gives a new link a baseline", async () => {
    const f = publisher(); await f.p.refresh(); await f.p.refresh(); expect(f.link.sendState).toHaveBeenCalledTimes(1);
    expect(f.link.sendState).toHaveBeenLastCalledWith({ exposureId: f.entries[0]!.exposureId, state: "idle" });
    f.setState({ process: "running", execution: "working" }); await f.p.refresh();
    expect(f.link.sendState).toHaveBeenLastCalledWith({ exposureId: f.entries[0]!.exposureId, state: "working" });
    const next = { ...f.link, sendState: vi.fn(async () => {}) }; f.p.connected(next); await f.p.refresh(); expect(next.sendState).toHaveBeenCalledTimes(1);
    f.p.close(); await f.p.refresh(); expect(next.sendState).toHaveBeenCalledTimes(1);
  });
  it("coalesces simultaneous refreshes and fences withdrawn exposures across a held read", async () => {
    const f = publisher(), hold = deferred<AgentStateInput>(); f.read.mockReturnValue(hold.promise);
    const first = f.p.refresh(), second = f.p.refresh(); expect(first).toBe(second); expect(f.read).toHaveBeenCalledTimes(1);
    f.withdraw(); hold.resolve({ process: "running", execution: "working" }); await first;
    expect(f.link.sendState).not.toHaveBeenCalled();
  });
  it("does not publish on an old or unnegotiated link or wait behind an old link's held read", async () => {
    const f = publisher(), hold = deferred<AgentStateInput>(); f.read.mockReturnValueOnce(hold.promise);
    const old = f.p.refresh(), next = { ...f.link, sendState: vi.fn(async () => {}) };
    f.p.connected(next); await f.p.refresh(); expect(next.sendState).toHaveBeenCalledTimes(1);
    hold.resolve({ process: "running", execution: "working" }); await old; expect(f.link.sendState).not.toHaveBeenCalled();
    f.p.connected({ ...next, features: new Set() }); await f.p.refresh(); expect(next.sendState).toHaveBeenCalledTimes(1);
  });
  it("retries a failed send instead of marking it sent, and gives a bounded state when reading fails", async () => {
    const f = publisher(); vi.mocked(f.link.sendState).mockRejectedValueOnce(Error("offline"));
    await expect(f.p.refresh()).rejects.toThrow("offline"); await f.p.refresh(); expect(f.link.sendState).toHaveBeenCalledTimes(2);
    f.read.mockRejectedValueOnce(Error("private detailed activity")); await f.p.refresh();
    expect(f.link.sendState).toHaveBeenLastCalledWith({ exposureId: f.entries[0]!.exposureId, state: "paused", note: "Checking agent state" });
  });
});
