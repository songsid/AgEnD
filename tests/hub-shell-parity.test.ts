/**
 * cid-hub-shell-parity (the user: 「agend 排得很好看, agend hub 醜到不行」; the approved mockup): the Hub's sidebar is the
 * fleet dashboard's own (style guide rule 1), in a mini DOM:
 * - the brand is one line, "AgEnD Hub" — the Hub's name its tooltip, absent when the Hub has none (#3426);
 * - the dashboard's rows: Conversations, My agents, Administration (the administrator only), Notices (only where the
 *   Hub offers its security notices — and no count: the Hub exposes no read state), Search (Ctrl K: the conversation
 *   filter), New conversation (the side-new row, never a bordered pill);
 * - the conversation list under its section label, its empty state one line (no paragraph); the main page's too;
 * - the foot: Settings (this device's theme and language) and the session row ("Signed in"; its menu names the person);
 * - Notices is a page of its own (/ui/hub?view=notices).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { builtinRoles, ROLE_PERMISSIONS, MANAGEMENT_PERMISSIONS } from "../src/hub/roles/model.js";

let client: any, shell: any, router: any, i18n: any, hubPanel: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

/** A Hub workspace page signed in as `who`, its client answering the session, the rooms and the notices. */
const calls: string[] = [];
const NOTICE = { id: "n1", label: "Olivia's laptop", at: Date.UTC(2026, 10, 8, 6, 0), fleetId: "f1", generation: 1, revoked: false };
async function hub(o: { admin?: boolean; management?: string[]; features?: string[]; rooms?: unknown[]; mine?: unknown[]; name?: string | null; path?: string; lang?: string; notices?: unknown[] } = {}) {
  const session = { signedIn: true, displayName: "Alex", login: "alex", admin: !!o.admin, ...(o.management ? { management: o.management } : {}), csrf: "c".repeat(64), features: o.features ?? [] };
  calls.length = 0;
  const c = client.createHubWebClient({ fetchImpl: async (path: string, init: any = {}) => {
    const key = `${init.method || "GET"} ${path.split("?")[0]}`;
    calls.push(key);
    const json = key === "GET /hub/v1/session" ? session : key === "GET /hub/v1/rooms" ? { rooms: o.rooms ?? [] } : key === "GET /hub/v1/notices" ? { notices: o.notices ?? [] }
      : key === "GET /hub/v1/exposures" ? { mine: o.mine ?? [], askable: [] }
      : key === "GET /hub/v1/me/agent-request-settings" ? { accepting: true }
      : key.endsWith("/room-discovery") ? { findable: false, available: true, revision: 0, exposureRevision: 1 }
      : key === "GET /hub/v1/admin/overview" ? { fleets: [], pairings: [], permissions: o.management ?? (o.admin ? ["fleets.manage", "join.manage"] : []) }
      : key === "GET /hub/v1/roles" ? { view: {
        policy: { realm: "corp", generation: "fixture", revision: 1, rolesActive: true, state: "enabled", everEnabled: true, roles: builtinRoles(), assignments: [], denies: [] },
        root: { realm: "corp", objectId: "00000000-0000-4000-8000-000000000001" }, actor: { realm: "corp", objectId: "00000000-0000-4000-8000-000000000001" },
        permissions: ROLE_PERMISSIONS, management: MANAGEMENT_PERMISSIONS, rootSelfUsed: false,
      } }
      : key === "GET /hub/v1/security-notices/directory" ? { items: [], nextBefore: null } : {};
    return { ok: true, status: 200, json: async () => json, headers: { get: () => null } };
  } });
  if (o.features?.includes("quick-pairing-v1")) c.quickPairingV1 = true;
  client.setHubClient(c);
  hubPanel.resetHubSession();
  if (o.lang) i18n.setLang(o.lang, { store: false });
  const pg = page({ url: `http://127.0.0.1:19280${o.path ?? "/ui/hub"}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub");
  if (o.name !== null) pg.document.body.setAttribute("data-hub-name", o.name ?? "Team Hub");
  mounted.push(pg);
  router.startRouter(pg.window);
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelector("#sidebar .hub-side-rooms .side-new"));
  await settle(10);
  return pg;
}
const rows = (pg: AppPage) => [...pg.root.querySelectorAll(".side-nav .side-row .grow")].map((x: any) => x.textContent);

describe("the Hub's sidebar is the dashboard's (cid-hub-shell-parity)", () => {
  it("keeps room findability after the main who-may-ask setting on the access page", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const pg = await hub({ path: `/ui/hub/exposures?agent=${id}`, features: ["room-agent-discovery-v1"],
      mine: [{ id, displayName: "Example helper", state: "published", revision: 1, grants: [] }] });
    await import("/ui/js/hub-room-owner-requests.js");
    await until(() => pg.root.querySelector(".hub-room-discovery-setting"));
    const discovery = pg.root.querySelector(".hub-room-discovery-setting");
    expect(discovery).toBeTruthy();
    const cards = [...discovery.parentElement.children];
    const access = cards.find((card: any) => card.querySelector("h3")?.textContent === "Who may ask");
    expect(access).toBeTruthy(); expect(cards.indexOf(discovery)).toBeGreaterThan(cards.indexOf(access));
  });

  it("switches the loaded admin page when a query-only tab changes, and back again", async () => {
    const pg = await hub({ admin: true, path: "/ui/hub/admin", features: ["admin-dashboard-v1", "role-settings-v1"] });
    await import("/ui/js/hub-admin-overview.js");
    await until(() => pg.root.querySelector(".hub-ov"));
    expect(pg.root.querySelector(".hub-ov")).toBeTruthy();
    router.navigate("/ui/hub/admin?view=roles");
    await import("/ui/js/hub-roles.js");
    await until(() => calls.includes("GET /hub/v1/roles"));
    expect(calls).toContain("GET /hub/v1/roles");
    expect(pg.root.querySelector(".hub-ov")).toBeNull();
    const styles = pg.document.querySelector('[data-hub-roles-css="1"]'); expect(styles).toBeTruthy();
    fire(styles!, "load"); await until(() => pg.root.querySelector(".hub-roles"));
    expect(pg.root.querySelector(".hub-roles")).toBeTruthy();
    router.navigate("/ui/hub/admin?view=overview");
    await until(() => pg.root.querySelector(".hub-ov"));
    expect(pg.root.querySelector(".hub-ov")).toBeTruthy();
    expect(pg.root.querySelector(".hub-roles")).toBeNull();
  });

  it("places request opt-out after an owned agent list and hides it after the loaded empty state", async () => {
    const options = { path: "/ui/hub/exposures", features: ["rooms-v1", "room-owner-requests-v1"] };
    const empty = await hub(options);
    await import("/ui/js/hub-room-owner-requests.js");
    await until(() => empty.root.querySelector(".hub-empty")); await settle();
    expect(empty.root.querySelector(".hub-owner-request-setting")).toBeNull();
    expect(calls).not.toContain("GET /hub/v1/me/agent-request-settings");
    await empty.unmount(); mounted.splice(mounted.indexOf(empty), 1); empty.restore();
    const owner = await hub({ ...options, mine: [{ id: "example-owned-agent", displayName: "Example helper", state: "published", grants: [] }] });
    await until(() => owner.root.querySelector(".hub-owner-request-setting"));
    const layout = owner.root.querySelector(".s-section-layout"), children = [...layout.children];
    expect(children.indexOf(owner.root.querySelector(".hub-owner-request-setting"))).toBeGreaterThan(children.indexOf(owner.root.querySelector(".hub-shared")));
    expect(calls).toContain("GET /hub/v1/me/agent-request-settings");
  });

  it("keeps personal-agent administration out of a Fleet manager's page while mounting it for administrators", async () => {
    const options = { path: "/ui/hub/admin", features: ["personal-agents-v1", "role-settings-v1"] };
    const limited = await hub({ ...options, management: ["fleets.manage"] });
    await until(() => calls.includes("GET /hub/v1/admin/overview") && limited.root.querySelector("#hub-admin-fleets"));
    expect(limited.root.querySelector("#hub-admin-fleets")).toBeTruthy();
    // The page can render before LazyRoomPart resolves; flush only after its module has evaluated.
    await import("/ui/js/hub-personal-agent.js");
    await settle();
    expect(limited.root.querySelector("[data-personal-admin]")).toBeNull();
    expect(calls).not.toContain("GET /hub/v1/admin/personal-agents");
    await limited.unmount(); mounted.splice(mounted.indexOf(limited), 1); limited.restore();
    const administrator = await hub({ ...options, admin: true });
    await until(() => administrator.root.querySelector("[data-personal-admin]"));
    expect(administrator.root.querySelector("[data-personal-admin]")).toBeTruthy();
    await until(() => calls.includes("GET /hub/v1/admin/personal-agents"));
    expect(calls).toContain("GET /hub/v1/admin/personal-agents");
  });
  it("M-3190 (Argon): the brand, AgEnD Hub, with the Hub's name on a small line under it — and plain AgEnD Hub when the Hub has no name (#3426)", async () => {
    const named = await hub();
    const brand = named.root.querySelector(".side-head .brand")!;
    expect([brand.textContent, brand.className, named.root.querySelector(".side-head .side-brand-name")?.textContent]).toEqual(["AgEnD Hub", "brand", "Team Hub"]);
    await named.unmount(); mounted.splice(0); named.restore();
    const unnamed = await hub({ name: null });
    const plain = unnamed.root.querySelector(".side-head .brand")!;
    expect([plain.textContent, unnamed.root.querySelector(".side-head .side-brand-name")]).toEqual(["AgEnD Hub", null]);
  });
  it("the rows, as the dashboard draws them: Administration for the administrator only; New conversation a side-new row heading the conversation list (M-3190), never a pill", async () => {
    const person = await hub();
    expect(rows(person)).toEqual(["Chats", "My agents", "Search"]);
    const newChat = person.root.querySelector("#sidebar .hub-side-rooms .side-new")!;
    expect([person.root.querySelector("#sidebar .hub-new"), person.root.querySelector(".side-nav .side-new"), newChat.tagName, newChat.textContent.trim()]).toEqual([null, null, "BUTTON", "New chat"]);
    fire(newChat, "click"); await settle(20);
    expect([person.window.location.search, person.root.querySelector(".hub-launch-title")?.textContent]).toEqual(["?view=new", "Who do you want to talk to today?"]);
    await person.unmount(); mounted.splice(0); person.restore();
    const admin = await hub({ admin: true });
    expect(rows(admin)).toEqual(["Chats", "My agents", "Administration", "Search"]);
    expect(admin.root.querySelector(".side-nav a.side-row.active .grow")!.textContent).toBe("Chats");
  });
  it("Notices only where the Hub offers its security notices — with no count (the Hub exposes no read state); it opens their own page", async () => {
    const pg = await hub({ features: ["quick-pairing-v1"] });
    expect(rows(pg)).toEqual(["Chats", "My agents", "Notices", "Search"]);
    const notices = [...pg.root.querySelectorAll(".side-nav a.side-row")].find((a: any) => a.textContent.includes("Notices")) as any;
    expect([notices.getAttribute("href"), notices.querySelector(".nav-count")]).toEqual(["/ui/hub?view=notices", null]);
    notices.click(); await settle(20);
    expect([pg.window.location.search, pg.root.querySelector(".p-hub-notices h1")?.textContent, pg.root.querySelector(".side-nav a.side-row.active .grow")!.textContent])
      .toEqual(["?view=notices", "Notices", "Notices"]);
  });
  it("the Notices page with no notice says so in one line (the card is drawn only with a notice)", async () => {
    const pg = await hub({ features: ["quick-pairing-v1"], path: "/ui/hub?view=notices" });
    await until(() => pg.root.querySelector(".p-hub-notices .empty-title"));
    expect([pg.root.querySelector(".p-hub-notices .hub-notices-col .empty-title")?.textContent, pg.root.querySelector(".p-hub-notices .empty-hint"),
      pg.root.querySelector(".hub-security-notices")]).toEqual(["No security notices", null, null]);
  });
  it("Search and Ctrl K open the conversation filter (the Hub's own — no fleet search here); Escape closes it", async () => {
    const rooms = [{ id: "11111111-2222-4333-8444-555555555555", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 1, waiting: false, features: [] },
      { id: "21111111-2222-4333-8444-555555555555", exposureId: "e2", grantId: "g2", state: "active", exposureName: "Design guide", ownerName: "Olivia", lastAt: 2, waiting: false, features: [] }];
    // On 新對話: landing on 對話 would open the newest chat (M-3204) — this is about the list beside it.
    const pg = await hub({ rooms, path: "/ui/hub?view=new" });
    await until(() => pg.root.querySelectorAll("#sidebar .hub-side-rooms .v-inst").length === 2);
    expect([pg.root.querySelector("#sidebar .hub-side-filter"), pg.root.querySelector("#sidebar .hub-side-rooms .inst-head .count")!.textContent]).toEqual([null, "2"]);   // M-3092: the 「Agent」 group's count
    fire(pg.document as any, "keydown", { key: "k", ctrlKey: true });
    await settle(10);
    const input = pg.root.querySelector("#sidebar .hub-side-filter input") as any;
    expect(!!input).toBe(true);
    input.value = "design"; fire(input, "input"); await settle(5);
    expect([...pg.root.querySelectorAll("#sidebar .hub-side-rooms .v-inst .inst-name")].map((x: any) => x.textContent)).toEqual(["Design guide"]);
    fire(input, "keydown", { key: "Escape" }); await settle(5);
    expect([pg.root.querySelector("#sidebar .hub-side-filter"), pg.root.querySelectorAll("#sidebar .hub-side-rooms .v-inst").length]).toEqual([null, 2]);
    // Argon #9: the phone's home page draws the same roster (its filter in place, its own New chat row) — not the old list.
    expect([pg.root.querySelectorAll(".hub-home-list .hub-side-rooms .v-inst").length, !!pg.root.querySelector(".hub-home-list .hub-side-filter input"),
      !!pg.root.querySelector(".hub-home-list .side-new"), pg.root.querySelector(".hub-home-list .hub-nav")]).toEqual([2, true, true, null]);
  });
  it("no conversation yet: the chats' home is the launcher with its one compact card (M-3190); the sidebar's list doesn't repeat it (zh-TW)", async () => {
    const pg = await hub({ lang: "zh-TW" });
    await until(() => pg.root.querySelector(".hub-home-pick .hub-launch-empty"));
    // Nothing to list: the launcher takes the page (a phone too: .is-launch) — the sidebar's list doesn't say it again there (Argon #19).
    expect([pg.root.querySelector("#sidebar .side-empty"), pg.root.querySelector(".hub-home")!.className,
      pg.root.querySelector(".hub-home-pick .hub-launch-title")!.textContent, pg.root.querySelector(".hub-home-pick .hub-launch-empty strong")!.textContent])
      .toEqual([null, "hub-home is-launch", "今天想找哪位 Agent？", "還沒有人直接分享 Agent 給你"]);
    await pg.unmount(); mounted.splice(0); pg.restore();
    // Elsewhere (My agents) the sidebar's list says it, in one line.
    const other = await hub({ lang: "zh-TW", path: "/ui/hub/exposures" });
    await until(() => other.root.querySelector("#sidebar .side-empty"));
    expect(other.root.querySelector("#sidebar .side-empty")!.textContent).toBe("還沒有對話");
  });
  it("the foot: Settings (this device's theme and language) and the session row — Signed in, its menu naming the person first", async () => {
    const pg = await hub({ admin: true });
    await until(() => pg.root.querySelector(".side-foot .hub-session-row button"));
    expect([pg.root.querySelector(".side-foot .hub-prefs summary .grow")!.textContent, pg.root.querySelector(".side-foot .hub-session-row button .grow")!.textContent])
      .toEqual(["Settings", "Signed in"]);
    expect([...pg.root.querySelectorAll(".side-foot .hub-prefs select")].length).toBe(2);   // theme and language — no fleet-only field
    (pg.root.querySelector(".side-foot .hub-session-row button") as any).click(); await settle(5);
    // The person (name and sign-in name), then Sign out — the nav's own rows aren't repeated here (Argon #10).
    expect([...pg.root.querySelectorAll(".side-foot [role=menuitem]")].map((b: any) => b.textContent.trim())).toEqual(["Alex (alex)", "Sign out"]);
  });
});

describe("Argon's review of the Hub shell (cid-hub-ux-fixes)", () => {
  const qp = ["quick-pairing-v1"];
  it("#1/#5: the security notices show on the Notices page only — under its header, never pinned above Chats, My agents or Administration", async () => {
    for (const path of ["/ui/hub", "/ui/hub/exposures", "/ui/hub/admin"]) {
      const pg = await hub({ admin: true, features: qp, notices: [NOTICE], path });
      await until(() => pg.root.querySelector(".p-hub .panel-body"));
      await settle(20);
      expect(pg.root.querySelector(".hub-security-notices"), path).toBe(null);
      await pg.unmount(); mounted.splice(0); pg.restore();
    }
    const pg = await hub({ admin: true, features: qp, notices: [NOTICE], path: "/ui/hub?view=notices" });
    await until(() => pg.root.querySelector(".p-hub-notices .hub-security-notices"));
    const card = pg.root.querySelector(".hub-security-notices")!;
    expect([!!card.closest(".panel-body"), pg.root.querySelector(".p-hub-notices > header.panel-head h1")!.textContent, !!pg.root.querySelector(".p-hub-notices .hub-page-lead")])
      .toEqual([true, "Notices", true]);
  });
  it("#4: revoking a fleet from its notice asks first; No revokes nothing, Yes revokes", async () => {
    const asked: string[] = [];
    const answer = { yes: false };
    const pg = await hub({ admin: true, features: qp, notices: [NOTICE], path: "/ui/hub?view=notices" });
    // The harness answers confirmDialog through the page's confirm (tests/helpers/app-harness.ts): stand in for the person.
    const was = g.confirm; g.confirm = (m: string) => { asked.push(m); return answer.yes; };
    try {
      await until(() => pg.root.querySelector(".hub-security-notices .btn-danger"));
      (pg.root.querySelector(".hub-security-notices .btn-danger") as any).click();
      await settle(20);
      expect([asked.length, asked[0]?.includes("Olivia's laptop"), calls.filter((k) => k.startsWith("POST") && k.includes("revoke"))]).toEqual([1, true, []]);
      answer.yes = true;
      (pg.root.querySelector(".hub-security-notices .btn-danger") as any).click();
      await settle(20);
      expect(calls.filter((k) => k.startsWith("POST") && k.includes("revoke"))).toEqual(["POST /hub/v1/admin/fleets/f1/revoke"]);
    } finally { g.confirm = was; }
  });
  it("#7/#17: each page is named once — the panel header and the tab say the same name; no second title under it", async () => {
    const cases: Array<[string, string]> = [["/ui/hub", "Chats"], ["/ui/hub/exposures", "My agents"], ["/ui/hub/admin", "Administration"], ["/ui/hub?view=notices", "Notices"]];
    for (const [path, name] of cases) {
      const pg = await hub({ admin: true, features: qp, path });
      await until(() => pg.root.querySelector(".p-hub header.panel-head h1"));
      await settle(20);
      const h1 = pg.root.querySelector(".p-hub header.panel-head h1")!.textContent;
      const again = [...pg.root.querySelectorAll(".p-hub .s-page-head h2")].map((x: any) => x.textContent).filter((t) => t === h1);
      expect([h1, again, pg.document.title], path).toEqual([name, [], `${name} · AgEnD`]);
      await pg.unmount(); mounted.splice(0); pg.restore();
    }
  });
});


describe("directory notices in the current Hub shell", () => {
  it("a recipient with no group/admin role gets the Notices entry and history, without adding a stream", async () => {
    const pg = await hub({ features: ["directory-security-notices-v1"], path: "/ui/hub?view=notices" });
    expect(rows(pg)).toContain("Notices"); expect(rows(pg)).not.toContain("Administration");
    expect(pg.root.querySelector(".p-hub-notices .hub-directory-notices")).toBeTruthy();
    expect(calls.filter(path => path === "GET /hub/v1/security-notices/directory")).toHaveLength(1);
    expect(calls.some(path => path.includes("/notices/events") || path === "GET /hub/v1/notices")).toBe(false);
  });
  it("welcome startup does not read directory history", async () => {
    await hub({ features: ["directory-security-notices-v1"] });
    expect(calls.some(path => path.includes("security-notices/directory"))).toBe(false);
  });
});

it("offers role notices only on the existing Notices destination, without a false pairing-empty message",async()=>{
 const pg=await hub({admin:true,features:["role-settings-v1","quick-pairing-v1"],path:"/ui/hub?view=notices"});await settle(15);
 expect(rows(pg)).toContain("Notices");expect(calls).toContain("GET /hub/v1/roles/notices");expect(pg.root.textContent).toContain("Administrator notices");expect(pg.root.textContent).not.toContain("No security notices");
});

it.each(["en","zh-TW"])("does not label a saved personal publication as already shared (%s)",async lang=>{
 const pg=await hub({path:"/ui/hub/exposures",lang,mine:[{id:"11111111-1111-4111-8111-111111111111",kind:"personal",displayName:"Notes",state:"published",grants:[]}]});
 await until(()=>pg.root.querySelector(".hub-shared .tag"));expect(pg.root.querySelector(".hub-shared h3")?.textContent).toBe(lang==="en"?"My agents · 1":"我的 Agent · 1");
 expect(pg.root.querySelector(".hub-shared .tag")?.textContent).toBe(lang==="en"?"Saved":"已儲存");
});
it("keeps Fleet publication labels unchanged",async()=>{
 const pg=await hub({path:"/ui/hub/exposures",mine:[{id:"11111111-1111-4111-8111-111111111111",kind:"fleet",displayName:"Notes",state:"published",grants:[]}]});
 await until(()=>pg.root.querySelector(".hub-shared .tag"));expect(pg.root.querySelector(".hub-shared h3")?.textContent).toBe("Shared · 1");expect(pg.root.querySelector(".hub-shared .tag")?.textContent).toBe("Shared");
});
