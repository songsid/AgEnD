import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
let ui: any, words: any;
const pages: AppPage[] = [], lead = "corp/lead", member = "corp/member";
const team = () => ({ id: "team-a", name: "Research", department: "department-a", departmentName: "Engineering", revision: 3, lead, leadName: "Riley", members: [lead, member], canManage: true, leadEligible: false,
  memberInfo: [{ id: lead, name: "Riley", login: "riley", department: "Engineering", signedIn: true, agents: [{ id: "agent-a", name: "Helper" }] }, { id: member, name: "Casey", login: "casey", department: "", signedIn: false, agents: [] }],
  impact: { grants: [{ id: "grant-a", exposureId: "agent-a", name: "Helper", expiresAt: 1800000000000 }], roomCreator: true } });
beforeAll(async () => { const p = page(); ui = await import("/ui/js/hub-teams.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const button = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((row: any) => row.textContent === label);
const change = (el: any, value: string) => { expect(el).toBeTruthy(); el.value = value; fire(el, "input"); };
async function mount(mode = "admin", language = "en", overrides: any = {}) {
  const p = page({ url: "http://127.0.0.1/ui/hub/admin?view=teams", storage: { agend_lang: language } }); pages.push(p); words.setLang(language, { store: false });
  const ended = new Set<() => void>();
  const c = { teams: vi.fn(async () => ({ ok: true, teams: [team()] })), team: vi.fn(async () => ({ ok: true, team: team() })),
    updateTeam: vi.fn(async (_id: string, body: any) => ({ ok: true, team: { ...team(), ...body, revision: 4 } })), createTeam: vi.fn(), deleteTeam: vi.fn(async () => ({ ok: true })),
    teamSuggestions: vi.fn(async () => ({ ok: true, candidates: [{ kind: "person", id: "corp/new", name: "Casey", login: "other.casey" }] })),
    onSignedOut: (fn: () => void) => { ended.add(fn); return () => ended.delete(fn); }, ...overrides };
  await p.mount(h(ui.HubTeamsPage, { client: c, mode, person: lead })); await settle(10);
  const link = p.document.querySelector('link[data-hub-teams-css="1"]'); expect(link?.getAttribute("href")).toBe("/assets/hub-teams.css");
  expect(p.root.querySelector("input")).toBeNull(); fire(link!, "load"); await settle(10);
  return { p, c, end: () => { for (const fn of ended) fn(); } };
}
const open = async (p: AppPage, language = "en") => { fire(button(p, language === "en" ? "Manage teams" : "管理團隊"), "click"); await settle(20); };
it.each(["en", "zh-TW"])("draws the same roster, retained lead warning and recorded metadata (%s)", async language => {
  const { p, c } = await mount("admin", language); await open(p, language);
  expect(p.root.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(p.root.textContent).toContain("riley"); expect(p.root.textContent).toContain("casey"); expect(p.root.textContent).toContain("Helper");
  expect(p.root.textContent).toContain(language === "en" ? "directory account is disabled" : "負責人的帳號已停用");
  expect(p.root.querySelector("tbody tr button").disabled).toBe(true);
  expect(c.teamSuggestions).not.toHaveBeenCalled(); expect(isServedAsset("hub-teams.css")).toBe(true);
});
it("lets a lead edit only the roster, searches the whole company with login disambiguation, and writes no metadata", async () => {
  const { p, c } = await mount("lead"); await open(p);
  expect(p.root.querySelector("[data-team-name]")).toBeNull(); expect(button(p, "Delete team")).toBeUndefined(); expect(button(p, "Choose a lead")).toBeUndefined();
  fire(button(p, "Add member"), "click"); await settle(10);
  const input = p.root.querySelector('input[type="search"]'); expect(input.getAttribute("placeholder")).toBe("Search everyone by name");
  change(input, "Ca"); await settle(5); fire(button(p, "Search"), "click"); await settle(10);
  expect(c.teamSuggestions).toHaveBeenCalledWith("person", "Ca", "team-a", expect.any(AbortSignal)); expect(p.root.textContent).toContain("other.casey");
  fire(button(p, "Choose"), "click"); await settle(10); fire(p.root.querySelector("form"), "submit"); await settle(20);
  expect(c.updateTeam).toHaveBeenCalledExactlyOnceWith("team-a", { members: [lead, member, "corp/new"], revision: 3 });
});
it("keeps edits and known roster after a failed write, and fences a held refresh after a successful save", async () => {
  let resolve!: (value: any) => void;
  const get = vi.fn().mockResolvedValueOnce({ ok: true, team: team() }).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const update = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce({ ok: true, team: { ...team(), name: "Saved", revision: 4 } });
  const { p } = await mount("admin", "en", { team: get, updateTeam: update }); await open(p);
  change(p.root.querySelector("[data-team-name]"), "Edited"); await settle(5); fire(p.root.querySelector("form"), "submit"); await settle(10);
  expect(p.root.querySelector("[data-team-name]").value).toBe("Edited"); expect(p.root.querySelectorAll("tbody tr")).toHaveLength(2);
  fire(button(p, "Refresh"), "click"); await settle(10); fire(p.root.querySelector("form"), "submit"); await settle(15);
  resolve({ ok: true, team: { ...team(), name: "Stale" } }); await settle(15);
  expect(p.root.querySelector("[data-team-name]").value).toBe("Saved"); expect(p.root.textContent).not.toContain("Stale");
});
it("keeps readable members and actions after a bare write response while refreshing the detailed roster", async () => {
  let finish!: (value: any) => void;
  const members = [lead, member, "corp/new"];
  const bare = { id: "team-a", name: "Research", department: "department-a", revision: 4, lead, members };
  const get = vi.fn().mockResolvedValueOnce({ ok: true, team: team() }).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const { p, c } = await mount("lead", "en", { team: get, updateTeam: vi.fn(async () => ({ ok: true, team: bare })),
    teamSuggestions: vi.fn(async () => ({ ok: true, candidates: [{ kind: "person", id: "corp/new", name: "Avery", login: "avery" }] })) });
  await open(p); fire(button(p, "Add member"), "click"); await settle(10);
  change(p.root.querySelector('input[type="search"]'), "Av"); await settle(5); fire(button(p, "Search"), "click"); await settle(10);
  fire(button(p, "Choose"), "click"); await settle(10); fire(p.root.querySelector("form"), "submit"); await settle(20);
  expect(p.root.textContent).toContain("Saved"); expect(p.root.textContent).toContain("Riley"); expect(p.root.textContent).toContain("Avery");
  expect(p.root.textContent).not.toContain("corp/");
  expect([...p.root.querySelectorAll("button")].map((row: any) => row.getAttribute("aria-label"))).toContain("Remove Casey");
  expect([...p.root.querySelectorAll("button")].find((row: any) => row.getAttribute("aria-label") === "Remove Casey").disabled).toBe(false);
  expect(c.team).toHaveBeenCalledTimes(2);
  finish({ ok: true, team: { ...team(), ...bare, memberInfo: [...team().memberInfo, { id: "corp/new", name: "Avery Updated", signedIn: true, agents: [] }] } }); await settle(20);
  expect(p.root.textContent).toContain("Avery Updated"); expect([...p.root.querySelectorAll("button")].find((row: any) => row.getAttribute("aria-label") === "Remove Casey").disabled).toBe(false);
});
it("shows affected grants and room creation before an explicit delete", async () => {
  const { p, c } = await mount(); await open(p); fire(button(p, "Delete team"), "click"); await settle(10);
  const region = p.root.querySelector('[role="region"]'); expect(region.textContent).toContain("Helper"); expect(region.textContent).toContain("May create rooms"); expect(region.textContent).toContain("already accepted into rooms stay");
  expect(c.deleteTeam).not.toHaveBeenCalled(); fire(region.querySelector(".btn-danger"), "click"); await settle(15); expect(c.deleteTeam).toHaveBeenCalledExactlyOnceWith("team-a");
});
it("shows the navigation entry only to a current lead and retires a held result on sign-out", async () => {
  const { p, c, end } = await mount();
  await p.mount(h(ui.HubMyTeamsEntry, { client: c, person: "corp/plain" })); await settle(15); expect(p.root.querySelector("a")).toBeNull();
  await p.mount(h(ui.HubMyTeamsEntry, { client: c, person: lead, active: true })); await settle(15); expect(p.root.querySelector("a")?.getAttribute("aria-current")).toBe("page");
  end(); await settle(10); expect(p.root.querySelector("a")).toBeNull();
});
it("uses the server's current-lead observation when session responses contain no person key", async () => {
  const { p, c } = await mount(); c.teams.mockResolvedValue({ ok: true, teams: [{ ...team(), isLead: true }] });
  await p.mount(h(ui.HubMyTeamsEntry, { client: c })); await settle(15);
  expect(p.root.querySelector("a")?.getAttribute("href")).toBe("/ui/hub?view=teams");
  await p.mount(h(ui.HubTeamsPage, { client: c, mode: "lead" })); await settle(15);
  expect(p.root.textContent).toContain("Research");
});
it("does not show suggestions from an old query after the user changes it", async () => {
  let resolve!: (value: any) => void;
  const { p, c } = await mount("lead", "en", { teamSuggestions: vi.fn(() => new Promise(r => { resolve = r; })) }); await open(p);
  fire(button(p, "Add member"), "click"); await settle(10); const input = p.root.querySelector('input[type="search"]'); change(input, "Ca"); await settle(5); fire(button(p, "Search"), "click"); await settle(10);
  change(input, "New"); await settle(5); resolve({ ok: true, candidates: [{ kind: "person", id: "corp/stale", name: "Stale" }] }); await settle(15);
  expect(p.root.textContent).not.toContain("Stale"); expect(c.updateTeam).not.toHaveBeenCalled();
});
it("sets the browser title for Administration Teams through the Hub panel", async () => {
  const panel = await import("/ui/js/panel-hub.js"), clients = await import("/ui/js/hub-client.js");
  const p = page({ url: "https://hub.example.test/ui/hub/admin?view=teams" }); pages.push(p); words.setLang("en", { store: false });
  p.document.title = "Previous page"; panel.resetHubSession();
  clients.setHubClient({ session: async () => ({ signedIn: true, admin: true, features: ["teams-v1"] }), teamsLive: () => true,
    teams: async () => ({ ok: true, teams: [] }), onSignedOut: () => () => {} });
  try {
    await p.mount(h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } })); await settle(20);
    expect(p.document.title).toBe("Teams · AgEnD");
  } finally { await p.unmount(); panel.resetHubSession(); clients.setHubClient(null); }
});
it.each(["en", "zh-TW"])("names the ask permission being lost when deleting a Team (%s)", async language => {
  const { p } = await mount("admin", language); await open(p, language);
  fire(button(p, language === "en" ? "Delete team" : "刪除團隊"), "click"); await settle(10);
  expect(p.root.querySelector('[role="region"]').textContent).toContain(language === "en" ? "May ask Helper · until" : "可以問 Helper · 到");
});
it.each(["en", "zh-TW"])("marks edited rosters unsaved until Save succeeds (%s)", async language => {
  const { p, c } = await mount("lead", language); await open(p, language);
  const unsaved = language === "en" ? "Unsaved changes" : "尚未儲存";
  expect(p.root.textContent).not.toContain(unsaved);
  const remove = [...p.root.querySelectorAll("button")].find((row: any) => row.getAttribute("aria-label") === `${language === "en" ? "Remove" : "移除"} Casey`);
  fire(remove, "click"); await settle(10);
  expect(p.root.querySelector(".hub-team-actions").textContent).toContain(unsaved); expect(c.updateTeam).not.toHaveBeenCalled();
  fire(p.root.querySelector("form"), "submit"); await settle(20); expect(p.root.textContent).not.toContain(unsaved);
});
it.each(["en", "zh-TW"])("distinguishes never-joined members from a pending joined-status observation (%s)", async language => {
  const value = team(); value.memberInfo.push({ id: "corp/unknown", name: "Unknown status" } as any); value.members.push("corp/unknown");
  const { p } = await mount("admin", language, { team: vi.fn(async () => ({ ok: true, team: value })) }); await open(p, language);
  const rows = [...p.root.querySelectorAll("tbody tr")];
  expect(rows.find((row: any) => row.textContent.includes("Casey")).textContent).toContain(language === "en" ? "Not yet" : "尚未加入");
  expect(rows.find((row: any) => row.textContent.includes("Unknown status")).textContent).toContain(language === "en" ? "Not checked yet" : "尚未確認");
});
