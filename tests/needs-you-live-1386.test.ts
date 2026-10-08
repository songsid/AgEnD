/**
 * #1386 §5.2a–5.4: one world's live message — generations, revoke-before-await, fences, rate limits, the pointer.
 * A controlled monotonic clock and recorded effects; no platform.
 */
import { describe, expect, it } from "vitest";
import { NeedsYouLiveMessage, canonicalTarget, samePlace, DEBOUNCE_MS, EDIT_MIN_MS, POST_MIN_MS, RENEW_MS, type LiveContent, type LivePointer, type LiveTarget } from "../src/needs-you-live.js";
import type { NeedsYouItem } from "../src/needs-you.js";

const delivery = (id: string): NeedsYouItem => ({ id: `delivery:${id}`, type: "delivery", instance: "t", reason: "delivery_failed", detail: "", since: 0, deliveryId: id, owner: "dc" });

function rig(over: { pointer?: LivePointer | null; target?: LiveTarget | null; content?: LiveContent } = {}) {
  let now = 0, nextMsg = 1;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let timerId = 0;
  const log: string[] = [];
  let target: LiveTarget | null = over.target === undefined ? { chatId: "g", threadId: "general" } : over.target;
  let enabled = true, stopping = false, exists = true;
  let content: LiveContent = over.content ?? { empty: false, text: "list", ackable: [delivery("d1")] };
  const live = new Set<number>();                   // generations whose acks are currently valid
  const minted: Array<{ generation: number; messageId?: string }> = [];
  let saved: LivePointer | null = over.pointer ?? null;
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void; kind: string }> = [];
  let hold = false;                                  // hold the next post/edit ACK until released
  let failEdit = false;
  const ack = <T>(kind: string, value: T): Promise<T> => hold
    ? new Promise<T>((resolve, reject) => pending.push({ resolve: () => resolve(value), reject, kind }))
    : Promise.resolve(value);
  const m = new NeedsYouLiveMessage({
    world: "dc",
    now: () => now,
    setTimer: (fn, ms) => { const id = ++timerId; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    target: () => target, enabled: () => enabled, stopping: () => stopping, worldExists: () => exists,
    content: () => content,
    post: async (t, text, choices) => { const id = `m${nextMsg++}`; log.push(`post ${id} @${t.chatId}/${t.threadId ?? "-"} [${choices.length}] ${text}`); return ack("post", { ...canonicalTarget(t), messageId: id }); },
    edit: async (p, text, choices) => { log.push(`edit ${p.messageId} [${choices.length}] ${text}`); if (failEdit) throw new Error("too old"); return ack("edit", undefined); },
    remove: async p => { log.push(`remove ${p.messageId}`); },
    loadPointer: () => saved,
    savePointer: p => { saved = p; log.push(`save ${p?.messageId ?? "null"}`); },
    mintAcks: (generation, place, items) => {
      live.add(generation);
      const entry = { generation, messageId: place.messageId };
      minted.push(entry);
      return { choices: items.map(i => ({ id: `ack:${generation}:${i.deliveryId}`, label: "Ack" })), bind: p => { entry.messageId = p.messageId; } };
    },
    revokeAcks: () => { live.clear(); log.push("revoke"); },
    log: (msg) => log.push(`log ${msg}`),
    text: { stopped: "STOPPED", off: "OFF" },
  });
  /** Advance the clock, firing due timers in order; let promises settle between. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return {
    m, log, live, minted, advance, settle, pending,
    get saved() { return saved; },
    set: {
      target: (t: LiveTarget | null) => { target = t; }, enabled: (v: boolean) => { enabled = v; }, stopping: (v: boolean) => { stopping = v; },
      exists: (v: boolean) => { exists = v; }, content: (c: LiveContent) => { content = c; }, hold: (v: boolean) => { hold = v; }, failEdit: (v: boolean) => { failEdit = v; },
    },
  };
}

describe("canonical places (§5.4)", () => {
  it("Telegram General '1' and no thread are the same place; another thread or chat is not", () => {
    expect(samePlace({ chatId: "-100", threadId: "1" }, { chatId: "-100" })).toBe(true);
    expect(samePlace({ chatId: "-100", threadId: "5" }, { chatId: "-100" })).toBe(false);
    expect(samePlace({ chatId: "-100" }, { chatId: "-200" })).toBe(false);
  });
});

describe("first message, edits and new posts (§5.3)", () => {
  it("starts by posting the list (no pointer yet), binds its acks to the posted message, saves the pointer", async () => {
    const r = rig();
    await r.advance(0);
    expect(r.log.filter(l => l.startsWith("post") || l.startsWith("save"))).toEqual(["post m1 @g/general [1] list", "save m1"]);
    expect(r.minted.at(-1)).toEqual({ generation: 1, messageId: "m1" });
  });

  it("nothing to say and nothing said: no message at all", async () => {
    const r = rig({ content: { empty: true, text: "none", ackable: [] } });
    await r.advance(0);
    expect(r.log.some(l => l.startsWith("post"))).toBe(false);
  });

  it("a change edits in place after the debounce, at most one edit per EDIT_MIN_MS; a new item posts, at most once per POST_MIN_MS", async () => {
    const r = rig();
    await r.advance(0);                                         // post m1
    r.log.length = 0;
    r.m.changed(false);
    await r.advance(DEBOUNCE_MS - 1);
    expect(r.log.filter(l => l.startsWith("edit"))).toEqual([]);
    await r.advance(EDIT_MIN_MS);
    expect(r.log.filter(l => l.startsWith("edit"))).toEqual(["edit m1 [1] list"]);
    r.log.length = 0;
    r.m.changed(true);                                          // a new item, inside the post window
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);
    expect(r.log.filter(l => /^(edit|post)/.test(l))).toEqual(["edit m1 [1] list"]);   // shown by an edit first
    await r.advance(POST_MIN_MS);
    expect(r.log.filter(l => /^(post|remove)/.test(l))).toEqual(["post m2 @g/general [1] list", "remove m1"]);   // then posted
  });

  it("an edit that fails (too old, gone) becomes a new post", async () => {
    const r = rig();
    await r.advance(0);
    r.set.failEdit(true);
    r.log.length = 0;
    r.m.changed(false);
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);
    expect(r.log.filter(l => /^(edit|post|remove|save)/.test(l))).toEqual(["edit m1 [1] list", "post m2 @g/general [1] list", "save m2", "remove m1"]);
  });
});

describe("capabilities: one generation per render (§5.2a)", () => {
  it("the previous generation is revoked before the render's first await", async () => {
    const r = rig();
    await r.advance(0);
    expect(r.live.has(1)).toBe(true);
    r.set.hold(true);
    r.m.changed(false);
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);                 // the edit is now awaiting its ACK
    expect(r.pending).toHaveLength(1);
    expect(r.live.has(1)).toBe(false);                          // already revoked
    expect(r.live.has(2)).toBe(true);
    r.pending.shift()!.resolve();
    await r.settle();
  });

  it("left alone past the old 15-minute expiry: renewed (fresh generation), never overwritten by expiry text", async () => {
    const r = rig();
    await r.advance(0);
    r.log.length = 0;
    await r.advance(RENEW_MS + 1);
    expect(r.log.filter(l => l.startsWith("edit"))).toEqual(["edit m1 [1] list"]);
    expect(r.m.currentGeneration).toBe(2);
    await r.advance(RENEW_MS + 1);
    expect(r.m.currentGeneration).toBe(3);
    expect(r.log.some(l => /STOPPED|OFF|expired/i.test(l))).toBe(false);
  });

  it("after a restart (pointer on disk, no capabilities): the first render edits that message with fresh acks", async () => {
    const r = rig({ pointer: { chatId: "g", threadId: "general", messageId: "m9" } });
    await r.advance(0);
    expect(r.log.filter(l => /^(edit|post)/.test(l))).toEqual(["edit m9 [1] list"]);
    expect(r.minted.at(-1)).toEqual({ generation: 1, messageId: "m9" });
  });
});

describe("fences: late ACKs publish nothing current (§5.3a)", () => {
  for (const [name, flip] of [
    ["live_message turned off", (r: ReturnType<typeof rig>) => r.set.enabled(false)],
    ["the world rebound to another General", (r: ReturnType<typeof rig>) => r.set.target({ chatId: "g2", threadId: "general2" })],
    ["the world removed", (r: ReturnType<typeof rig>) => r.set.exists(false)],
    ["the fleet stopping", (r: ReturnType<typeof rig>) => r.set.stopping(true)],
  ] as const) {
    it(`a post whose ACK arrives after ${name}: no pointer, no capabilities, and the late message is deleted`, async () => {
      const r = rig();
      r.set.hold(true);
      await r.advance(0);
      expect(r.pending[0]!.kind).toBe("post");
      flip(r);
      r.pending.shift()!.resolve();
      await r.settle();
      expect(r.saved).toBeNull();
      expect(r.live.size).toBe(0);
      expect(r.log).toContain("remove m1");
    });
  }

  it("an edit whose ACK arrives after a rebind: its acks are revoked", async () => {
    const r = rig();
    await r.advance(0);
    r.set.hold(true);
    r.m.changed(false);
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);
    r.set.target({ chatId: "g2" });
    r.pending.shift()!.resolve();
    await r.settle();
    expect(r.live.size).toBe(0);
  });

  it("concurrent changes: one render in flight, exactly one follow-up", async () => {
    const r = rig();
    await r.advance(0);
    r.set.hold(true);
    r.m.changed(false);
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);
    void r.m.render(); void r.m.render(); void r.m.render();   // all coalesce into one rerun
    expect(r.pending).toHaveLength(1);
    r.set.hold(false);
    r.pending.shift()!.resolve();
    await r.settle();                                           // the first render finishes and schedules its rerun
    await r.advance(EDIT_MIN_MS + DEBOUNCE_MS);
    expect(r.log.filter(l => l.startsWith("edit"))).toHaveLength(2);
  });
});

describe("the pointer across restarts (§5.4)", () => {
  it("same place (Telegram General '1' = omitted): reused", async () => {
    const r = rig({ pointer: { chatId: "-100", messageId: "m9" }, target: { chatId: "-100", threadId: "1" } });
    await r.advance(0);
    expect(r.log.filter(l => /^(edit|post)/.test(l))).toEqual(["edit m9 [1] list"]);
  });

  it("the target moved: the old message never gets the current list — it is removed, and a new one posted at the new place", async () => {
    const r = rig({ pointer: { chatId: "old-guild", threadId: "old-general", messageId: "m9" }, target: { chatId: "g", threadId: "general" } });
    await r.advance(0);
    expect(r.log.filter(l => /^(edit|post|remove)/.test(l))).toEqual(["post m1 @g/general [1] list", "remove m9"]);
    expect(r.log.some(l => l.startsWith("edit m9"))).toBe(false);
  });
});

describe("shutdown and off", () => {
  it("retire: revoke first, then 'stopped' without buttons, and no more renders", async () => {
    const r = rig();
    await r.advance(0);
    r.log.length = 0;
    await r.m.retire();
    expect(r.log).toEqual(["revoke", "edit m1 [0] STOPPED"]);
    r.m.changed(true);
    await r.advance(POST_MIN_MS * 2);
    expect(r.log).toEqual(["revoke", "edit m1 [0] STOPPED"]);
  });

  it("disable: revoke, 'off' without buttons, forget the pointer", async () => {
    const r = rig();
    await r.advance(0);
    r.log.length = 0;
    await r.m.disable();
    expect(r.log).toEqual(["revoke", "save null", "edit m1 [0] OFF"]);
    expect(r.saved).toBeNull();
  });
});
