/**
 * #1386 §5.0–5.5, §6.1: the hub — owning-world scoping of the live messages and DMs, Acknowledge from chat (binding,
 * owning-world admin, the item still this world's, stale clicks never editing) and from the web (any item), and the
 * web list. Two Discord worlds with different admins; fake adapters record every call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouHub, type NeedsYouHubContext } from "../src/needs-you-hub.js";
import type { DeliveryInput, InstanceInput, PromptInput } from "../src/needs-you.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function adapter(name: string) {
  let n = 0;
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const gate = <T>(v: T): Promise<T> => hold ? new Promise<T>(res => held.push(() => res(v))) : Promise.resolve(v);
  return {
    calls,
    held,
    setHold: (v: boolean) => { hold = v; },
    a: {
      type: "discord",
      notifyAlert: vi.fn(async (chatId: string, alert: { message: string; choices?: Array<{ id: string }> }, opts?: { threadId?: string }) => {
        calls.push(`post ${chatId}/${opts?.threadId} ${alert.message.split("\n").join(" | ")} [${(alert.choices ?? []).map(c => c.id.split(":")[0]).join(",")}]`);
        return gate({ messageId: `${name}-m${++n}`, chatId, threadId: opts?.threadId });
      }),
      editAlert: vi.fn(async (_c: string, messageId: string, alert: { message: string; choices?: unknown[] }) => { calls.push(`edit ${messageId} ${alert.message.split("\n").join(" | ")} [${(alert.choices ?? []).length}]`); return gate(undefined); }),
      deleteMessage: vi.fn(async (_c: string, messageId: string) => { calls.push(`delete ${messageId}`); }),
      sendDirect: vi.fn(async (user: string, text: string) => { calls.push(`dm ${user} ${text.split("\n").join(" | ")}`); return { messageId: "dm", chatId: user }; }),
    } as any,
  };
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "hub-1386-")); dirs.push(dir);
  let wall = 1_000_000, mono = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  const A = adapter("A"), B = adapter("B");
  const worldAdapters: Record<string, any> = { dcA: A.a, dcB: B.a };
  const state = {
    prompts: [] as PromptInput[],
    instances: [] as InstanceInput[],
    deliveries: [] as DeliveryInput[],
    owners: { alpha: "dcA", beta: "dcB" } as Record<string, string | undefined>,
    admins: { dcA: ["100"], dcB: ["200"] } as Record<string, string[]>,
    acked: new Map<string, string>(),
    ackThrows: false,
    settings: { liveMessage: true, dm: false },
    sse: [] as Array<{ event: string; data: any }>,
  };
  const ctx: NeedsYouHubContext = {
    dataDir: dir,
    now: () => wall, mono: () => mono,
    setTimer: (fn, ms) => { const h = ++id; timers.push({ at: mono + ms, fn, id: h }); return h; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    prompts: () => state.prompts,
    instances: () => state.instances,
    deliveries: () => state.deliveries.filter(d => !state.acked.has(d.deliveryId)),
    ownerOf: i => state.owners[i],
    worlds: () => [
      { id: "dcA", place: { type: "discord", groupId: "111111" }, adapter: worldAdapters.dcA },
      { id: "dcB", place: { type: "discord", groupId: "222222" }, adapter: worldAdapters.dcB },
    ],
    noticeTarget: w => (w === "dcA" ? { chatId: "111111", threadId: "900001" } : { chatId: "222222", threadId: "900002" }),
    instanceTopic: i => (i === "alpha" ? "700001" : i === "beta" ? "700002" : undefined),
    isFleetAdmin: (u, w) => (state.admins[w] ?? []).includes(u),
    fleetAdmins: w => state.admins[w] ?? [],
    emitSse: (event, data) => state.sse.push({ event, data }),
    acknowledge: (deliveryId, by) => {
      if (state.ackThrows) throw new Error("SQLITE_BUSY");
      if (state.acked.has(deliveryId)) return false;
      state.acked.set(deliveryId, by);
      return true;
    },
    settings: () => state.settings,
    stopping: () => false,
    t: (k, ...a) => `${k}${a.length ? `(${a.join(",")})` : ""}`,
    log: () => {},
  };
  const hub = new NeedsYouHub(ctx);
  const advance = async (ms: number) => {
    const end = mono + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); mono = next.at; next.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    mono = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { hub, A, B, state, advance, worldAdapters, tick: (ms: number) => { wall += ms; } };
}

const delivery = (id: string, target: string): DeliveryInput => ({ deliveryId: id, state: "uncertain", source: "src", target, kind: "fleet_inbound", finishedAt: 999_000 });

/** The Acknowledge callback ids a world's adapter was given on its latest post/edit. */
function lastChoices(adapterMock: any): string[] {
  // The latest of the post/edit calls across both mocks, by call order.
  const withOrder = [
    ...adapterMock.notifyAlert.mock.calls.map((c: any, i: number) => ({ o: adapterMock.notifyAlert.mock.invocationCallOrder[i], ch: c[1].choices ?? [] })),
    ...adapterMock.editAlert.mock.calls.map((c: any, i: number) => ({ o: adapterMock.editAlert.mock.invocationCallOrder[i], ch: c[2].choices ?? [] })),
  ].sort((a, b) => a.o - b.o);
  return (withOrder.at(-1)?.ch ?? []).map((c: any) => c.id);
}

