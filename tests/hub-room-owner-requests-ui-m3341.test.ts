import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let ui: any, settings: any, i18n: any;
const pages: AppPage[] = [];
beforeAll(async () => {
  const p = page();
  ui = await import("/ui/js/hub-room-owner-requests.js");
  settings = await import("/ui/js/hub-room-settings.js");
  i18n = await import("/assets/app-i18n.js");
  p.restore();
});
afterEach(async () => {
  for (const p of pages.splice(0)) { await p.unmount(); p.restore(); }
  i18n.setLang("en", { store: false }); vi.restoreAllMocks();
});
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === text);
function client(ownerName = "Example owner") {
  return {
    roomPurposeV1: true, aiAppsScope: () => "scope", roomAgentRequestScope: () => "scope",
    roomCandidates: vi.fn(async (_q: string, kind: string) => ({ ok: true, candidates: kind === "person"
      ? [{ kind: "person", id: "corp/00000000-0000-4000-8000-000000000042", name: ownerName }] : [] })),
    requestRoomAgent: vi.fn(async (_scope: string, _room: string, _body: unknown) => ({ ok: true, request: { id: "request-one" } })),
    cancelRoomAgentRequest: vi.fn(async () => ({ ok: true })), subscribeRooms: vi.fn(() => () => {}),
  };
}
async function render(lang: string, c: any, extra: Record<string, unknown> = {}) {
  const p = page(); pages.push(p); i18n.setLang(lang, { store: false });
  const closed = vi.fn(), sent = vi.fn();
  await p.mount(h(ui.OwnerAgentRequestDialog, { client: c, roomId: "example-room", roomName: "Example room", onClose: closed, onSent: sent, ...extra }));
  return { p, closed, sent };
}
async function choose(p: AppPage) {
  const input = p.root.querySelector("#hubRequestOwner");
  input.value = "Example"; fire(input, "input");
  await vi.waitFor(() => expect(p.root.querySelector(".hub-room-result")).toBeTruthy());
  fire(p.root.querySelector(".hub-room-result"), "click");
  await vi.waitFor(() => expect(p.root.querySelector("#hubOwnerAgentNote")).toBeTruthy());
}

