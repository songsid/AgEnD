import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, invitations: any, i18n: any;
const pages: AppPage[] = [];
beforeAll(async () => {
  const p = page(); ui = await import("/ui/js/hub-room-owner-requests.js");
  invitations = await import("/ui/js/hub-invitations.js"); i18n = await import("/assets/app-i18n.js"); p.restore();
});
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } i18n.setLang("en", { store: false }); });
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === text);
const request = { id: "request-one", kind: "owner-request", by: { name: "Example manager" }, room: { id: "example-room", name: "Example project", people: 3 },
  owner: { id: "example-owner", name: "Example owner" }, note: "The agent for release notes" };
const shared = { key: "shared", exposureId: "00000000-0000-4000-8000-000000000042", revision: 2, name: "Release helper", intro: "Explains releases", shared: true, canAdd: true };
const unshared = { key: "unshared", exposureId: null, revision: null, name: "Scratch helper", intro: "Private draft", shared: false, canAdd: false, reason: "not-shared" };
function fixture() {
  let pending = [request], accepting = true, listener: any;
  const c = {
    ownerRequestsLive: () => true, roomAgentRequestScope: () => "scope",
    ownerAgentRequests: vi.fn(async (_scope: string, _after?: string) => ({ ok: true, requests: pending, next: null as string | null })),
    ownerAgentRequest: vi.fn(async (_scope: string, _id: string) => ({ ok: true, request, choices: [shared, unshared] })),
    acceptOwnerAgentRequest: vi.fn(async (_scope: string, _id: string, _body: unknown) => { pending = []; return { ok: true }; }),
    declineOwnerAgentRequest: vi.fn(async (_scope: string, _id: string) => { pending = []; return { ok: true }; }),
    agentRequestSettings: vi.fn(async (_scope: string, body?: { accepting: boolean }) => { if (body) accepting = body.accepting; return { ok: true, accepting }; }),
    subscribeRooms: vi.fn((callbacks: any) => { listener = callbacks; return () => {}; }),
    invitations: vi.fn(async () => ({ ok: true, invitations: [] })),
  };
  return { c, stream: () => listener, setPending: (rows: typeof pending) => { pending = rows; } };
}
async function render(lang: string, c: any) {
  const p = page(); pages.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(ui.OwnerAgentRequestsList, { client: c }));
  await vi.waitFor(() => expect(p.root.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(0));
  return p;
}

it.each(["en", "zh-TW"])("shows room-only disclosure and preselects one shared agent without sharing the disabled draft (%s)", async lang => {
  const f = fixture(); f.c.ownerAgentRequest.mockResolvedValue({ ok: true, request, choices: [unshared, shared] });
  const p = await render(lang, f.c);
  expect(p.root.textContent).toContain(lang === "en" ? "They cannot ask it one-to-one." : "他們不能一對一問它。");
  expect(p.root.querySelector("blockquote").textContent).toBe(lang === "en" ? '"' + request.note + '"' : "「" + request.note + "」");
  expect(p.root.querySelector(".hub-owner-agent-choices strong").textContent).toBe(shared.name);
  expect(p.root.querySelector(".hub-owner-agent-choices small").textContent).toBe(shared.intro);
  const radios = p.root.querySelectorAll('input[type="radio"]');
  expect(radios[0].checked).toBe(true); expect(radios[1].disabled).toBe(true);
  expect(p.root.querySelector('a[href="/ui/hub/exposures"]')).toBeTruthy();
  expect([...p.root.querySelectorAll('a[href="/ui/hub/exposures"]')].every(a => a.textContent === (lang === "en" ? "My agents" : "我的 Agent"))).toBe(true);
  expect(f.c.acceptOwnerAgentRequest).not.toHaveBeenCalled();
  fire(button(p, lang === "en" ? "Add to this room" : "加入這個房間"), "click");
  await vi.waitFor(() => expect(f.c.acceptOwnerAgentRequest).toHaveBeenCalledTimes(1));
  expect(f.c.acceptOwnerAgentRequest).toHaveBeenCalledWith("scope", request.id, { exposureId: shared.exposureId, revision: 2 });
  await vi.waitFor(() => expect(p.root.querySelector("[data-owner-request-card]")).toBeNull());
  expect(p.root.textContent).toContain(lang === "en" ? 'Agent added to "Example project".' : "已把 Agent 加入「Example project」。");
});

