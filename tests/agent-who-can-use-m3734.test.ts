/**
 * M-3734 (#4459, the user's 2X): an agent page's "Who can use", as rendered (the panel in the mini DOM, a fake fetch for the
 * server). One place for the two existing records — no third permission model:
 * - Web guests (web.guests.grants): everyone whose grant names this agent, with their level; Add / Remove / Chat | Trusted each
 *   write ONE person's whole grant with Settings → Guests' own PUT /api/settings/fleet/web { guests: { grants } }, against
 *   the grant as saved right then (read again first: an edit made meanwhile in Settings → Guests is kept). The server's
 *   confirmation still applies (a 202 says "sent for confirmation"; a refused grant says why). Before grants exist, the
 *   list is read-only and "Start from today's guests" saves everyone's current reach. Not an admin: 403, said so.
 * - Hub: whether this agent is shared, and the Hub page that chooses who may ask (the Hub's own address: only where the
 *   Hub can be reached — said so). No Hub, not paired, offline, not shared, waiting, lapsed: each said plainly.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, overview: any, overviews: any[] = [], people: any[] = [];
let sent: Array<{ method: string; path: string; body: any }> = [];
let webAnswer: { status: number; body: unknown } | null = null, guestsStatus = 200;
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (method === "PUT" && path === "/api/settings/fleet/web" && webAnswer) {
    const a = webAnswer;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  }
  if (method === "GET" && path === "/api/settings/guests") {
    if (guestsStatus !== 200) return { ok: false, status: guestsStatus, json: async () => ({ error: "forbidden" }) };
    // Each read may answer the next state (a change made elsewhere meanwhile).
    const body = overviews.length ? (overview = overviews.shift()) : overview;
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  }
  if (method === "GET" && path === "/api/settings/guests/people") return { ok: true, status: 200, json: async () => ({ people }) };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/alpha?cat=access" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; webAnswer = null; guestsStatus = 200; overviews = []; people = structuredClone(PEOPLE); });
afterEach(async () => {
  await p.unmount();
  p.document.body.removeAttribute("data-hub");
  (await import("/ui/js/hub-client.js") as any).setHubClient(null);
  (await import("/ui/js/settings-confirm.js") as any).resetConfirmations();
  (await import("/assets/app-i18n.js") as any).setLang("en");
});

const guest = (adapterId: string, userId: string, name: string, platform: string, grant: any, extra: any = {}) =>
  ({ adapterId, userId, name, platform, scope: grant ? grant.instances : [], reach: [], sessions: 0, lastSeen: null, devices: 0, narrow: null, grant, ...extra });
const OVERVIEW = {
  enabled: true, chat: true, explicit: true, instances: ["alpha", "beta", "gamma"], rooms: [{ name: "room-1", display_name: "Front desk" }], connections: [], audit: [],
  guests: [
    guest("dc", "111", "Alice", "discord", { name: "Alice", instances: ["alpha"] }, { sessions: 1, devices: 1 }),
    guest("tg", "222", "Bob", "telegram", { name: "Bob", instances: ["beta"] }),
    guest("dc", "555", "Carol", "discord", { name: "Carol", instances: ["alpha", "room-1"], level: "trusted" }),
  ],
};
const PEOPLE = [
  { adapterId: "dc", userId: "111", platform: "discord", username: "alice", name: "Alice", lastSeen: "2026-10-21T10:00:00Z", instances: ["alpha"] },
  { adapterId: "tg", userId: "222", platform: "telegram", username: "bob", name: "Bob", lastSeen: "2026-10-21T10:00:00Z", instances: ["beta"] },
  { adapterId: "dc", userId: "333", platform: "discord", username: "sam.o", name: "Sam Ortiz", lastSeen: "2026-10-21T17:00:00Z", instances: ["alpha"] },
];

async function open(name = "alpha", over: Record<string, unknown> = {}) {
  overview = { ...structuredClone(OVERVIEW), ...over };
  const { WhoCanUsePanel } = await import("/ui/js/agent-who-can-use.js");
  await p.unmount();
  await p.mount(h(WhoCanUsePanel, { name, display: over.display as string | undefined }));
  await settle(12);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(12); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const row = (account: string) => $(`.ap-who-guests .ap-who-row[data-account="${account}"]`);
  const writes = () => sent.filter((s) => s.method === "PUT" && s.path === "/api/settings/fleet/web").map((s) => s.body);
  /** Click `el`, answering the app's question (the harness passes it to globalThis.confirm) with `yes`; the question asked. */
  const answering = async (el: any, yes: boolean) => {
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return yes; };
    try { await click(el); await settle(12); } finally { (globalThis as any).confirm = () => true; }
    expect(asked.length, "a question was asked").toBe(1);
    return asked[0];
  };
  const openAdd = async () => { const d = $(".ap-who-add"); d.open = true; fire(d, "toggle"); await settle(12); };
  return { $, click, button, row, writes, answering, openAdd };
}

