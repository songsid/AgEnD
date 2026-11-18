import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, picker: any, i18n: any;
const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); ui = await import("/ui/js/hub-room-owner-requests.js"); picker = await import("/ui/js/hub-room-new.js"); i18n = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } i18n.setLang("en", { store: false }); });
const exposure = { id: "example-agent", revision: 1, sharingEpoch: 0 };
function fixture(view: any = {}) {
  let state = { ok: true, findable: false, available: true, revision: 0, exposureRevision: 1, ...view };
  return { agentRoomDiscovery: vi.fn(async (_scope: string, _id: string, input?: any) => {
    if (input) state = { ...state, findable: input.findable, revision: state.revision + 1 }; return state;
  }) };
}
it.each(["en", "zh-TW"])("shows the explicit disclosure and saves a revision-bound owner choice (%s)", async lang => {
  const c = fixture(), p = page(); pages.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "owner-scope", exposure }));
  const input = p.root.querySelector('input[type="checkbox"]');
  await vi.waitFor(() => expect(input.disabled).toBe(false)); expect(input.checked).toBe(false);
  expect(p.root.textContent).toContain(lang === "en" ? "this lets nobody ask it one-to-one" : "不會讓任何人可以一對一問它");
  input.checked = true; fire(input, "change");
  await vi.waitFor(() => expect(c.agentRoomDiscovery).toHaveBeenLastCalledWith("owner-scope", exposure.id, { findable: true, ifRevision: 0, exposureRevision: 1 }));
  await vi.waitFor(() => expect(input.checked).toBe(true));
});
it.each([
  ["paused", "Hidden while sharing is paused.", true], ["not-shared", "Share this agent first.", false],
  ["owner-disabled", 'Off while "Don\'t let room managers ask me for agents" is on.', true],
])("shows the current disabled choice with its %s reason", async (reason, text, findable) => {
  const c = fixture({ findable, available: false, reason }), p = page(); pages.push(p);
  await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "scope", exposure }));
  await vi.waitFor(() => expect(p.root.textContent).toContain(text));
  const input = p.root.querySelector('input[type="checkbox"]'); expect(input.disabled).toBe(true); expect(input.checked).toBe(findable);
  input.checked = false; fire(input, "change"); await settle(); expect(c.agentRoomDiscovery).toHaveBeenCalledTimes(1);
});
it.each(["en", "zh-TW"])("offers the same owner action before either invitation, then shows waiting only after selection (%s)", async lang => {
  const c = { roomCandidates: vi.fn(async () => ({ ok: true, candidates: [
    { kind: "agent", id: "askable", name: "Example known helper", mine: false, owner: { name: "Example owner" }, intro: "Explains documents" },
    { kind: "agent", id: "findable", name: "Example discovered helper", mine: false, discoverable: true, owner: { name: "Example owner" }, intro: "Tracks releases" },
  ] })) }, changed = vi.fn(), p = page(); pages.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(picker.RoomPicker, { client: c, kinds: ["agent"], picked: [], onChange: changed, id: "pick", label: "Add agents" }));
  const input = p.root.querySelector("input"); input.value = "Example"; fire(input, "input");
  await vi.waitFor(() => expect(p.root.querySelectorAll('[role="option"]').length).toBe(2));
  const buttons = p.root.querySelectorAll('[role="option"]');
  for (const button of buttons) {
    expect(button.querySelector(".hub-room-agent-title").textContent).toContain("Example owner");
    expect(button.querySelector(".hub-room-agent-intro")).toBeTruthy();
    expect(button.querySelector(".hub-room-agent-action.btn")).toBeTruthy();
    expect(button.querySelectorAll("button")).toHaveLength(0);
    expect(button.querySelector(".hub-room-agent-action").textContent).toBe(lang === "en" ? "Ask Example owner" : "請 Example owner 加入");
    expect(button.getAttribute("aria-label")).toBe(lang === "en"
      ? `Ask Example owner to add ${button === buttons[0] ? "Example known helper" : "Example discovered helper"} to this room`
      : `請 Example owner 把 ${button === buttons[0] ? "Example known helper" : "Example discovered helper"} 加入這個房間`);
  }
  const waiting = lang === "en" ? "Invite · waiting for the owner" : "邀請 · 等擁有者同意";
  expect(p.root.textContent).not.toContain(waiting);
  expect(buttons[1].textContent).toContain("Tracks releases");
  fire(buttons[1], "click"); expect(changed).toHaveBeenCalledWith([expect.objectContaining({ id: "findable", mine: false })]);
  await p.mount(h(picker.RoomPicker, { client: c, kinds: ["agent"], picked: changed.mock.calls[0][0], onChange: changed, id: "pick", label: "Add agents" }));
  expect(p.root.querySelector(".hub-room-tags").textContent).toContain(waiting);
});
it("ignores a held choice from a retired owner session", async () => {
  let release!: (r: any) => void;
  const c = fixture(); c.agentRoomDiscovery.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const p = page(); pages.push(p); await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "old", exposure }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "new", exposure }));
  await vi.waitFor(() => expect(p.root.querySelector('input[type="checkbox"]').disabled).toBe(false));
  release({ ok: true, findable: true, available: true, revision: 9, exposureRevision: 1 }); await settle();
  expect(p.root.querySelector('input[type="checkbox"]').checked).toBe(false);
});

it("refreshes the disabled reason when an owner opts out before a setting write", async () => {
  const c = fixture(); c.agentRoomDiscovery.mockResolvedValueOnce({ ok: true, findable: false, available: true, revision: 0, exposureRevision: 1 })
    .mockResolvedValueOnce({ ok: false, status: 403 } as any)
    .mockResolvedValueOnce({ ok: true, findable: false, available: false, revision: 0, exposureRevision: 1, reason: "owner-disabled" } as any);
  const p = page(); pages.push(p); await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "scope", exposure }));
  const input = p.root.querySelector('input[type="checkbox"]'); await vi.waitFor(() => expect(input.disabled).toBe(false));
  input.checked = true; fire(input, "change");
  await vi.waitFor(() => expect(p.root.textContent).toContain('Off while "Don\'t let room managers ask me for agents" is on.'));
  expect(input.disabled).toBe(true); expect(input.checked).toBe(false);
});

it("retires a held retry read before a newer successful owner write", async () => {
  const c = fixture(), initial = { ok: true, findable: false, available: true, revision: 0, exposureRevision: 1 };
  let release!: (r: any) => void;
  c.agentRoomDiscovery.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ok: false, status: 409 } as any)
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce({ ...initial, findable: true, revision: 1 });
  const p = page(); pages.push(p); await p.mount(h(ui.OwnerAgentDiscoverySetting, { client: c, scope: "scope", exposure }));
  const input = p.root.querySelector('input[type="checkbox"]'); await vi.waitFor(() => expect(input.disabled).toBe(false));
  input.checked = true; fire(input, "change"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  input.checked = true; fire(input, "change"); await vi.waitFor(() => expect(input.checked).toBe(true));
  await vi.waitFor(() => expect(c.agentRoomDiscovery).toHaveBeenCalledTimes(4));
  release(initial); await settle(); expect(input.checked).toBe(true); expect(input.disabled).toBe(false);
});