it("requires an explicit choice when more than one shared agent is available", async () => {
  const f = fixture();
  f.c.ownerAgentRequest.mockResolvedValue({ ok: true, request, choices: [shared, { ...shared, key: "second", exposureId: "00000000-0000-4000-8000-000000000043", name: "Docs helper" }] });
  const p = await render("en", f.c);
  expect(button(p, "Add to this room").disabled).toBe(true);
  expect(p.root.querySelector("legend").textContent).toBe("Choose an agent");
  const second = p.root.querySelectorAll('input[type="radio"]')[1]; second.checked = true; fire(second, "change");
  await vi.waitFor(() => expect(button(p, "Add to this room").disabled).toBe(false));
  fire(button(p, "Add to this room"), "click");
  await vi.waitFor(() => expect(f.c.acceptOwnerAgentRequest).toHaveBeenCalledTimes(1));
  expect(f.c.acceptOwnerAgentRequest.mock.calls[0]?.[2]).toMatchObject({ exposureId: "00000000-0000-4000-8000-000000000043" });
});

it("allows private decline with no shared choice and never makes an add call", async () => {
  const f = fixture(); f.c.ownerAgentRequest.mockResolvedValue({ ok: true, request, choices: [unshared] });
  const p = await render("en", f.c);
  expect(button(p, "Add to this room")).toBeUndefined();
  expect([...p.root.querySelectorAll('a[href="/ui/hub/exposures"]')].every(a => a.textContent === "My agents")).toBe(true);
  fire(button(p, "Decline"), "click");
  await vi.waitFor(() => expect(f.c.declineOwnerAgentRequest).toHaveBeenCalledWith("scope", request.id));
  expect(f.c.acceptOwnerAgentRequest).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(p.root.textContent).toContain("Request declined."));
});

it("retires a held next page when an invitation event reloads the owner list", async () => {
  const f = fixture(); let release!: (value: any) => void;
  f.c.ownerAgentRequests.mockResolvedValueOnce({ ok: true, requests: [request], next: "old-cursor" })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const p = await render("en", f.c);
  fire(button(p, "Load more"), "click"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.setPending([]); f.stream()["invitation.changed"]();
  await vi.waitFor(() => expect(p.root.querySelector("[data-owner-request-card]")).toBeNull());
  release({ ok: true, requests: [request], next: "stale-cursor" }); await settle();
  expect(p.root.querySelector("[data-owner-request-card]")).toBeNull(); expect(button(p, "Load more")).toBeUndefined();
});

it("keeps old readers on legacy invitations without making owner request reads", async () => {
  const f = fixture(), p = page(); pages.push(p); f.c.ownerRequestsLive = () => false;
  await p.mount(h(invitations.InvitationsList, { client: f.c }));
  await vi.waitFor(() => expect(f.c.invitations).toHaveBeenCalledTimes(1));
  expect(f.c.ownerAgentRequests).not.toHaveBeenCalled();
});

it("turns off only new requests through the owner's scoped setting", async () => {
  const f = fixture(), p = page(); pages.push(p);
  await p.mount(h(ui.OwnerAgentRequestSetting, { client: f.c, scope: "scope" }));
  const input = p.root.querySelector('input[type="checkbox"]');
  await vi.waitFor(() => expect(input.disabled).toBe(false));
  expect(input.checked).toBe(false); input.checked = true; fire(input, "change");
  await vi.waitFor(() => expect(f.c.agentRequestSettings).toHaveBeenLastCalledWith("scope", { accepting: false }));
  expect(p.root.textContent).toContain("Requests already waiting stay open.");
  expect(f.c.declineOwnerAgentRequest).not.toHaveBeenCalled();
});

it("does not send two owner actions before the first write settles", async () => {
  const f = fixture(); let release!: (value: any) => void;
  f.c.acceptOwnerAgentRequest.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const p = await render("en", f.c), add = button(p, "Add to this room");
  fire(add, "click"); fire(add, "click"); fire(button(p, "Decline"), "click");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(f.c.acceptOwnerAgentRequest).toHaveBeenCalledTimes(1); expect(f.c.declineOwnerAgentRequest).not.toHaveBeenCalled();
  f.setPending([]); release({ ok: true });
  await vi.waitFor(() => expect(p.root.querySelector("[data-owner-request-card]")).toBeNull());
});

it("retires private owner details and notices when the session scope changes", async () => {
  const f = fixture(); let scope = "scope", release!: (value: any) => void;
  f.c.roomAgentRequestScope = () => scope;
  f.c.ownerAgentRequest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const p = page(); pages.push(p); await p.mount(h(ui.OwnerAgentRequestsList, { client: f.c }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  scope = "new-scope"; f.setPending([]); await p.mount(h(ui.OwnerAgentRequestsList, { client: f.c }));
  await vi.waitFor(() => expect(f.c.ownerAgentRequests).toHaveBeenCalledWith("new-scope"));
  release({ ok: true, request: { ...request, note: "OLD_PRIVATE_HINT" }, choices: [shared] }); await settle();
  expect(p.root.querySelector("[data-owner-request-card]")).toBeNull(); expect(p.root.textContent).not.toContain("OLD_PRIVATE_HINT");
});
