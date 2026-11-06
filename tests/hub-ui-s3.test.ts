/**
 * AgEnD Hub P1, slice 3 (docs/design/hub-ui-client.md), the page — in a mini DOM:
 * - the stub client's projections: connect checks (UX only), pending with both confirmations, paired with separate
 *   member/web origins, key changed (both fingerprints, labelled), held (a code), at least 128 comparison bits, exposures
 *   against a revision (a stale tab conflicts), withdraw/disconnect saying whether the Hub confirmed;
 * - the shell: no mark — nothing new drawn or loaded; a member page — "My fleet ↔ Hub" only once paired, opening the
 *   approved web origin in a new tab (no opener); a Hub workspace — "AgEnD Hub · <name>", Ask / My exposures /
 *   Administration and no fleet list;
 * - Settings → Connect to a Hub through each state; the Hub's placeholder pages; en and zh-TW.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, shell: any, store: any, router: any, i18n: any, card: any, hubPanel: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js");
  router = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  card = await import("/ui/js/settings-hub.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

function stub() {
  const c = client.createStubClient({ now: () => 1_000_000, agents: () => [{ name: "builder", display_name: "Builder" }, { name: "notes" }] });
  client.setHubClient(c);
  return c;
}
async function pageWith(mark: string | null, path = "/ui", name?: string) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  if (mark) pg.document.body.setAttribute("data-hub", mark);
  if (name) pg.document.body.setAttribute("data-hub-name", name);
  mounted.push(pg);
  return pg;
}

describe("the stub client (projections, not wire records)", () => {
  it("connect: UX checks only — an https:// address, a code of the shape people type (no fixed length); then pending, both confirmations needed", async () => {
    const c = stub();
    expect(await c.connect({ address: "http://hub.example.test", code: "ABCD-EFGH" })).toEqual({ ok: false, error: "address" });
    expect(await c.connect({ address: "https://hub.example.test", code: "ab" })).toEqual({ ok: false, error: "code" });
    const r = await c.connect({ address: "https://hub.example.test/", code: "ABCD-EFGH-IJKL" });
    expect(r.ok).toBe(true);
    expect(r.pairing).toMatchObject({ state: "pending", memberOrigin: "https://hub.example.test", ownerConfirmed: false, adminApproved: false, fingerprint: { kind: "pairing" } });
    expect(r.pairing.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" })).toEqual({ ok: false, error: "busy" });
  });
  it("at least 128 comparison bits: 8 groups of 4 hex; the full digest stays available", () => {
    const groups = client.compareGroups("0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(groups).toBe("0123 4567 89ab cdef 0123 4567 89ab cdef");
    expect(groups.replace(/ /g, "").length * 4).toBeGreaterThanOrEqual(128);
  });
  it("paired: member and web origins separate; only a paired, https web origin is ever opened — never after a key change", async () => {
    const c = stub();
    await c.connect({ address: "https://hub-transport.example.test", code: "ABCD-EFGH" });
    expect(client.safeWebOrigin(await c.pairing())).toBeNull();
    c.control.approve({ name: "Team Hub", webOrigin: "https://hub.example.test" });
    const p = await c.pairing();
    expect([p.hub.memberOrigin, p.hub.webOrigin, p.hub.fingerprint.kind, client.safeWebOrigin(p)])
      .toEqual(["https://hub-transport.example.test", "https://hub.example.test", "hub-key", "https://hub.example.test"]);
    expect(client.safeWebOrigin({ state: "paired", hub: { webOrigin: "http://hub.example.test" } })).toBeNull();
    expect(client.safeWebOrigin({ state: "paired", hub: { webOrigin: "https://user:pw@hub.example.test" } })).toBeNull();
    c.control.keyChanged();
    const k = await c.pairing();
    expect([k.state, k.offered.kind, k.offered.digest === k.hub.fingerprint.digest, client.safeWebOrigin(k)]).toEqual(["key_changed", "hub-key", false, null]);
  });
  it("exposures: this fleet's own agents by their stable name; publishing against the shown revision (stale: conflict); not enforceable: refused; withdrawing says whether the Hub confirmed", async () => {
    const c = stub();
    const [b] = await c.exposures();
    expect(b).toMatchObject({ agent: "builder", display: "Builder", state: "withdrawn", revision: 0, enforceable: false, reason: "restricted_execution_pending" });
    expect(await c.setExposed("builder", true, 0)).toEqual({ ok: false, error: "not_paired" });
    await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); c.control.approve({});
    expect(await c.setExposed("builder", true, 0)).toEqual({ ok: false, error: "not_enforceable" });
    c.control.enforceable(["builder"]);
    expect((await c.setExposed("builder", true, 0)).ok).toBe(true);
    expect(await c.setExposed("builder", false, 0)).toEqual({ ok: false, error: "conflict" });     // a tab that showed revision 0
    expect(await c.setExposed("builder", false, 1)).toEqual({ ok: true, remote: "confirmed" });
    c.control.link("offline");
    await c.setExposed("builder", true, 2);
    expect(await c.setExposed("builder", false, 3)).toEqual({ ok: true, remote: "pending" });
    expect(await c.disconnect()).toEqual({ ok: true, remote: "pending" });
  });
});

describe("the shell", () => {
  async function app(mark: string | null, path = "/ui", name?: string) {
    const pg = await pageWith(mark, path, name);
    router.startRouter(pg.window);
    store.applyStatus({ instances: [{ name: "builder", status: "running", backend: "claude-code", tags: [] }] });
    const panels = new Map([["chat", { Component: () => h("div", { class: "stub-chat" }, "chat") }], ["hub", { Component: () => h("div", { class: "stub-hub" }, "hub") }]]);
    await pg.mount(h(shell.Shell, { panels, onNewInstance() {} }));
    await settle(10);
    return pg;
  }
  it("no mark: nothing new is drawn or loaded (no switcher, no Hub stylesheet)", async () => {
    stub();
    const pg = await app(null);
    await settle(20);
    expect([pg.root.querySelector(".hub-switch"), pg.document.querySelector('link[data-hub-css="1"]'), pg.root.querySelector(".hub-brand")]).toEqual([null, null, null]);
  });
  it("a member page: the switcher appears only once paired, and opens the Hub's own web origin in a new tab", async () => {
    const c = stub();
    const pg = await app("member");
    await settle(20);
    expect(pg.root.querySelector(".hub-switch")).toBeNull();
    await c.connect({ address: "https://hub-transport.example.test", code: "ABCD-EFGH" }); c.control.approve({ name: "Team Hub", webOrigin: "https://hub.example.test" });
    await until(() => pg.root.querySelector(".hub-switch"));
    const link = pg.root.querySelector(".hub-switch a") as any;
    expect([pg.root.querySelector(".hub-switch .is-current")!.textContent, link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])
      .toEqual(["My fleet", "Team Hub", "https://hub.example.test", "_blank", "noopener noreferrer"]);
    c.control.keyChanged();
    await until(() => !pg.root.querySelector(".hub-switch"));
    expect(pg.root.querySelector(".hub-switch")).toBeNull();
  });
  it("a Hub workspace: AgEnD Hub · its name; signed out, no conversation list and no fleet list; signed in, the chats and the menu; zh-TW", async () => {
    const fetched: string[] = [];
    const realFetch = g.fetch;
    g.fetch = async (url: string) => { fetched.push(String(url)); return { ok: true, status: 200, json: async () => ({ signedIn: false }), text: async () => "", headers: { get: () => null } }; };
    try {
    client.setHubClient(client.createHubWebClient());
    hubPanel.resetHubSession();
    const pg = await app("hub", "/ui/hub/exposures", "Team Hub");
    expect(pg.root.querySelector(".hub-brand")!.textContent).toBe("AgEnD Hub · Team Hub");
    // #3226 B: the sidebar is the Hub module's conversation list — nothing of it while signed out (the page is the sign-in).
    await settle(10);
    expect([pg.root.querySelector(".side-nav .hub-nav"), pg.root.querySelectorAll(".side-nav a.side-row").length]).toEqual([null, 0]);
    expect(pg.root.querySelector("#instanceList")).toBeNull();
    // S3b: none of the fleet's bottom tabs or rails; the session row is the Hub's own (never /auth/session).
    expect([pg.root.querySelector("nav.tabs"), pg.root.querySelector(".u-rail-body")]).toEqual([null, null]);
    await until(() => pg.root.querySelector(".hub-session"));
    expect(pg.root.querySelector(".side-foot .hub-session")).not.toBeNull();
    expect(fetched.filter((u) => !u.startsWith("/hub/v1/") && !u.startsWith("/assets/"))).toEqual([]);
    } finally { g.fetch = realFetch; }
  });
  it("signed in: the sidebar is the chats (New chat, the rooms, waiting marked) and the session's menu holds My shared agents and Administration; zh-TW", async () => {
    const realFetch = g.fetch;
    const rooms = [{ id: "11111111-2222-4333-8444-555555555555", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 1, waiting: true, features: [] }];
    g.fetch = async (url: string) => {
      const u = String(url);
      const body = u.startsWith("/hub/v1/session") ? { signedIn: true, displayName: "Alex", login: "alex", admin: false, csrf: "c".repeat(64) } : u.startsWith("/hub/v1/rooms") ? { rooms } : {};
      return { ok: true, status: 200, json: async () => body, text: async () => "", headers: { get: () => null } };
    };
    try {
      client.setHubClient(client.createHubWebClient());
      hubPanel.resetHubSession();
      const pg = await app("hub", "/ui/hub", "Team Hub");
      await until(() => pg.root.querySelector(".side-nav .hub-room-row"));
      const row = pg.root.querySelector(".side-nav .hub-room-row")!;
      expect([row.getAttribute("href"), row.querySelector(".t")!.textContent, row.querySelector(".s")!.textContent, !!row.querySelector(".pulse")])
        .toEqual(["/ui/hub?room=11111111-2222-4333-8444-555555555555", "Sales numbers", "Waiting for an answer", true]);
      expect(pg.root.querySelector(".side-nav .hub-new")!.textContent).toBe("New chat");
      await until(() => pg.root.querySelector(".side-foot .hub-session button"));
      (pg.root.querySelector(".side-foot .hub-session button") as any).click(); await settle(5);
      expect([...pg.root.querySelectorAll(".side-foot [role=menuitem]")].map((b: any) => b.textContent.trim())).toEqual(["My shared agents", "Administration", "Sign out"]);
      i18n.setLang("zh-TW", { store: false }); await settle(5);
      expect(pg.root.querySelector(".side-nav .hub-new")!.textContent).toBe("新對話");
    } finally { g.fetch = realFetch; }
  });
});

describe("Settings → Connect to a Hub", () => {
  it.each(["en", "zh-TW"])("shows actionable fixed provider guidance in %s and keeps every unavailable Share disabled", async lang => {
    i18n.setLang(lang, { store: false });
    const c = stub(); await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); c.control.approve({});
    const reasons = ["engine-unavailable", "engine-unsupported", "image-unconfigured", "image-mismatch", "credential-unconfigured", "unavailable", "provider-unavailable", "PRIVATE-KEY <script>", "__proto__"];
    c.exposures = async () => reasons.map((reason, n) => ({ agent: `agent-${n}`, display: `Agent ${n}`, exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: false, reason }));
    const pg = await mountCard(); await until(() => pg.root.querySelectorAll(".hub-exposure").length === reasons.length);
    expect(pg.root.querySelectorAll(".hub-provider-guidance").length).toBe(7);
    const text = pg.root.textContent!;
    for (const term of ["Docker", "Linux/amd64", "imageId", "SHA-256", "credentialRef", "API"]) expect(text).toContain(term);
    expect(text).toContain(lang === "en" ? "Start the local Docker engine" : "請啟動本機 Docker 引擎");
    expect(text).toContain(lang === "en" ? "Images are never pulled automatically" : "系統不會自動下載映像檔");
    expect(text).not.toContain("PRIVATE-KEY"); expect(text).not.toContain("hub.provider_");
    expect(pg.root.querySelectorAll("script").length).toBe(0);
    const boxes = [...pg.root.querySelectorAll(".hub-exposure input")] as any[];
    expect(boxes).toHaveLength(reasons.length); expect(boxes.every(box => box.disabled)).toBe(true);
  });
  async function mountCard() {
    const pg = await pageWith("member", "/settings/access");
    await pg.mount(h(card.HubConnectCard, {}));
    await settle(10);
    return pg;
  }
  const input = (pg: AppPage, id: string, value: string) => { const el = pg.root.querySelector(`#${id}`) as any; el.value = value; fire(el, "input"); };
  it("unpaired: the form, Connect only with an https:// address and a code; the preview note says nothing leaves the page", async () => {
    stub();
    const pg = await mountCard();
    expect(pg.root.querySelector(".hub-preview")!.textContent).toContain("nothing here leaves this page");
    const go = () => pg.root.querySelector(".hub-connect button[type=submit]") as any;
    expect(go().disabled).toBe(true);
    input(pg, "hubAddress", "https://hub.example.test"); input(pg, "hubCode", "ABCD-EFGH"); await settle(5);
    expect(go().disabled).toBe(false);
  });
  it("pending: the pairing fingerprint (8 groups, full on request) and both steps; each step marked as it is done", async () => {
    const c = stub();
    const pg = await mountCard();
    input(pg, "hubAddress", "https://hub.example.test"); input(pg, "hubCode", "ABCD-EFGH"); await settle(5);
    fire(pg.root.querySelector("form.hub-connect")!, "submit"); await until(() => pg.root.querySelector(".hub-pending"));
    expect(pg.root.querySelector(".hub-fp-label")!.textContent).toBe("Pairing fingerprint");
    expect(pg.root.querySelector(".hub-fp-groups")!.textContent!.split(" ").length).toBe(8);
    (pg.root.querySelector(".hub-fp button") as any).click(); await settle(5);
    expect(pg.root.querySelector(".hub-fp-full")!.textContent).toMatch(/^[0-9a-f]{64}$/);
    expect([...pg.root.querySelectorAll(".hub-steps li")].map((li: any) => li.className)).toEqual(["", ""]);
    c.control.ownerConfirmed(); await settle(5);
    expect([...pg.root.querySelectorAll(".hub-steps li")].map((li: any) => li.className)).toEqual(["is-done", ""]);
  });
  it("paired: the Hub key's fingerprint, Open the Hub (its web origin), the shared agents — each private, unsharable while the stub says so", async () => {
    const c = stub();
    await c.connect({ address: "https://hub-transport.example.test", code: "ABCD-EFGH" }); c.control.approve({ name: "Team Hub", webOrigin: "https://hub.example.test" });
    const pg = await mountCard();
    await until(() => pg.root.querySelector(".hub-exposure"));
    expect(pg.root.querySelector(".hub-paired h4")!.textContent).toContain("Connected to Team Hub");
    expect(pg.root.querySelector(".hub-fp-label")!.textContent).toBe("Hub key fingerprint");
    expect((pg.root.querySelector(".hub-paired a.btn") as any).getAttribute("href")).toBe("https://hub.example.test");
    const boxes = [...pg.root.querySelectorAll(".hub-exposure input")] as any[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[false, true], [false, true]]);
    expect(pg.root.querySelector(".hub-exposure-why")!.textContent).toBe("This agent can't be shared right now. Reload the page and try again.");
  });
  it("key changed: both keys, labelled; no Open the Hub; on hold: why, in words", async () => {
    const c = stub();
    await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); c.control.approve({});
    const pg = await mountCard();
    c.control.keyChanged(); await until(() => pg.root.querySelector(".hub-key-changed"));
    expect([...pg.root.querySelectorAll(".hub-fp-label")].map((l: any) => l.textContent)).toEqual(["Approved key", "Key the Hub presents now"]);
    expect(pg.root.querySelector(".hub-key-changed a")).toBeNull();
    c.control.hold("unsaved"); await until(() => pg.root.querySelector(".hub-held"));
    expect(pg.root.querySelector(".hub-held p")!.textContent).toBe("This fleet couldn't save its Hub settings. Nothing connects until they can be saved.");
  });
  it("zh-TW", async () => {
    stub();
    i18n.setLang("zh-TW", { store: false });
    const pg = await mountCard();
    expect(pg.root.querySelector(".s-hub-connect h3")!.textContent).toBe("連線到 Hub");
  });
});

describe("the Hub workspace's pages (S3b: the real client over /hub/v1/*)", () => {
  /** A fake Hub API: what the page asked for, and a router of answers. */
  function hubApi(routes: Record<string, (body: any, init: any) => [number, unknown]>) {
    const calls: { method: string; path: string; body: any; csrf: string | null }[] = [];
    const fetchImpl = async (path: string, init: any = {}) => {
      const method = init.method || "GET", body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body, csrf: init.headers?.["X-AgEnD-Hub-CSRF"] ?? null });
      const key = `${method} ${path.split("?")[0]}`;
      const [status, json] = routes[key] ? routes[key]!(body, init) : [404, { code: "not-found" }];
      return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: (h: string) => (h === "Retry-After" && status === 429 ? "10" : null) } };
    };
    const c = client.createHubWebClient({ fetchImpl });
    client.setHubClient(c);
    hubPanel.resetHubSession();
    return { c, calls };
  }
  const SIGNED = { signedIn: true, displayName: "Alex", login: "alex", admin: false, csrf: "c".repeat(64), hub: { name: "Team Hub" } };
  async function mountTab(tab: string) {
    const pg = await pageWith("hub", tab === "ask" ? "/ui/hub" : `/ui/hub/${tab}`, "Team Hub");
    await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab }, navKey: `hub:${tab}|1|en` }));
    await settle(10);
    return pg;
  }
  const input = (pg: AppPage, sel: string, value: string) => { const el = pg.root.querySelector(sel) as any; el.value = value; fire(el, "input"); };

  it("signed out: the sign-in form; a refusal is one generic line; signing in shows the page and keeps the CSRF token", async () => {
    let tries = 0;
    const { calls } = hubApi({
      "GET /hub/v1/session": () => [200, { signedIn: false, hub: { name: "Team Hub" } }],
      "POST /hub/v1/session": (b) => (++tries === 1 ? [403, { code: "denied" }] : [200, { ...SIGNED, login: b.login }]),
      "GET /hub/v1/exposures": () => [200, { mine: [], askable: [] }],
      "GET /hub/v1/rooms": () => [200, { rooms: [] }],
    });
    const pg = await mountTab("ask");
    await until(() => pg.root.querySelector(".hub-signin"));
    input(pg, "#hubLogin", "alex"); input(pg, "#hubPassword", "pw"); await settle(5);
    fire(pg.root.querySelector(".hub-signin form")!, "submit");
    await until(() => pg.root.querySelector(".hub-signin .err"));
    expect(pg.root.querySelector(".hub-signin .err")!.textContent).toBe("That account and password didn't work.");
    expect((pg.root.querySelector("#hubPassword") as any).value).toBe("");
    input(pg, "#hubPassword", "pw"); await settle(5);
    fire(pg.root.querySelector(".hub-signin form")!, "submit");
    await until(() => pg.root.querySelector(".hub-home"));
    expect(pg.root.querySelector(".hub-home-pick")!.textContent).toContain("No chats yet");
    expect(calls.filter((x) => x.method === "POST").map((x) => x.body)).toEqual([{ login: "alex", password: "pw" }, { login: "alex", password: "pw" }]);
  });

  it("Ask: New chat lists what is granted, Ask opens the room — the question is sent with a fresh idempotency key and the CSRF token; its stage shows; one read per poll", async () => {
    const e = { id: "e1", displayName: "Sales numbers", revision: 1 };
    const R1 = "11111111-2222-4333-8444-555555555555";
    let opened = false;
    const room = { id: R1, exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", exposureState: "published", grantExpiresAt: 2_000_000_000_000, lastAt: 1, waiting: false, features: [] };
    const { calls } = hubApi({
      "GET /hub/v1/session": () => [200, SIGNED],
      "GET /hub/v1/exposures": () => [200, { mine: [], askable: [{ exposure: e, grant: { id: "g1", expiresAt: 2_000_000_000_000 }, ownerName: "Olivia" }] }],
      "GET /hub/v1/rooms": () => [200, { rooms: opened ? [room] : [] }],
      "POST /hub/v1/rooms": () => { opened = true; return [200, { room: { id: R1, exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers" } }]; },
      [`POST /hub/v1/rooms/${R1}/messages`]: (b) => [200, { receipt: { messageId: "m1", contentDigest: "d", stage: "queued", sequence: 0, at: 1 }, echo: b }],
      [`GET /hub/v1/rooms/${R1}/messages`]: () => [200, { entries: [], room }],
    });
    const pg = await pageWith("hub", "/ui/hub", "Team Hub");
    router.startRouter(pg.window);
    await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "ask" }, navKey: "hub:ask|1|en" }));
    await until(() => pg.root.querySelector(".hub-home .hub-new"));
    (pg.root.querySelector(".hub-home .hub-new") as any).click();
    await until(() => pg.root.querySelector(".hub-pick-row"));
    expect(pg.root.querySelector(".hub-pick-row .s")!.textContent).toContain("Answers for Olivia");
    (pg.root.querySelector(".hub-pick-row button") as any).click();
    await until(() => pg.root.querySelector(".hub-chat-main"));
    expect(pg.window.location.search).toBe(`?room=${R1}`);
    expect(pg.root.querySelector(".hub-chat-title strong")!.textContent).toBe("Sales numbers");
    // #3145: every asker shares the representative agent's one conversation — said before anyone types; and who asks.
    await until(() => pg.root.querySelector(".hub-room-empty"));
    expect(pg.root.querySelector(".hub-room-empty")!.textContent).toContain("shares its one conversation");
    expect(pg.root.querySelector(".hub-identity")!.textContent).toContain("not any authority");
    const box = pg.root.querySelector("#msgIn") as any; box.value = "Q3?"; fire(box, "input"); await settle(5);
    (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => pg.root.querySelector(".msg.user .tick"));
    expect(pg.root.querySelector(".msg.user .body")!.textContent).toContain("Q3?");
    expect(pg.root.querySelector(".msg.user .tick")!.getAttribute("aria-label")).toBe("Waiting for the owner's fleet");
    const ask = calls.find((x) => x.method === "POST" && x.path === `/hub/v1/rooms/${R1}/messages`)!;
    expect(ask.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(ask.body.text).toBe("Q3?");
    expect(ask.csrf).toBe("c".repeat(64));
    // A read is never faster than the pacing (one at mount; the next only after POLL_MS).
    expect(calls.filter((x) => x.path.startsWith(`/hub/v1/rooms/${R1}/messages`) && x.method === "GET")).toHaveLength(1);
    expect(hubPanel.POLL_MS).toBe(10_000);
  });

  it("My shared agents (#3226 C): the agents and a pairing to confirm; Administration only for the administrator", async () => {
    const mine = [{ id: "e1", displayName: "Sales numbers", revision: 3, state: "published", dataViewId: "agent", allowedTools: [],
      grants: [{ id: "g1", revision: 1, subjectName: "Alex", subjectLogin: "alex", expiresAt: 2_000_000_000_000 }] }];
    const { calls } = hubApi({
      "GET /hub/v1/session": () => [200, SIGNED],
      "GET /hub/v1/exposures": () => [200, { mine, askable: [] }],
      "GET /hub/v1/pairings": () => [200, { pairings: [{ id: "p1", fingerprint: "a".repeat(64), expiresAt: 2_000_000_000_000, ownerConfirmed: false, adminApproved: false }] }],
    });
    const pg = await mountTab("exposures");
    await until(() => pg.root.querySelector(".hub-shared .hub-row-link"));
    const row = pg.root.querySelector(".hub-shared .hub-row-link")!;
    expect([row.getAttribute("href"), row.querySelector("strong")!.textContent, row.querySelector(".note")!.textContent, row.querySelector(".tag")!.textContent])
      .toEqual(["/ui/hub/exposures?agent=e1", "Sales numbers", "1 may ask", "Shared"]);
    expect(pg.root.querySelector(".hub-pairings .hub-fp-groups")!.textContent!.split(" ")).toHaveLength(8);
    await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "admin" }, navKey: "hub:admin|1|en" }));
    await until(() => pg.root.querySelector(".hub-empty"));
    expect(pg.root.querySelector(".hub-empty")!.textContent).toContain("Only the Hub administrator");
    expect(calls.some((x) => x.path.startsWith("/hub/v1/admin/"))).toBe(false);
  });

  it("an agent's page (#3226 C): who may ask, Allow against the revision shown (a conflict reloads), who asked lately", async () => {
    const mine = [{ id: "aaaaaaaa-1111-4222-8333-444444444444", displayName: "Sales numbers", revision: 3, state: "published", dataViewId: "agent", allowedTools: [],
      grants: [{ id: "g1", revision: 1, subjectName: "Alex", subjectLogin: "alex", expiresAt: 2_000_000_000_000 }] }];
    const { calls } = hubApi({
      "GET /hub/v1/session": () => [200, SIGNED],
      "GET /hub/v1/exposures": () => [200, { mine, askable: [] }],
      "GET /hub/v1/pairings": () => [200, { pairings: [] }],
      "GET /hub/v1/exposures/aaaaaaaa-1111-4222-8333-444444444444/activity": () => [200, { activity: [{ askerName: "Alex", askedAt: 1_700_000_000_000, stage: "answered" }] }],
      "POST /hub/v1/grants": () => [409, { code: "conflict" }],
    });
    const ag = await pageWith("hub", "/ui/hub/exposures?agent=aaaaaaaa-1111-4222-8333-444444444444", "Team Hub");
    await ag.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "exposures" }, navKey: "hub:exposures|2|en" }));
    await until(() => ag.root.querySelector(".hub-owner .hub-card-head button"));
    expect(ag.root.querySelector(".s-page-head h2")!.textContent).toBe("Sales numbers");
    expect(ag.root.querySelector(".hub-row strong")!.textContent).toBe("Alex");
    await until(() => [...ag.root.querySelectorAll(".hub-row strong")].length >= 2);
    const recent = [...ag.root.querySelectorAll(".card")].find((c: any) => c.querySelector("h3")?.textContent === "Recent questions")!;
    expect([recent.querySelector(".hub-row strong")!.textContent, recent.querySelector(".tag")!.textContent]).toEqual(["Alex", "Answered"]);
    (ag.root.querySelector(".hub-owner .hub-card-head button") as any).click(); await settle(5);
    input(ag, ".hub-grant input", "bea"); await settle(5);
    fire(ag.root.querySelector(".hub-grant")!, "submit");
    await until(() => ag.root.querySelector(".hub-owner .err"));
    expect(calls.find((x) => x.method === "POST")!.body).toEqual({ exposureId: "aaaaaaaa-1111-4222-8333-444444444444", exposureRevision: 3, login: "bea", days: 7 });
    expect(ag.root.querySelector(".hub-owner .err")!.textContent).toContain("reloaded");
    expect(calls.filter((x) => x.path === "/hub/v1/exposures").length).toBe(2);      // the conflict reloaded the list
  });

  it("the sidebar's session row is the Hub's (never /auth/session), and a 401 anywhere signs the page out", async () => {
    let signedIn = true, ended = false;
    const { calls } = hubApi({
      "GET /hub/v1/session": () => [200, signedIn ? SIGNED : { signedIn: false }],
      "GET /hub/v1/exposures": () => [401, { code: "signed-out" }],
      // #3226 B: signing in reads the conversation list; it answers 401 only once the session has ended on the server.
      "GET /hub/v1/rooms": () => (ended ? [401, { code: "signed-out" }] : [200, { rooms: [] }]),
    });
    const pg = await pageWith("hub", "/ui/hub", "Team Hub");
    await pg.mount(h(hubPanel.HubSessionMenu, {}));
    await until(() => pg.root.querySelector(".hub-session .dot.ok"));
    expect(pg.root.querySelector(".hub-session")!.textContent).toContain("Alex");
    ended = true;
    await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "exposures" }, navKey: "hub:exposures|1|en" }));
    await until(() => pg.root.querySelector(".hub-signin"));
    expect(calls.every((x) => x.path.startsWith("/hub/v1/"))).toBe(true);
    signedIn = false;
  });
});

describe("Settings → Connect to a Hub: a conflict reloads the list (Fable on #3098)", () => {
  it("a stale tab's Share gets conflict: the message says so and the list is read again", async () => {
    const c = stub();
    await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); c.control.approve({}); c.control.enforceable(["builder"]);
    let reads = 0;
    const exposures = c.exposures.bind(c);
    c.exposures = async () => { reads++; return exposures(); };
    const setExposed = c.setExposed.bind(c);
    c.setExposed = async (agent: string, on: boolean) => setExposed(agent, on, 99);          // the page showed an old revision
    const pg = await pageWith("member", "/settings/access");
    await pg.mount(h(card.HubConnectCard, {}));
    await until(() => pg.root.querySelector(".hub-exposure input"));
    const before = reads;
    const box = pg.root.querySelector(".hub-exposure input") as any;
    box.checked = true; fire(box, "change");
    // P1 representative agent: switching on shares the agent itself at once (no picker; the owner confirms after).
    await until(() => pg.root.querySelector(".hub-exposures .err"));
    expect(pg.root.querySelector(".hub-exposures .err")!.textContent).toBe("This list changed in another tab. It has been reloaded; try again.");
    expect(reads).toBe(before + 1);
  });
});
