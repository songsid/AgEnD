import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
let p: AppPage;
let make: (d: any) => any;
beforeAll(async () => { p = page(); make = (await import("/ui/js/chat-store.js") as any).createChatStore; });
afterAll(() => p.restore());
const confirmation = { title: "Start a new chat", message: "The context will not carry over. Files stay.", confirmLabel: "Start a new chat" };
function fixture() {
  let decide!: (yes: boolean) => void;
  const fetch = vi.fn(async () => ({ json: async () => ({ answered: true }) }));
  const confirm = vi.fn(() => new Promise<boolean>(r => { decide = r; }));
  const store = make({ fetch, confirm, setTimeout: vi.fn(), t: (k: string) => k, toast: vi.fn(), announce: vi.fn() });
  store.onPrompt({ instance: "demo", nonce: "a".repeat(32), text: "Stopped", actions: [{ id: "opt-1", label: "Start a new chat", confirmation }] });
  return { store, fetch, confirm, decide: (yes: boolean) => decide(yes), prompt: () => store.state.prompts["a".repeat(32)] };
}
it("Chat and Needs you share a confirmation, cancellation sends nothing, and only a current confirmed click submits once", async () => {
  const h = fixture();
  const pending = h.store.answerByNonce(h.prompt(), "opt-1");
  await settle();
  expect(h.confirm).toHaveBeenCalledWith({ ...confirmation, danger: true });
  expect(h.fetch).not.toHaveBeenCalled();
  await h.store.answerPrompt(h.prompt(), "opt-1");
  expect(h.confirm).toHaveBeenCalledTimes(1);
  h.decide(false); await pending;
  expect(h.prompt().busy).toBe(false); expect(h.fetch).not.toHaveBeenCalled();
  const accepted = h.store.answerPrompt(h.prompt(), "opt-1"); h.decide(true); await accepted;
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse((h.fetch.mock.calls as any)[0][1].body)).toMatchObject({ instance: "demo", action: "opt-1" });
});
it("does not submit when the card expires or is replaced while its confirmation is open", async () => {
  for (const replace of [false, true]) {
    const h = fixture(), pending = h.store.answerPrompt(h.prompt(), "opt-1");
    if (replace) h.store.state.prompts["a".repeat(32)] = { ...h.prompt() };
    else h.store.resolvePrompt({ nonce: "a".repeat(32) });
    h.decide(true); await pending;
    expect(h.fetch).not.toHaveBeenCalled();
  }
});
