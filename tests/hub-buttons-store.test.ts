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