describe("§5.0 each world's chat shows only the items of the instances it owns; /ui shows all", () => {
  it("A's live message lists alpha only, B's beta only, and an instance with no world is web-only", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha"), delivery("d2", "beta"), delivery("d3", "orphan")];
    r.hub.start();
    await r.advance(0);
    expect(r.A.calls.filter(c => c.startsWith("post"))).toEqual(["post 111111/900001 needs.live_header(1) | • alpha — needs.reason.delivery_uncertain (<1m) · <#700001> [needs-ack]"]);
    expect(r.B.calls.filter(c => c.startsWith("post"))).toEqual(["post 222222/900002 needs.live_header(1) | • beta — needs.reason.delivery_uncertain (<1m) · <#700002> [needs-ack]"]);
    expect(r.hub.webItems().map(i => i.instance).sort()).toEqual(["alpha", "beta", "orphan"]);
    expect(r.hub.webItems().every(i => !("promptAt" in i))).toBe(true);
  });
});

describe("§5.2 Acknowledge from chat", () => {
  async function started() {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha"), delivery("d2", "beta")];
    r.hub.start();
    await r.advance(0);
    const [ackA] = lastChoices(r.A.a);
    const [ackB] = lastChoices(r.B.a);
    const msgA = (await r.A.a.notifyAlert.mock.results[0].value).messageId;
    const msgB = (await r.B.a.notifyAlert.mock.results[0].value).messageId;
    return { r, ackA: ackA!, ackB: ackB!, msgA, msgB };
  }
  const click = (r: ReturnType<typeof rig>, world: string, callbackData: string, chatId: string, threadId: string, messageId: string, userId: string) => {
    const acks: string[] = [];
    const handled = r.hub.handleCallback({ callbackData, chatId, threadId, messageId, userId, ack: n => acks.push(n ?? "") }, world);
    return { handled, acks };
  };

  it("A's admin on A's message: acknowledged (recorded as discord:<user>), every surface re-renders without it", async () => {
    const { r, ackA, msgA } = await started();
    const res = click(r, "dcA", ackA, "111111", "900001", msgA, "100");
    expect(res).toEqual({ handled: true, acks: ["needs.ack_done"] });
    expect(r.state.acked.get("d1")).toBe("discord:100");
    await r.advance(20_000);
    expect(r.hub.webItems().map(i => i.instance)).toEqual(["beta"]);
    expect(r.A.calls.at(-1)).toBe("edit A-m1 needs.live_empty [0]");
  });

  it("B's admin (not A's) on A's message: refused as not an admin there", async () => {
    const { r, ackA, msgA } = await started();
    expect(click(r, "dcA", ackA, "111111", "900001", msgA, "200")).toEqual({ handled: true, acks: ["buttons.admin_only"] });
    expect(r.state.acked.size).toBe(0);
  });

  it("A's capability arriving through B's world, or from another message/channel: refused by the binding", async () => {
    const { r, ackA, msgA } = await started();
    expect(click(r, "dcB", ackA, "111111", "900001", msgA, "200").acks).toEqual(["buttons.wrong_place"]);
    expect(click(r, "dcA", ackA, "111111", "900001", "other-msg", "100").acks).toEqual(["buttons.wrong_place"]);
    expect(click(r, "dcA", ackA, "111111", "other-thread", msgA, "100").acks).toEqual(["buttons.wrong_place"]);
    expect(r.state.acked.size).toBe(0);
  });

  it("the instance moved to another world since the message was rendered: refused", async () => {
    const { r, ackA, msgA } = await started();
    r.state.owners.alpha = "dcB";
    expect(click(r, "dcA", ackA, "111111", "900001", msgA, "100").acks).toEqual(["needs.ack_not_this_world"]);
    expect(r.state.acked.size).toBe(0);
  });

  it("a stale button (an older render) only answers the clicker — the live message is not edited", async () => {
    const { r, ackA, msgA } = await started();
    r.tick(61_000);                                               // the age label changes → a re-render, new generation
    await r.advance(20_000);
    const editsBefore = r.A.a.editAlert.mock.calls.length;
    expect(editsBefore).toBeGreaterThan(0);
    expect(click(r, "dcA", ackA, "111111", "900001", msgA, "100").acks).toEqual(["needs.ack_stale"]);
    expect(r.A.a.editAlert.mock.calls.length).toBe(editsBefore);
    expect(r.A.a.deleteMessage).not.toHaveBeenCalled();
    expect(r.state.acked.size).toBe(0);
  });

  it("a write failure is told to the clicker and the item stays", async () => {
    const { r, ackA, msgA } = await started();
    r.state.ackThrows = true;
    expect(click(r, "dcA", ackA, "111111", "900001", msgA, "100").acks).toEqual(["needs.ack_failed"]);
    await r.advance(20_000);
    expect(r.hub.webItems().map(i => i.instance).sort()).toEqual(["alpha", "beta"]);
  });

  it("not ours: false (the fleet's other handlers see it)", async () => {
    const { r } = await started();
    expect(r.hub.handleCallback({ callbackData: "hang:" + "a".repeat(32) + ":restart", chatId: "x", messageId: "y" }, "dcA")).toBe(false);
  });
});

