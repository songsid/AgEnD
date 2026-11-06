import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error browser module
import { createHubChatStore } from "../src/ui/hub-chat-store.js";
const id = "d".repeat(32), room = { id: randomUUID(), exposureName: "Rep", features: ["buttons-v1"] };
const entry = { messageId: randomUUID(), sequence: 3, question: "Q", answer: "A", receipt: { stage: "answered", at: 1 }, buttons: { id, labels: ["A", "B"], state: "open" } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pending = new Map<number, () => void>(); let n = 0;
  const timers = { setTimeout: (fn: () => void) => { pending.set(++n, fn); return n; }, clearTimeout: (id: number) => pending.delete(id) };
  const client = { read: vi.fn(async (_id: string, _after: number): Promise<any> => ({ ok: true, entries: [structuredClone(entry)], room })),
    chooseButtons: vi.fn(async (_id: string, _body: unknown): Promise<any> => ({ ok: true, receipt: { stage: "queued" } })) };
  const store = createHubChatStore(room, { client, timers, doc: null });
  const tick = async () => { const [key, fn] = pending.entries().next().value!; pending.delete(key); fn(); await flush(); };
  return { store, client, tick };
}
describe("Hub chat store wires F's shared controls", () => {
  it("delegates the choice and re-reads an answered row until its controls close", async () => {
    const f = fixture(); await flush();
    expect(f.store.messages()[1].buttons).toEqual(entry.buttons);
    expect((await f.store.clickButton(id, 0)).ok).toBe(true);
    expect(f.client.chooseButtons).toHaveBeenCalledWith(room.id, { setId: id, index: 0, idempotencyKey: expect.any(String) });
    await f.tick(); expect(f.client.read.mock.calls[1]).toEqual([room.id, 2]);
    f.client.read.mockResolvedValue({ ok: true, entries: [{ ...entry, buttons: { ...entry.buttons, state: "chosen", chosen: 0 } }], room });
    await f.tick(); await f.tick();
    expect(f.client.read.mock.calls.at(-1)).toEqual([room.id, 3]);
    f.store.stop();
  });
  it.each(["queued", "poll"])("new messages after a full tail are discovered while an old %s remains open", async kind => {
    const pending = new Map<number, () => void>(); let next = 0;
    const timers = { setTimeout: (fn: () => void) => { pending.set(++next, fn); return next; }, clearTimeout: (n: number) => pending.delete(n) };
    const all = Array.from({ length: 250 }, (_, i) => ({ messageId: `m${i + 1}`, sequence: i + 1, question: "Q", answer: "A",
      receipt: { stage: i === 0 && kind === "queued" ? "queued" : "answered", at: 1 },
      ...(i === 0 && kind === "poll" ? { buttons: { ...entry.buttons, poll: { deadline: 600000, answered: 0, multi: true, reveal: "close", rev: 1 } } } : {}),
    }));
    const afters: number[] = [], client = { read: async (_room: string, after: number) => {
      afters.push(after); return { ok: true, entries: structuredClone(all.filter(e => e.sequence > after).slice(0, 100)), room };
    } };
    const store = createHubChatStore(room, { client, timers, doc: null }); await flush();
    const tick = async () => { const [n, fn] = pending.entries().next().value!; pending.delete(n); fn(); await flush(); };
    await tick(); await tick(); expect(store.entries().at(-1).sequence).toBe(250);
    all.push({ messageId: "m251", sequence: 251, question: "new", answer: "new answer", receipt: { stage: "answered", at: 2 } });
    await tick(); await tick();
    expect(store.entries().at(-1).sequence, JSON.stringify(afters)).toBe(251);
    expect(afters.slice(0, 3)).toEqual([0, 100, 200]);
    store.stop();
  });
  it("C's far reads rotate across answered open controls without marking an old full page as forward progress", async () => {
    const pending = new Map<number, () => void>(); let next = 0;
    const timers = { setTimeout: (fn: () => void) => { pending.set(++next, fn); return next; }, clearTimeout: (n: number) => pending.delete(n) };
    const all = Array.from({ length: 250 }, (_, i) => ({ messageId: `m${i + 1}`, sequence: i + 1, question: "Q", answer: "A", receipt: { stage: "answered", at: 1 },
      ...([1, 120].includes(i + 1) ? { buttons: { ...entry.buttons, id: (i === 0 ? "d" : "e").repeat(32), poll: { deadline: 600000, answered: 0, multi: true, reveal: "close", rev: 1 } } } : {}),
    }));
    const afters: number[] = [], client = { read: async (_room: string, after: number) => {
      afters.push(after); return { ok: true, entries: structuredClone(all.filter(e => e.sequence > after).slice(0, 100)), room };
    } };
    const store = createHubChatStore(room, { client, timers, doc: null }); await flush();
    const tick = async () => { const [n, fn] = pending.entries().next().value!; pending.delete(n); fn(); await flush(); };
    await tick(); await tick();
    all[119].buttons!.state = "closed";
    for (let n = 0; n < 10; n++) await tick();
    expect(afters[5]).toBe(0); expect(afters[11]).toBe(119);
    expect(afters[6]).toBeGreaterThanOrEqual(150); // the old page did not become a forward-pagination request after 250
    expect(afters[6]).toBeLessThan(250);
    expect(store.entries().find((e: any) => e.sequence === 120).buttons.state).toBe("closed");
    expect(store.entries().find((e: any) => e.sequence === 1).buttons.state).toBe("open");
    store.stop();
  });
  it("the control displaced by the unseen-row slot still gets a far refresh", async () => {
    const pending = new Map<number, () => void>(); let next = 0;
    const timers = { setTimeout: (fn: () => void) => { pending.set(++next, fn); return next; }, clearTimeout: (n: number) => pending.delete(n) };
    const all = Array.from({ length: 250 }, (_, i) => ({ messageId: `m${i + 1}`, sequence: i + 1, question: "Q", answer: "A", receipt: { stage: "answered", at: 1 },
      ...(i === 150 ? { buttons: structuredClone(entry.buttons) } : {}),
    }));
    const afters: number[] = [], client = { read: async (_room: string, after: number) => {
      afters.push(after); return { ok: true, entries: structuredClone(all.filter(e => e.sequence > after).slice(0, 100)), room };
    } };
    const store = createHubChatStore(room, { client, timers, doc: null }); await flush();
    const tick = async () => { const [n, fn] = pending.entries().next().value!; pending.delete(n); fn(); await flush(); };
    await tick(); await tick();
    all[150].buttons!.state = "chosen";
    await tick(); await tick(); await tick();
    expect(afters.slice(3)).toEqual([151, 151, 150]);
    expect(store.entries().find((e: any) => e.sequence === 151).buttons.state).toBe("chosen");
    store.stop();
  });
  it("takes current capability changes from the room poll, without replacing the action helper", async () => {
    const f = fixture(); await flush();
    f.client.read.mockResolvedValue({ ok: true, entries: [entry], room: { features: [] } }); await f.tick();
    expect((await f.store.clickButton(id, 0)).code).toBe("unsupported");
    expect(f.client.chooseButtons).not.toHaveBeenCalled(); f.store.stop();
  });
  it("a complete projection without controls clears an older open set", async () => {
    const f = fixture(); await flush();
    const { buttons: _removed, ...without } = entry;
    f.client.read.mockResolvedValue({ ok: true, entries: [without], room }); await f.tick();
    expect(f.store.messages()[1]).not.toHaveProperty("buttons");
    expect((await f.store.clickButton(id, 0)).ok).toBe(false);
    expect(f.client.chooseButtons).not.toHaveBeenCalled(); f.store.stop();
  });
  it("stop fences an in-flight choice and its late refresh", async () => {
    const f = fixture(); await flush(); let release!: (v: unknown) => void;
    f.client.chooseButtons.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = f.store.clickButton(id, 0); expect(f.store.busy(id)).toBe(true);
    f.store.stop(); release({ ok: true }); expect((await result).code).toBe("stopped");
    expect(f.client.read).toHaveBeenCalledTimes(1);
  });
});
