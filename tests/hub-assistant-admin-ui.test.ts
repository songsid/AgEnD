import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let widget: any, words: any, clients: any, panel: any;
const pages: AppPage[] = [];
const config = () => ({ enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 });
const view = () => ({ ...config(), backends: [{ id: "claude-code", name: "Claude", accounts: [{ id: null, name: "Default", state: "signed-in" }, { id: "team", name: "Team", state: "signed-in" }] }],
  running: [{ roomId: "room-a", roomName: "Planning", state: "working", lastUsed: 1794580000000 }, { roomId: "room-b", roomName: "Design", state: "idle", lastUsed: 1794570000000 }] });
const usage = () => ({ days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${i + 10}`, count: i })), quota: { band: "near_limit" } });
beforeAll(async () => {
  const p = page(); widget = await import("/ui/js/hub-assistant-admin.js"); words = await import("/assets/app-i18n.js");
  clients = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/panel-hub.js"); p.restore();
});
afterEach(async () => {
  for (const p of pages.splice(0)) { await p.unmount(); p.restore(); }
  clients.setHubClient(null); panel.resetHubSession(); vi.restoreAllMocks();
});
async function fixture(language = "en", overrides: any = {}) {
  const p = page({ url: "http://127.0.0.1:19290/ui/hub/admin", storage: { agend_lang: language } }); pages.push(p); words.setLang(language, { store: false });
  let settings = view();
  const c = { assistantAdminV1: true, assistantSettings: vi.fn(async () => ({ ok: true, ...settings })), assistantUsage: vi.fn(async () => ({ ok: true, ...usage() })),
    saveAssistantSettings: vi.fn(async (input: any) => ({ ok: true, ...(settings = { ...settings, ...input }) })),
    stopRoomAssistant: vi.fn(async (roomId: string) => { settings = { ...settings, running: settings.running.filter(row => row.roomId !== roomId) }; return { ok: true }; }), ...overrides };
  await p.mount(h(widget.HubAssistantAdmin, { client: c })); await settle(20);
  return { p, c };
}
const button = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === label);
const change = (element: any, value: unknown, event = "input") => { expect(element).toBeTruthy(); element.value = value; fire(element, event); };
const submit = async (p: AppPage) => { fire(p.root.querySelector("form"), "submit"); await settle(20); };

describe("Hub room-assistant administration with the real shared UI", () => {
  it.each(["en", "zh-TW"])("distinguishes unavailable quota from a signed-in account (%s)", async language => {
    const { p } = await fixture(language, { assistantUsage: async () => ({ ok: true, ...usage(), quota: { band: "unknown" } }) });
    const sections = p.root.querySelectorAll("section.card");
    expect(sections[0].textContent).toContain(language === "en" ? "Signed in." : "已登入");
    expect(sections[2].textContent).toContain(language === "en" ? "Quota status not available yet" : "尚未取得額度狀態");
    expect(sections[2].textContent).not.toContain(language === "en" ? "AI account · Unknown" : "AI 帳號 · 未知");
  });

  it.each(["en", "zh-TW"])("renders shared cards, working versus idle, quota and seven daily counts (%s)", async language => {
    const { p, c } = await fixture(language), text = p.root.textContent;
    expect(p.root.querySelectorAll("section.card")).toHaveLength(3);
    expect(text).toContain(language === "en" ? "Room assistant" : "房間助理");
    expect(text).toContain(language === "en" ? "Working" : "處理中");
    expect(text).toContain(language === "en" ? "Idle" : "待命");
    expect(text).toContain(language === "en" ? "Running low" : "快用完");
    expect(text).not.toContain("hubAssistantAdmin."); expect(text).not.toContain("hubRoom.");
    for (const row of usage().days) expect(text).toContain(row.day);
    const numbers = p.root.querySelectorAll('input[type="number"]');
    expect(numbers[0].getAttribute("min")).toBe("1"); expect(numbers[0].getAttribute("max")).toBe("16");
    expect(numbers[1].getAttribute("max")).toBe("240");
    expect(c.saveAssistantSettings).not.toHaveBeenCalled(); expect(c.stopRoomAssistant).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "signed-in", "Signed in."], ["zh-TW", "signed-in", "已登入"],
    ["en", "needs-sign-in", "Sign-in needed. Sign in under AgEnD settings on this Hub computer."],
    ["zh-TW", "needs-sign-in", "需要登入。請在 Hub 這台電腦的 AgEnD 設定裡登入。"],
    ["en", "unknown", "Sign-in status unknown. Sign in under AgEnD settings on this Hub computer."],
    ["zh-TW", "unknown", "登入狀態未知。請在 Hub 這台電腦的 AgEnD 設定裡登入。"],
  ])("shows accurate account guidance for %s / %s", async (language, state, expected) => {
    const settings = view(); settings.backends[0]!.accounts[0]!.state = state;
    const { p } = await fixture(language, { assistantSettings: async () => ({ ok: true, ...settings }) });
    const notes = [...p.root.querySelectorAll("p")].map((row: any) => row.textContent);
    expect(notes).toContain(expected);
    if (state === "signed-in") {
      expect(p.root.textContent).not.toContain("Sign in under AgEnD settings");
      expect(p.root.textContent).not.toContain("請在 Hub 這台電腦");
    } else expect(notes).not.toContain(language === "en" ? "Signed in." : "已登入");
  });

  it("saves the explicitly selected account and limits, without extra backend fields", async () => {
    const { p, c } = await fixture();
    change(p.root.querySelectorAll("select")[1], "team", "change");
    change(p.root.querySelectorAll('input[type="number"]')[0], "2"); await settle(5); await submit(p);
    expect(c.saveAssistantSettings).toHaveBeenCalledExactlyOnceWith({ enabled: true, backend: "claude-code", account: "team", cap: 2, idleMinutes: 15 });
    expect(p.root.textContent).toContain("Saved");
  });

  it("keeps edits and shows an actionable error on failed save", async () => {
    const save = vi.fn(async () => ({ ok: false, code: "unavailable" })), { p } = await fixture("en", { saveAssistantSettings: save });
    change(p.root.querySelectorAll('input[type="number"]')[0], "4"); await settle(5); await submit(p);
    expect(p.root.querySelector('[role="alert"]')?.textContent).toContain("Your changes are still here");
    expect(p.root.querySelectorAll('input[type="number"]')[0].value).toBe("4");
    expect(button(p, "Save").disabled).toBe(false);
  });

  it("stops only the selected room and keeps unsaved settings through status refresh", async () => {
    const { p, c } = await fixture();
    change(p.root.querySelectorAll('input[type="number"]')[0], "5"); await settle(5);
    const stop = [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Stop"); fire(stop, "click"); await settle(20);
    expect(c.stopRoomAssistant).toHaveBeenCalledExactlyOnceWith("room-a");
    expect(p.root.textContent).not.toContain("Planning"); expect(p.root.textContent).toContain("Design");
    fire(button(p, "Refresh"), "click"); await settle(20);
    expect(p.root.querySelectorAll('input[type="number"]')[0].value).toBe("5");
    expect(c.saveAssistantSettings).not.toHaveBeenCalled();
  });

  it("keeps settings usable when only usage fails", async () => {
    const { p, c } = await fixture("en", { assistantUsage: async () => { throw new Error("usage offline"); } });
    expect(p.root.querySelector("form")).toBeTruthy();
    expect(p.root.textContent).toContain("Could not read usage");
    await submit(p); expect(c.saveAssistantSettings).toHaveBeenCalledOnce();
  });

  it("reports a successful stop separately from a failed status read", async () => {
    const { p, c } = await fixture();
    c.assistantSettings.mockRejectedValueOnce(new Error("read offline"));
    fire(button(p, "Stop"), "click"); await settle(20);
    expect(c.stopRoomAssistant).toHaveBeenCalledExactlyOnceWith("room-a");
    expect(p.root.textContent).toContain("Stopped this room assistant");
    expect(p.root.textContent).not.toContain("Could not stop");
    expect(p.root.textContent).not.toContain("Planning");
    expect(button(p, "Refresh").disabled).toBe(false);
  });

  it.each([[0, ""], [0, "17"], [1, "0"], [1, "241"], [0, "1.5"]])("does not submit invalid limit field %s=%s", async (index, value) => {
    const { p, c } = await fixture();
    change(p.root.querySelectorAll('input[type="number"]')[index], value); await settle(5);
    expect(button(p, "Save").disabled).toBe(true);
    await submit(p); expect(c.saveAssistantSettings).not.toHaveBeenCalled();
  });

  it("offers no invented backend and keeps a disabled assistant editable when no CLI qualifies", async () => {
    const { p, c } = await fixture("en", { assistantSettings: async () => ({ ok: true, ...config(), enabled: false, backends: [], running: [] }) });
    expect(p.root.textContent).toContain("Sign in an AI account");
    expect(p.root.querySelector('[role="switch"]').disabled).toBe(true);
    expect(p.root.querySelectorAll("option")).toHaveLength(0);
    expect(c.saveAssistantSettings).not.toHaveBeenCalled();
  });

  it("adds client calls using existing same-origin CSRF and encoded room IDs", async () => {
    const calls: any[] = [], c = clients.createHubWebClient({ fetchImpl: async (path: string, init: any) => {
      calls.push({ path, ...init });
      return { ok: true, status: 200, json: async () => path === "/hub/v1/session" ? { signedIn: true, csrf: "fixture-csrf" } : {}, headers: { get: () => null } };
    } });
    await c.session(); await c.assistantSettings(); await c.saveAssistantSettings(config()); await c.assistantUsage(); await c.stopRoomAssistant("room/a");
    expect(c.assistantAdminV1).toBe(true);
    expect(calls.slice(1).map(row => [row.method, row.path])).toEqual([["GET", "/hub/v1/admin/assistant"], ["PUT", "/hub/v1/admin/assistant"], ["GET", "/hub/v1/admin/assistant/usage"], ["POST", "/hub/v1/admin/assistant/rooms/room%2Fa/stop"]]);
    expect(calls[2].headers["X-AgEnD-Hub-CSRF"]).toBe("fixture-csrf");
    expect(calls.every(row => row.credentials === "same-origin")).toBe(true);
  });

  it.each([[false, true], [true, false], [true, true]])("mounts the lazy admin cards only with server feature=%s and client capability=%s", async (offered, capable) => {
    const p = page({ url: "http://127.0.0.1:19290/ui/hub/admin" }); pages.push(p); p.document.body.setAttribute("data-hub", "hub"); words.setLang("en", { store: false });
    const read = vi.fn(async () => ({ ok: true, ...view() }));
    clients.setHubClient({ roomsLive: () => true, roomCreators: async () => ({ ok: true, people: [], teams: [] }), adminRooms: async () => ({ ok: true, rooms: [] }), assistantAdminV1: capable, assistantSettings: read, assistantUsage: async () => ({ ok: true, ...usage() }),
      rooms: async () => ({ ok: true, rooms: [] }), onSignedOut: () => () => {}, session: async () => ({ ok: true, signedIn: true, admin: true, displayName: "Admin", features: offered ? ["room-assistant-v1"] : [] }),
      adminOverview: async () => ({ ok: true, fleets: [], pairings: [] }), notices: async () => ({ ok: true, notices: [] }) });
    panel.resetHubSession(); await p.mount(h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } }));
    for (let i = 0; i < 20 && (!p.root.querySelector(".hub-admin-rooms")?.textContent || offered && capable && !read.mock.calls.length); i++) await settle(5);
    await settle(10);
    expect(read.mock.calls.length > 0).toBe(offered && capable);
    expect(p.root.textContent.includes("Room assistant")).toBe(offered && capable);
    if (offered && capable) {
      expect(p.root.querySelector(".hub-admin-rooms")).toBeTruthy();
      expect(p.root.textContent.indexOf(p.root.querySelector(".hub-admin-rooms").textContent)).toBeLessThan(p.root.textContent.indexOf("Room assistant"));
      expect(p.root.textContent.indexOf("Room assistant")).toBeLessThan(p.root.textContent.indexOf(p.root.querySelector(".hub-fleet-list").textContent));
    }
  });
});