describe("§6.1 the web's Acknowledge: any item, any world", () => {
  it("acknowledges B's item as web:<handle>; an unknown or already-handled id is 409; a write failure 500", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d2", "beta"), delivery("d3", "orphan")];
    r.hub.start();
    await r.advance(0);
    expect(r.hub.webAcknowledge("delivery:d2", "web:0123456789abcdef")).toEqual({ status: 200, message: "needs.ack_done" });
    expect(r.state.acked.get("d2")).toBe("web:0123456789abcdef");
    expect(r.hub.webAcknowledge("delivery:nope", "web:x").status).toBe(409);
    expect(r.hub.webAcknowledge("prompt:abc", "web:x").status).toBe(400);
    r.state.ackThrows = true;
    expect(r.hub.webAcknowledge("delivery:d3", "web:x")).toEqual({ status: 500, message: "needs.ack_failed" });
  });
});

describe("§4.2 the web hears every change once; a restart is not news", () => {
  it("SSE `needs` on a change only; items present at start do not post anew or DM", async () => {
    const r = rig();
    r.state.settings.dm = true;
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.start();
    await r.advance(0);
    const needs = () => r.state.sse.filter(e => e.event === "needs");
    expect(needs()).toHaveLength(1);
    r.hub.recompute();
    expect(needs()).toHaveLength(1);                            // nothing changed
    expect(r.A.calls.some(c => c.startsWith("dm"))).toBe(false); // there at start: no DM
  });
});

