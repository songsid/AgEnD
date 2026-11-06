import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
// @ts-expect-error browser module
import { createHubButtonActions } from "../src/ui/hub-button-actions.js";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";
const id = "a".repeat(32), roomId = "11111111-1111-4111-8111-111111111111";
function fixture(multi?: boolean) {
  const saved = new Map<string, string>(), refresh = vi.fn(async () => {}), changed = vi.fn();
  const client = { chooseButtons: vi.fn(async (_room: string, _body: unknown): Promise<any> => ({ ok: true, receipt: { stage: "queued" } })) };
  const entry = { buttons: { id, labels: ["A", "B"], state: "open", ...(multi === undefined ? {} : { poll: { multi } }) } };
  const room = { id: roomId, features: ["buttons-v1"] };
  const options = { client, entries: () => [entry], refresh, changed, newKey: vi.fn(() => randomUUID()),
    storage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); }, removeItem: (k: string) => { saved.delete(k); } } };
  return { saved, refresh, changed, client, entry, room, options, actions: createHubButtonActions(room, options) };
}
describe("Hub button chat-store actions", () => {
  it("posts a fixed intent and refreshes through the existing store path", async () => {
    const f = fixture();
    expect((await f.actions.clickButton(id, 1)).ok).toBe(true);
    expect(f.client.chooseButtons).toHaveBeenCalledWith(roomId, { setId: id, index: 1, idempotencyKey: expect.any(String) });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.actions.busy(id)).toBe(false);
  });
  it("negotiation, closed views and invalid indexes never call the API", async () => {
    const f = fixture(); f.room.features = [];
    expect((await f.actions.clickButton(id, 0)).code).toBe("unsupported");
    f.room.features = ["buttons-v1"]; f.entry.buttons.state = "chosen";
    expect((await f.actions.clickButton(id, 0)).code).toBe("expired");
    expect((await f.actions.clickButton(id, 9)).code).toBe("invalid");
    expect(f.client.chooseButtons).not.toHaveBeenCalled();
  });
  it("a busy action prevents a second POST and stop fences its late response", async () => {
    const f = fixture(); let release!: (v: any) => void;
    f.client.chooseButtons.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = f.actions.clickButton(id, 0);
    expect(f.actions.busy(id)).toBe(true);
    expect((await f.actions.clickButton(id, 1)).code).toBe("busy");
    f.actions.stop(); release({ ok: true });
    expect((await first).code).toBe("stopped");
    expect(f.client.chooseButtons).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("an unknown outcome retains its key across reload and refuses a different intent", async () => {
    const f = fixture(); f.client.chooseButtons.mockResolvedValueOnce({ ok: false, status: 0, code: "unreachable" });
    await f.actions.clickButton(id, 0);
    f.actions.stop();
    const next = createHubButtonActions(f.room, f.options);
    expect((await next.clickButton(id, 1)).code).toBe("uncertain");
    await next.clickButton(id, 0);
    expect(f.client.chooseButtons.mock.calls[1]).toEqual(f.client.chooseButtons.mock.calls[0]);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it("multiple choice toggles one complete ballot, persists mine and permits withdrawal", async () => {
    const f = fixture(true);
    await f.actions.clickButton(id, 0); await f.actions.clickButton(id, 1);
    expect(f.actions.mine(id)).toEqual([0, 1]);
    f.actions.stop();
    const next = createHubButtonActions(f.room, f.options);
    expect(next.mine(id)).toEqual([0, 1]);
    await next.clickButton(id, 0); await next.clickButton(id, 1);
    expect(next.mine(id)).toEqual([]);
    expect(f.client.chooseButtons.mock.calls.map(([, body]) => (body as any).options)).toEqual([[0], [0, 1], [1], []]);
    expect(new Set(f.client.chooseButtons.mock.calls.map(([, body]) => (body as any).idempotencyKey)).size).toBe(4);
  });
  it("a single-choice ballot always contains one option", async () => {
    const f = fixture(false);
    await f.actions.clickButton(id, 1);
    expect((f.client.chooseButtons.mock.calls[0]![1] as any).options).toEqual([1]);
    expect((await f.actions.vote(id, [0, 1])).code).toBe("invalid");
  });
  it("uses the Hub client's same-origin CSRF request path", async () => {
    const calls: any[] = [];
    const client = createHubWebClient({ fetchImpl: async (...args: any[]) => {
      calls.push(args);
      return { ok: true, status: 200, headers: new Headers(), json: async () => calls.length === 1 ? { signedIn: true, csrf: "test-csrf" } : { receipt: { stage: "queued" } } };
    } });
    await client.session();
    await client.chooseButtons(roomId, { setId: id, index: 0, idempotencyKey: "test" });
    expect(calls[1][0]).toBe(`/hub/v1/rooms/${roomId}/buttons`);
    expect(calls[1][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "X-AgEnD-Hub-CSRF": "test-csrf" } });
  });
});
