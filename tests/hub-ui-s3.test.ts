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
  it("a Hub workspace: AgEnD Hub · its name; Ask / My exposures / Administration; no fleet list; zh-TW", async () => {
    stub();
    const pg = await app("hub", "/ui/hub/exposures", "Team Hub");
    expect(pg.root.querySelector(".hub-brand")!.textContent).toBe("AgEnD Hub · Team Hub");
    const rows = [...pg.root.querySelectorAll(".side-nav a.side-row")].map((a: any) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]);
    expect(rows).toEqual([["Ask", "/ui/hub", null], ["My exposures", "/ui/hub/exposures", "page"], ["Administration", "/ui/hub/admin", null]]);
    expect(pg.root.querySelector("#instanceList")).toBeNull();
    i18n.setLang("zh-TW", { store: false }); await settle(5);
    expect([...pg.root.querySelectorAll(".side-nav a.side-row")].map((a: any) => a.textContent)).toEqual(["提問", "我的公開 Agent", "管理"]);
  });
});

describe("Settings → Connect to a Hub", () => {
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
  it("paired: the Hub key's fingerprint, Open the Hub (its web origin), the shared agents — each private, unsharable until restricted mode exists", async () => {
    const c = stub();
    await c.connect({ address: "https://hub-transport.example.test", code: "ABCD-EFGH" }); c.control.approve({ name: "Team Hub", webOrigin: "https://hub.example.test" });
    const pg = await mountCard();
    await until(() => pg.root.querySelector(".hub-exposure"));
    expect(pg.root.querySelector(".hub-paired h4")!.textContent).toContain("Connected to Team Hub");
    expect(pg.root.querySelector(".hub-fp-label")!.textContent).toBe("Hub key fingerprint");
    expect((pg.root.querySelector(".hub-paired a.btn") as any).getAttribute("href")).toBe("https://hub.example.test");
    const boxes = [...pg.root.querySelectorAll(".hub-exposure input")] as any[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[false, true], [false, true]]);
    expect(pg.root.querySelector(".hub-exposure-why")!.textContent).toContain("restricted mode isn't available");
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

describe("the Hub's pages (placeholders over the stub)", () => {
  for (const [tab, title, empty] of [["ask", "Ask", "No agents you can ask yet"], ["exposures", "My exposures", "You don't share any agents yet"], ["admin", "Administration", "Nothing to manage yet"]] as const) {
    it(`${tab}: its title and empty state, with the preview note`, async () => {
      stub();
      const pg = await pageWith("hub", `/ui/hub`);
      await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab }, navKey: `hub:${tab}|1|en` }));
      await until(() => pg.root.querySelector(".hub-empty"));
      expect([pg.root.querySelector(".panel-head h1, .panel-head h2")?.textContent ?? pg.root.querySelector("h1")?.textContent, pg.root.querySelector(".hub-empty")!.textContent!.includes(empty), !!pg.root.querySelector(".hub-preview")])
        .toEqual([title, true, true]);
    });
  }
});