describe("§5.5 DMs (opt-in): the owning world's admins, new items only, rate-limited", () => {
  it("a new item DMs A's admin only; a second new item inside a minute is folded into the next DM", async () => {
    const r = rig();
    r.state.settings.dm = true;
    r.hub.start();
    await r.advance(0);
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.recompute();
    await r.advance(0);
    expect(r.A.calls.filter(c => c.startsWith("dm"))).toEqual(["dm 100 needs.dm_header(1) | • alpha — needs.reason.delivery_uncertain · <#700001>"]);
    expect(r.B.calls.filter(c => c.startsWith("dm"))).toEqual([]);
    r.state.deliveries = [delivery("d1", "alpha"), delivery("d4", "alpha")];
    r.hub.recompute();
    await r.advance(1_000);
    expect(r.A.calls.filter(c => c.startsWith("dm"))).toHaveLength(1);
    await r.advance(60_000);
    expect(r.A.calls.filter(c => c.startsWith("dm")).at(-1)).toBe("dm 100 needs.dm_header(1) | • alpha — needs.reason.delivery_uncertain · <#700001>");
  });

  it("a terminal wait is DMed only once it has lasted 5 s (a dialog AgEnD answers itself never pings); the list shows it at once", async () => {
    const r = rig();
    r.state.settings.dm = true;
    r.hub.start();
    await r.advance(0);
    const wall = () => r.hub["ctx"].now();
    r.state.instances = [{ name: "alpha", state: "awaiting_input", interaction: { kind: "permission", owner: "o", episode: 1, since: wall() }, interactionSummary: "" }];
    r.hub.recompute();
    await r.advance(0);
    expect(r.hub.webItems().map(i => i.type)).toEqual(["awaiting_input"]);   // listed at once
    expect(r.A.calls.some(c => c.startsWith("dm"))).toBe(false);              // not pinged yet
    r.tick(5_000);
    r.hub.recompute();
    await r.advance(0);
    expect(r.A.calls.filter(c => c.startsWith("dm"))).toEqual(["dm 100 needs.dm_header(1) | • alpha — needs.reason.permission · <#700001>"]);
  });

  it("off by default", async () => {
    const r = rig();
    r.hub.start();
    await r.advance(0);
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.recompute();
    await r.advance(120_000);
    expect(r.A.calls.some(c => c.startsWith("dm"))).toBe(false);
  });
});