it.each(["en", "zh-TW"])("selects only a person and sends a bounded optional hint (%s)", async lang => {
  const c = client(), { p, sent, closed } = await render(lang, c);
  await choose(p);
  const note = p.root.querySelector("#hubOwnerAgentNote");
  note.value = "  Example hint  "; fire(note, "input");
  await vi.waitFor(() => expect(p.root.textContent).toContain("16 / 100"));
  fire(p.root.querySelector("form"), "submit");
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(c.roomCandidates).toHaveBeenCalledWith("Example", "person");
  expect(c.requestRoomAgent).toHaveBeenCalledWith("scope", "example-room", {
    owner: "corp/00000000-0000-4000-8000-000000000042", note: "Example hint", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(p.root.textContent).toContain(lang === "en" ? "You will only learn about an agent" : "你才會知道是哪個 Agent");
});

it("suppresses repeated submit while the first request is pending", async () => {
  const c = client(); let release!: (value: any) => void;
  c.requestRoomAgent = vi.fn(() => new Promise(resolve => { release = resolve; })) as any;
  const { p, sent } = await render("en", c); await choose(p);
  const form = p.root.querySelector("form");
  fire(form, "submit"); fire(form, "submit");
  expect(c.requestRoomAgent).toHaveBeenCalledTimes(1);
  release({ ok: true, request: { id: "request-one" } });
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
});

it("shows one owner chip instead of a second search, and restores search when removed", async () => {
  const { p } = await render("en", client());
  expect(p.root.textContent).toContain("Ask an agent's owner");
  expect(p.root.querySelector('label[for="hubRequestOwner"]')?.textContent).toBe("Who owns it?");
  await choose(p);
  expect(p.root.querySelector("#hubRequestOwner")).toBeNull();
  expect(p.root.querySelector("#hubRequestOwnerLabel")?.textContent).toBe("Owner");
  fire(p.root.querySelector(".hub-room-tags .chip-btn"), "click");
  await vi.waitFor(() => expect(p.root.querySelector("#hubRequestOwner")).toBeTruthy());
  expect(p.root.querySelector("#hubOwnerAgentNote")).toBeNull();
});

it("keeps the hint after a refusal and reuses its operation key on an unchanged retry", async () => {
  const c = client();
  c.requestRoomAgent.mockResolvedValueOnce({ ok: false, code: "owner-not-taking-requests" } as any);
  const { p, sent } = await render("en", c); await choose(p);
  const note = p.root.querySelector("#hubOwnerAgentNote"); note.value = "Example hint"; fire(note, "input");
  await vi.waitFor(() => expect(p.root.textContent).toContain("12 / 100"));
  fire(p.root.querySelector("form"), "submit");
  await vi.waitFor(() => expect(p.root.querySelector("[role=alert]")?.textContent).toBe("Example owner isn't taking requests for agents."));
  expect(note.value).toBe("Example hint");
  fire(p.root.querySelector("form"), "submit");
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  expect(c.requestRoomAgent.mock.calls[0]?.[2]).toEqual(c.requestRoomAgent.mock.calls[1]?.[2]);
});

it("shows the reset in local time without inventing a missing timestamp", async () => {
  i18n.setLang("en", { store: false });
  const resetsAt = Date.UTC(2026, 10, 20);
  expect(ui.ownerRequestError({ code: "request-limit", resetsAt }, "Example owner")).toContain(
    new Date(resetsAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  expect(ui.ownerRequestError({ code: "request-limit" }, "Example owner")).toBe("That was not sent. Try again.");
});

it.each([false, true])("offers Ask its owner only with the composed capability and an empty search (%s)", async offered => {
  const c = client(), p = page(); pages.push(p); i18n.setLang("en", { store: false });
  await p.mount(h(settings.RoomSettings, { client: c, roomId: "example-room", assistant: false,
    detail: { room: { id: "example-room", name: "Example room", purpose: "" }, me: { id: "example-manager", role: "manager" },
      members: [{ id: "example-manager", kind: "person", name: "Example manager", role: "manager" }], invited: [],
      settings: { allMention: true, historyForNew: "since-join", ...(offered ? { ownerAgentRequests: true } : {}) },
      agentRequests: { requests: [{ id: "request-one", owner: { name: "Example owner" }, state: "pending" }], next: null } } }));
  expect(button(p, "Ask its owner")).toBeUndefined();
  expect(!!button(p, "Cancel request")).toBe(offered);
  expect(p.root.querySelector("#hubRoomAddAgents").value).toBe("");
  const input = p.root.querySelector("#hubRoomAddAgents"); input.value = "Missing"; fire(input, "input");
  await vi.waitFor(() => expect(p.root.textContent).toContain("Nothing matches."));
  expect(!!button(p, "Ask its owner")).toBe(offered);
});

it("renders waiting/terminal owner rows without exposing a supplied agent or hint", async () => {
  const c = client(), p = page(); pages.push(p); i18n.setLang("en", { store: false });
  const changed = vi.fn();
  await p.mount(h(ui.OwnerAgentRequestRows, { client: c, roomId: "example-room", onChanged: changed,
    page: { requests: [{ id: "request-one", owner: { name: "Example owner" }, state: "pending", agent: { name: "MUST_NOT_SHOW" }, note: "PRIVATE_HINT" }], next: null } }));
  expect(p.root.textContent).toContain("Asked Example owner for an agent · waiting");
  expect(p.root.textContent).not.toMatch(/MUST_NOT_SHOW|PRIVATE_HINT/);
  fire(button(p, "Cancel request"), "click");
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(c.cancelRoomAgentRequest).toHaveBeenCalledWith("scope", "example-room", "request-one");
});

it("keeps Ask its owner available below other matches, but not with a blank search", async () => {
  const c = client(), p = page(); pages.push(p); i18n.setLang("en", { store: false });
  c.roomCandidates.mockImplementation(async (_q: string, kind: string) => ({ ok: true, candidates: kind === "agent"
    ? [{ kind: "agent", id: "example-agent", name: "Release helper", mine: true } as any] : [] }));
  await p.mount(h(settings.RoomSettings, { client: c, roomId: "example-room", assistant: false,
    detail: { room: { id: "example-room", name: "Example room", purpose: "" }, me: { id: "example-manager", role: "manager" },
      members: [{ id: "example-manager", kind: "person", name: "Example manager", role: "manager" }], invited: [],
      settings: { allMention: true, historyForNew: "since-join", ownerAgentRequests: true }, agentRequests: { requests: [], next: null } } }));
  expect(button(p, "Ask its owner")).toBeUndefined();
  const input = p.root.querySelector("#hubRoomAddAgents"); input.value = "Release"; fire(input, "input");
  await vi.waitFor(() => expect(p.root.querySelector(".hub-room-result")?.textContent).toContain("Release helper"));
  expect(button(p, "Ask its owner")).toBeTruthy();
  input.value = ""; fire(input, "input");
  await vi.waitFor(() => expect(button(p, "Ask its owner")).toBeUndefined());
});