describe("the agent page has a Who can use category (M-3734)", () => {
  it("every kind lists it just before Permissions, with its own name, in en and zh-TW", async () => {
    const G = await import("/ui/js/agent-details-settings.js") as any;
    for (const kind of ["fleet", "native", "classic"]) expect(G.categoriesOf(kind).slice(-2)).toEqual(["access", "permissions"]);
    expect(G.CATEGORY_ICONS.access).toBe("team");
    expect(G.categoryLabel("fleet", "access")).toBe("Who can use");
    (await import("/assets/app-i18n.js") as any).setLang("zh-TW");
    expect(G.categoryLabel("fleet", "access")).toBe("誰能用");
  });
  it("its words exist in both languages, key for key", async () => {
    await import("/ui/js/agent-who-can-use-strings.js");
    const { t, setLang } = await import("/assets/app-i18n.js") as any;
    const src = (await import("node:fs")).readFileSync(new URL("../src/ui/agent-who-can-use-strings.js", import.meta.url), "utf8");
    const keys = [...src.split('"zh-TW"')[0].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(40);
    for (const lang of ["en", "zh-TW"]) { setLang(lang); for (const k of keys) expect(t(`agentWhoCanUse.${k}`), `${lang} ${k}`).not.toBe(`agentWhoCanUse.${k}`); }
    expect(src).not.toContain("管理者");
  });
});

describe("Web guests: the people whose grant names this agent (M-3734)", () => {
  it("lists only them, with their level, whether they're signed in, and the other agents they use", async () => {
    const w = await open();
    expect([...p.root.querySelectorAll(".ap-who-guests .ap-who-row")].map((r: any) => r.getAttribute("data-account"))).toEqual(["dc:111", "dc:555"]);
    const pressed = (row: any) => [...row.querySelectorAll(".seg-inline button")].map((b: any) => [b.textContent, b.getAttribute("aria-pressed")]);
    expect(pressed(w.row("dc:111"))).toEqual([["Chat", "true"], ["Trusted", "false"]]);
    expect(pressed(w.row("dc:555"))).toEqual([["Chat", "false"], ["Trusted", "true"]]);
    expect(w.row("dc:111").textContent).toContain("Signed in · 1 device(s)");
    expect(w.row("dc:555").textContent).toContain("Not signed in");
    expect(w.row("dc:555").textContent, "a ClassicBot room by its display name").toContain("Can also use: Front desk");
    expect(w.row("dc:555").querySelector(".ap-who-level-all")?.textContent, "Prism #4461 P3: the level's scope, visible").toBe("Carol's level (Chat or Trusted) applies to all 2 agents they can use, not only this one.");
    expect(w.row("dc:111").querySelector(".ap-who-level-all"), "one agent only: nothing to say").toBeNull();
    expect(w.$(".ap-who-trusted").textContent).toContain("Trusted can also watch these agents' screens");
    expect(w.$("#who-guests a.btn").getAttribute("href")).toBe("/settings/access#guests");
    expect(w.$("#who-guests a.btn").textContent).toBe("Open Settings → Guests");
    const level = w.row("dc:111").querySelector(".seg-inline");
    expect(p.root.querySelector(`#${level.getAttribute("aria-labelledby")}`).textContent, "the Chat | Trusted pair is labelled").toBe("Level");
    expect(p.root.textContent, "admins and the bot's allowed users, said once").toContain("Fleet admins can always use every agent.");
    expect(w.$(".ap-who-off")).toBeNull();
  });
  it("no one: says so; guest sign-in off: says no one can sign in until it's on", async () => {
    const w = await open("gamma", { enabled: false });
    expect(w.$("#whoNone").textContent).toBe("No guest can use this agent.");
    expect(w.$(".ap-who-off").textContent).toContain("Guest sign-in is off");
  });
  it("Add: a person seen in chat gets a new grant of this agent only (Chat); someone with a grant keeps theirs, plus this agent", async () => {
    const w = await open();
    await w.openAdd();
    const add = w.$(".ap-who-add").textContent;
    expect(add, "who is listed, and what to do for someone who isn't").toContain("Not in the list? Ask them to send any of your agents a message once, then look again.");
    expect(add, "who confirms").toContain("you can confirm it yourself on the confirm card at the top of this page");
    expect(add).toContain("an admin presses Confirm on the card in General");
    const picks = [...p.root.querySelectorAll(".ap-who-pick .ap-who-row")].map((r: any) => r.getAttribute("data-account"));
    expect(picks, "those already listed are not offered").toEqual(["tg:222", "dc:333"]);
    await w.click(w.button("Add", p.root.querySelector('.ap-who-pick [data-account="dc:333"]')));
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:333": { name: "Sam Ortiz", instances: ["alpha"] } }, if_grants: { "dc:333": null } } }]);
    sent = [];
    await w.openAdd();
    await w.click(w.button("Add", p.root.querySelector('.ap-who-pick [data-account="tg:222"]')));
    expect(w.writes()).toEqual([{ guests: { grants: { "tg:222": { name: "Bob", instances: ["beta", "alpha"] } }, if_grants: { "tg:222": { name: "Bob", instances: ["beta"] } } } }]);
  });
  it("Remove asks first; one of several agents keeps the rest (and the level); the only one ends the grant (null), and the question says so", async () => {
    const w = await open();
    expect(await w.answering(w.button("Remove", w.row("dc:555")), true)).toBe("Carol will no longer be able to use alpha.");
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:555": { name: "Carol", instances: ["room-1"], level: "trusted" } }, if_grants: { "dc:555": { name: "Carol", instances: ["alpha", "room-1"], level: "trusted" } } } }]);
    sent = [];
    expect(await w.answering(w.button("Remove", w.row("dc:111")), true)).toContain("It's the only agent they can use, so their guest access ends and they're signed out.");
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:111": null }, if_grants: { "dc:111": { name: "Alice", instances: ["alpha"] } } } }]);
    sent = [];
    await w.answering(w.button("Remove", w.row("dc:111")), false);
    expect(w.writes(), "Cancel writes nothing").toEqual([]);
  });
  it("the question names the agent as people know it: its display name, with its name beside it (zh: full-width brackets)", async () => {
    let w = await open("alpha", { display: "Example lead" });
    expect(await w.answering(w.button("Remove", w.row("dc:555")), false)).toBe("Carol will no longer be able to use Example lead (alpha).");
    (await import("/assets/app-i18n.js") as any).setLang("zh-TW");
    w = await open("alpha", { display: "Example lead" });
    expect(await w.answering(w.button("移除", w.row("dc:555")), false)).toBe("Carol 將無法再使用 Example lead（alpha）。");
  });
  it("Chat | Trusted writes the person's whole grant with the level; Chat writes none", async () => {
    const w = await open();
    await w.click(w.button("Trusted", w.row("dc:111")));
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:111": { name: "Alice", instances: ["alpha"], level: "trusted" } }, if_grants: { "dc:111": { name: "Alice", instances: ["alpha"] } } } }]);
    sent = [];
    await w.click(w.button("Chat", w.row("dc:555")));
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:555": { name: "Carol", instances: ["alpha", "room-1"] } }, if_grants: { "dc:555": { name: "Carol", instances: ["alpha", "room-1"], level: "trusted" } } } }]);
    sent = [];
    await w.click(w.button("Chat", w.row("dc:111")));
    expect(w.writes(), "already Chat: nothing to write").toEqual([]);
  });
  it("Prism #4461 P2: each write is made from the grant shown and only on condition it is still that (if_grants); a 409 says it changed, nothing saved, and the list is read again", async () => {
    const w = await open();
    const later = structuredClone(OVERVIEW);
    later.guests[0].grant.instances = ["alpha", "gamma"];                    // changed meanwhile in Settings → Guests
    overviews = [later];
    webAnswer = { status: 409, body: { error: "changed", key: "guest_grant_changed", account: "dc:111" } };
    const reads = () => sent.filter((x) => x.method === "GET" && x.path === "/api/settings/guests").length;
    const before = reads();
    await w.click(w.button("Trusted", w.row("dc:111")));
    expect(w.writes(), "no read between what was shown and the write").toEqual([{ guests: { grants: { "dc:111": { name: "Alice", instances: ["alpha"], level: "trusted" } },
      if_grants: { "dc:111": { name: "Alice", instances: ["alpha"] } } } }]);
    expect(w.$(".ap-who-msg[role=alert]").textContent).toBe("This person's access changed since this list was read, so nothing was saved. The list is up to date now: check it and try again.");
    expect(reads(), "read again after the refusal").toBe(before + 1);
    expect(w.row("dc:111").textContent).toContain("Can also use: gamma");
  });
  it("Prism #4461 P2: Remove's question is about the grant shown, and that is the condition of the write: shown [alpha, beta] → an ordinary question, written only while it is still [alpha, beta]", async () => {
    const shownTwo = structuredClone(OVERVIEW);
    shownTwo.guests[0].grant.instances = ["alpha", "beta"];
    const w = await open("alpha", shownTwo);
    expect(await w.answering(w.button("Remove", w.row("dc:111")), true)).toBe("Alice will no longer be able to use alpha.");
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:111": { name: "Alice", instances: ["beta"] } }, if_grants: { "dc:111": { name: "Alice", instances: ["alpha", "beta"] } } } }]);
  });
  it("the server's confirmation still applies: a 202 says it was sent for confirmation; a refused grant says why", async () => {
    webAnswer = { status: 202, body: { result: "pending_confirmation", pending_change: { id: "a".repeat(32), state: "pending", remaining_ms: 600_000, summary: [] } } };
    let w = await open();
    void w.click(w.button("Trusted", w.row("dc:111")));
    await settle(20);
    expect(p.root.querySelector(".ap-who-guests .ap-who-msg[role=status]")?.textContent).toContain("Sent for confirmation");
    (await import("/ui/js/settings-confirm.js") as any).resetConfirmations();
    await p.unmount();
    webAnswer = { status: 400, body: { error: "Sam has not written to any agent yet", key: "guest_grant_refused", account: "dc:333" } };
    w = await open();
    await w.openAdd();
    await w.click(w.button("Add", p.root.querySelector('.ap-who-pick [data-account="dc:333"]')));
    expect(w.$(".ap-who-guests .ap-who-msg[role=alert]").textContent).toBe("AgEnD can't give this person access: Sam has not written to any agent yet");
  });
  it("before any grant is saved (#1920's derived access): who can use it today, read-only; Start from today's guests saves everyone's reach", async () => {
    const derived = { ...structuredClone(OVERVIEW), explicit: false,
      guests: [guest("dc", "111", "Alice", "discord", null, { scope: ["alpha", "beta"] }), guest("tg", "222", "Bob", "telegram", null, { scope: ["beta"] })] };
    const w = await open("alpha", derived);
    expect([...p.root.querySelectorAll(".ap-who-guests .ap-who-row")].map((r: any) => r.getAttribute("data-account"))).toEqual(["dc:111"]);
    expect(w.button("Remove"), "read-only").toBeUndefined();
    expect(w.$(".ap-who-add"), "no Add: one grant alone would take everyone else's access away").toBeNull();
    expect(w.$(".ap-who-derived").textContent, "what the button does, before it is pressed").toContain("everyone keeps exactly the agents they can use now, nothing more. After that, a guest can use this agent only if you add them here");
    expect(await w.answering(w.$("#whoConvert"), true)).toContain("Each guest keeps exactly the agents they can use now.");
    expect(w.writes()).toEqual([{ guests: { grants: { "dc:111": { name: "Alice", instances: ["alpha", "beta"] }, "tg:222": { name: "Bob", instances: ["beta"] } }, if_grants: "unset" } }]);
  });
  it("not a fleet admin (403): says only an admin can see it; an agent guests can't be given: says so", async () => {
    guestsStatus = 403;
    let w = await open();
    expect(w.$("#who-guests").textContent).toContain("Only a fleet admin can see and change who can use this agent.");
    expect(w.writes()).toEqual([]);
    guestsStatus = 200;
    w = await open("not-an-agent");
    expect(w.$("#who-guests").textContent).toContain("Guests can't be given this agent.");
  });
});

describe("Hub: this agent's share, and the Hub page that chooses who may ask (M-3734)", () => {
  const PAIRED = { state: "paired", link: "online", binding: "b", hub: { hubId: "h", name: "Example Hub", webOrigin: "https://hub.example.test" } };
  const ID = "0f0e0d0c-0b0a-4009-8807-060504030201";
  const row = (over: any = {}) => ({ agent: "alpha", display: "alpha", exposureId: ID, revision: 3, state: "published", policy: null, enforceable: true, ...over });
  async function hub(pairing: any, rows: any[] | null, member = true) {
    if (member) p.document.body.setAttribute("data-hub", "member");
    const calls: string[] = [];
    (await import("/ui/js/hub-client.js") as any).setHubClient({
      async pairing() { calls.push("pairing"); return pairing; }, async exposures() { calls.push("exposures"); return rows; } });
    const w = await open();
    return { ...w, calls, state: () => w.$("#who-hub").getAttribute("data-hub-state"), text: () => w.$("#who-hub").textContent, link: () => w.$("#whoHubChoose") };
  }
  it("shared: the Hub's page that chooses who may ask, in a new tab — and it says that page only opens where the Hub is reachable", async () => {
    const w = await hub(PAIRED, [row()]);
    expect(w.state()).toBe("shared");
    expect(w.link().getAttribute("href")).toBe(`https://hub.example.test/ui/hub/exposures?agent=${ID}&grant=1`);
    expect(w.link().getAttribute("target")).toBe("_blank");
    expect(w.text()).toContain("“Choose who may ask on the Hub” opens the Hub's own page. That page opens only on the internal network: it won't open outside the internal network (for example, at home).");
    expect(w.text()).toContain("people or directory groups, each until a date you choose");
  });
  it("no Hub: says so and reads nothing (never the stub client's made-up answers)", async () => {
    const w = await hub(PAIRED, [row()], false);
    expect([w.state(), w.calls, w.link()]).toEqual(["none", [], null]);
    expect(w.text()).toContain("This Fleet isn't connected to a Hub.");
  });
  it.each([
    ["not paired", { state: "held", hold: "disconnected" }, [row()], "notPaired", false],
    ["not shared", PAIRED, [row({ state: "withdrawn" })], "notShared", false],
    ["no row", PAIRED, [], "notShared", false],
    ["waiting", PAIRED, [row({ pending: { expiresAt: 1 } })], "pending", false],
    ["lapsed", PAIRED, [row({ reason: "share_lapsed" })], "lapsed", true],
    ["refused", PAIRED, [row({ reason: "hub_refused" })], "refused", false],
    ["frozen", PAIRED, [row({ state: "frozen" })], "frozen", false],
  ])("%s: said plainly; the Hub link only for a share", async (_l, pairing, rows, kind, linked) => {
    const w = await hub(pairing, rows);
    expect(w.state()).toBe(kind);
    expect(!!w.link()).toBe(linked);
    expect(w.$("#who-hub a[href='/settings/hub']"), "Settings → Hub always").toBeTruthy();
  });
  it("offline: still offers the Hub page (it may open where the Hub is reachable), and says the Fleet can't reach it now", async () => {
    const w = await hub({ ...PAIRED, link: "offline" }, [row()]);
    expect(w.state()).toBe("shared");
    expect(w.text()).toContain("This Fleet can't reach its Hub right now.");
    expect(w.link()).toBeTruthy();
  });
  it("an address that isn't plain https never becomes a link", async () => {
    const w = await hub({ ...PAIRED, hub: { ...PAIRED.hub, webOrigin: "http://hub.example.test" } }, [row()]);
    expect([w.state(), w.link()]).toEqual(["shared", null]);
  });
});

describe("over the fixed link (M-3734)", () => {
  it("every route the section reads or writes is on the public link's list (the handlers still check for an admin)", async () => {
    const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
    const routes: Array<[string, string]> = [["GET", "/ui/fleet/agent/alpha"], ["GET", "/api/settings/guests"], ["GET", "/api/settings/guests/people"],
      ["PUT", "/api/settings/fleet/web"], ["GET", "/api/hub/member/pairing"], ["GET", "/api/hub/member/exposures"],
      ["GET", `/api/settings/pending/${"a".repeat(32)}`], ["POST", `/api/settings/pending/${"a".repeat(32)}/confirm`]];
    expect(routes.filter(([m, path]) => !isPublicWebRoute(m, path))).toEqual([]);
    const src = (await import("node:fs")).readFileSync(new URL("../src/ui/agent-who-can-use.js", import.meta.url), "utf8");
    const used = [...src.matchAll(/"(\/(?:api|ui)\/[^"`$]*)"/g)].map((m) => m[1]);
    expect(used.sort()).toEqual(["/api/settings/fleet/web", "/api/settings/guests"]);
  });
});