describe("#1398 review: delayed DMs, replaced adapters, capability expiry and binding", () => {
  const dmsOf = (calls: string[]) => calls.filter(c => c.startsWith("dm"));

  it("a DM queued for A is not sent to A after the instance moved to B (B's admins hear it instead)", async () => {
    const r = rig();
    r.state.settings.dm = true;
    r.hub.start(); await r.advance(0);
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.recompute(); await r.advance(0);                       // A's first DM: the next may come in a minute
    r.state.deliveries = [delivery("d1", "alpha"), delivery("d4", "alpha")];
    r.hub.recompute(); await r.advance(1_000);                   // d4 queued for A
    r.state.owners.alpha = "dcB";
    r.hub.recompute(); await r.advance(120_000);
    expect(dmsOf(r.A.calls)).toHaveLength(1);                    // nothing more for A
    expect(dmsOf(r.B.calls).join("\n")).toContain("alpha");      // B owns it now
  });

  it("moved to B and the timer fires before any recompute: still nothing for A (ownership checked at send)", async () => {
    const r = rig();
    r.state.settings.dm = true;
    r.hub.start(); await r.advance(0);
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.recompute(); await r.advance(0);
    r.state.deliveries = [delivery("d1", "alpha"), delivery("d2", "alpha")];
    r.hub.recompute(); await r.advance(1_000);                   // d2 queued for A, sent when the minute is up
    r.state.owners.alpha = "dcB";                                // moved — and no recompute before the timer
    await r.advance(60_000);
    expect(dmsOf(r.A.calls)).toHaveLength(1);
  });

  it("no DM after dm is turned off, or after stop, even when one was queued", async () => {
    for (const end of ["off", "stop"] as const) {
      const r = rig();
      r.state.settings.dm = true;
      r.hub.start(); await r.advance(0);
      r.state.deliveries = [delivery("d1", "alpha")];
      r.hub.recompute(); await r.advance(0);
      r.state.deliveries = [delivery("d1", "alpha"), delivery("d4", "alpha")];
      r.hub.recompute(); await r.advance(1_000);
      if (end === "off") { r.state.settings.dm = false; r.hub.recompute(); } else await r.hub.stop();
      await r.advance(120_000);
      expect(dmsOf(r.A.calls), end).toHaveLength(1);
    }
  });

  it("a replaced adapter under the same world id: the old one is never used again, and its late post ACK publishes nothing", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.A.setHold(true);
    r.hub.start(); await r.advance(0);                           // A's first post is in flight (held)
    const fresh = adapter("A2");
    r.worldAdapters.dcA = fresh.a;
    r.hub.recompute(); await r.advance(20_000);
    expect(fresh.calls.some(c => c.startsWith("post"))).toBe(true);   // the new adapter posts
    const oldCalls = r.A.calls.length;
    r.A.held.splice(0).forEach(release => release());            // the old post's ACK arrives late
    await r.advance(20_000);
    // Through the old adapter: only the clean-up of its own late post — no new post or edit.
    expect(r.A.calls.slice(oldCalls)).toEqual(["delete A-m1"]);
    const [ack] = (r.A.a.notifyAlert.mock.calls[0][1].choices ?? []).map((c: any) => c.id);
    expect(r.hub.handleCallback({ callbackData: ack, chatId: "111111", threadId: "900001", messageId: "A-m1", userId: "100", ack() {} }, "dcA")).toBe(true);
    expect(r.state.acked.size).toBe(0);                          // its capability did not survive
  });

  it("an adapter swapped before any recompute noticed: the old renderer's late post ACK is fenced — no pointer, no capability", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.A.setHold(true);
    r.hub.start(); await r.advance(0);
    r.worldAdapters.dcA = adapter("A2").a;                       // swapped; no recompute yet
    r.A.held.splice(0).forEach(release => release());
    await r.advance(0);
    const { existsSync, readFileSync } = await import("node:fs");
    const file = join(r.hub["ctx"].dataDir, "needs-you-message.json");
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    expect(saved.dcA).toBeUndefined();
    const [ack] = (r.A.a.notifyAlert.mock.calls[0][1].choices ?? []).map((c: any) => c.id);
    const acks: string[] = [];
    r.hub.handleCallback({ callbackData: ack, chatId: "111111", threadId: "900001", messageId: "A-m1", userId: "100", ack: n => acks.push(n ?? "") }, "dcA");
    expect(acks).toEqual(["needs.ack_stale"]);
  });

  it("a button whose post has not returned yet has no authority (no message to bind to)", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.A.setHold(true);
    r.hub.start(); await r.advance(0);
    const [ack] = (r.A.a.notifyAlert.mock.calls[0][1].choices ?? []).map((c: any) => c.id);
    const acks: string[] = [];
    r.hub.handleCallback({ callbackData: ack, chatId: "111111", threadId: "900001", messageId: "some-other-message", userId: "100", ack: n => acks.push(n ?? "") }, "dcA");
    expect(acks).toEqual(["needs.ack_stale"]);
    expect(r.state.acked.size).toBe(0);
  });

  it("a capability lapses 15 minutes after it was minted, even when the renewal that replaces it never lands", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.start(); await r.advance(0);                           // posted, bound
    r.A.setHold(true);
    await r.advance(10 * 60_000 + 1);                            // the renewal edit mints new buttons — and hangs
    const renewal = r.A.a.editAlert.mock.calls.at(-1);
    const [ack] = (renewal[2].choices ?? []).map((c: any) => c.id);
    const click = () => { const acks: string[] = []; r.hub.handleCallback({ callbackData: ack, chatId: "111111", threadId: "900001", messageId: "A-m1", userId: "100", ack: n => acks.push(n ?? "") }, "dcA"); return acks; };
    await r.advance(16 * 60_000);
    expect(click()).toEqual(["needs.ack_stale"]);
    expect(r.state.acked.size).toBe(0);
  });

  it("controls: the current message's button acknowledges, and a renewed one works", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.start(); await r.advance(0);
    await r.advance(10 * 60_000 + 1);                            // renewed (not held)
    const [ack] = (r.A.a.editAlert.mock.calls.at(-1)[2].choices ?? []).map((c: any) => c.id);
    const acks: string[] = [];
    r.hub.handleCallback({ callbackData: ack, chatId: "111111", threadId: "900001", messageId: "A-m1", userId: "100", ack: n => acks.push(n ?? "") }, "dcA");
    expect(acks).toEqual(["needs.ack_done"]);
  });
});

describe("live_message off", () => {
  it("no live message; an existing one is marked off and forgotten", async () => {
    const r = rig();
    r.state.deliveries = [delivery("d1", "alpha")];
    r.hub.start();
    await r.advance(0);
    r.state.settings.liveMessage = false;
    r.hub.recompute();
    await r.advance(0);
    expect(r.A.calls.at(-1)).toBe("edit A-m1 needs.live_off [0]");
  });
});

