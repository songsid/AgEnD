/** Pairing hands off the member address; sharing continues to the exact Hub-owned grant form. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const ID = "aaaaaaaa-1111-4222-8333-444444444444";
let client: any, panel: any, card: any, router: any, i18n: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown) => { for (let n = 0; n < 150 && !fn(); n++) await settle(5); };
beforeAll(async () => {
  const pg = page();
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  client = await import("/ui/js/hub-client.js");
  panel = await import("/ui/js/panel-hub.js");
  card = await import("/ui/js/settings-hub.js");
  router = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  pg.restore();
});
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } client.setHubClient(null); panel.resetHubSession(); i18n.setLang("en", { store: false }); });
const input = (pg: AppPage, selector: string, value: string) => { const el = pg.root.querySelector(selector) as any; el.value = value; fire(el, "input"); };
async function mount(path: string, Component: any, props: any = {}) {
  const pg = page({ url: `https://hub.example.test${path}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg); router.startRouter(pg.window);
  await pg.mount(h(Component, props)); await settle(10); return pg;
}
function api({ mine = [exposure()], askable = [] as any[], signedIn = true, memberOrigin = "https://members.example.test:9443" as string | undefined,
  grantFailure = null as { code: string; status: number } | null } = {}) {
  const calls: { path: string; method: string; body: any; csrf: any }[] = [];
  const signed = { signedIn: true, displayName: "Owner", login: "owner", admin: true, csrf: "c".repeat(64) };
  client.setHubClient(client.createHubWebClient({ fetchImpl: async (path: string, init: any = {}) => {
    const method = init.method || "GET", body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body, csrf: init.headers?.["X-AgEnD-Hub-CSRF"] });
    let json: any = {};
    if (path === "/hub/v1/session") { if (method === "POST") signedIn = true; json = signedIn ? signed : { signedIn: false }; }
    else if (path === "/hub/v1/exposures") json = { mine, askable };
    else if (path === "/hub/v1/admin/overview") json = { fleets: [], pairings: [] };
    else if (path === "/hub/v1/admin/pairings") json = { code: "abcd1234abcd", expiresAt: 2_000_000_000_000, ...(memberOrigin ? { memberOrigin } : {}) };
    else if (path === "/hub/v1/rooms") json = { rooms: [] };
    else if (path === "/hub/v1/pairings") json = { pairings: [] };
    else if (path.endsWith("/activity")) json = { activity: [] };
    else if (path === "/hub/v1/grants" && grantFailure) return { ok: false, status: grantFailure.status, json: async () => ({ code: grantFailure.code }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => json, headers: { get: () => null } };
  } }));
  panel.resetHubSession(); return calls;
}
function exposure(state = "published") { return { id: ID, displayName: "Worker", revision: 7, state, grants: [] }; }
describe("#3370 grant refusal inside the active form", () => {
  it.each(["en", "zh-TW"])("explains an unknown or ineligible recipient without a second click in %s", async lang => {
    const calls = api({ grantFailure: { code: "not-found", status: 404 } }); i18n.setLang(lang, { store: false });
    const pg = await mount(`/ui/hub/exposures?agent=${ID}&grant=1`, panel.HubPanel, { route: { tab: "exposures" } });
    await until(() => pg.root.querySelector(".hub-grant")); input(pg, ".hub-grant input", "unknown-colleague"); await settle(3);
    fire(pg.root.querySelector(".hub-grant")!, "submit"); await until(() => pg.root.querySelector(".hub-grant [role=alert]"));
    expect(pg.root.querySelector(".hub-grant [role=alert]")?.textContent).toContain(lang === "en" ? "Check the sign-in name and that the account is active" : "請確認登入名稱正確、帳號仍可使用");
    expect(pg.root.textContent).not.toContain("Not found, or not available to you.");
    expect(calls.filter(c => c.path === "/hub/v1/grants")).toHaveLength(1);
    input(pg, ".hub-grant input", "alex"); await settle(3); expect(pg.root.querySelector(".hub-grant [role=alert]")).toBeNull();
  });
  it.each(["en", "zh-TW"])("explains a directory outage without exposing its internals in %s", async lang => {
    api({ grantFailure: { code: "unavailable", status: 503 } }); i18n.setLang(lang, { store: false });
    const pg = await mount(`/ui/hub/exposures?agent=${ID}&grant=1`, panel.HubPanel, { route: { tab: "exposures" } });
    await until(() => pg.root.querySelector(".hub-grant")); input(pg, ".hub-grant input", "alex"); await settle(3);
    fire(pg.root.querySelector(".hub-grant")!, "submit"); await until(() => pg.root.querySelector(".hub-grant [role=alert]"));
    expect(pg.root.querySelector(".hub-grant [role=alert]")?.textContent).toContain(lang === "en" ? "The directory couldn't be checked" : "目前無法查核目錄服務");
  });
});
describe("#3337 the administrator's code handoff", () => {
  it.each(["en", "zh-TW"])("labels the member address separately and copies address plus code in %s", async lang => {
    api(); i18n.setLang(lang, { store: false });
    const pg = await mount("/ui/hub/admin", panel.HubPanel, { route: { tab: "admin" } });
    await until(() => pg.root.querySelector(".hub-step-form"));
    input(pg, ".hub-step-form input", "owner"); await settle(4); fire(pg.root.querySelector(".hub-step-form")!, "submit");
    await until(() => pg.root.querySelector(".hub-offer"));
    expect(pg.root.querySelector(".hub-offer .hub-origin")?.textContent).toContain("https://members.example.test:9443");
    expect(pg.root.querySelector(".hub-offer")!.textContent).toContain(lang === "en" ? "Member address" : "成員連線位址");
    const copied: string[] = [];
    (globalThis as any).navigator.clipboard = { writeText: async (s: string) => { copied.push(s); } };
    (pg.root.querySelector(".hub-offer button") as any).click(); await settle(5);
    expect(copied).toHaveLength(1); expect(copied[0]).toContain("https://members.example.test:9443"); expect(copied[0]).toContain("abcd1234abcd");
    expect(copied[0]).not.toContain("https://hub.example.test");
  });
  it("an older server with no member address never substitutes the browser origin", async () => {
    api({ memberOrigin: "" });
    const pg = await mount("/ui/hub/admin", panel.HubPanel, { route: { tab: "admin" } });
    await until(() => pg.root.querySelector(".hub-step-form")); input(pg, ".hub-step-form input", "owner"); await settle(4);
    fire(pg.root.querySelector(".hub-step-form")!, "submit"); await until(() => pg.root.querySelector(".hub-offer"));
    expect(pg.root.querySelector(".hub-offer")!.textContent).toContain("Ask the administrator for the member address");
    expect(pg.root.querySelector(".hub-offer .hub-origin")).toBeNull();
    expect(pg.root.querySelector(".hub-offer button")).toBeNull();
  });
});
describe("#3338 exact-agent continuation", () => {
  it.each(["en", "zh-TW"])("a switcher-cached dictionary without the new key retains a translated Allow action in %s", async lang => {
    const original = { en: i18n.tIn("en", "hub.allowOnHub"), "zh-TW": i18n.tIn("zh-TW", "hub.allowOnHub") };
    i18n.register("hub", { en: { allowOnHub: undefined }, "zh-TW": { allowOnHub: undefined } });
    try {
      i18n.setLang(lang, { store: false });
      const c = client.createStubClient(); client.setHubClient(c);
      await c.connect({ address: "https://members.example.test:9443", code: "ABCD-EFGH" }); c.control.approve({ webOrigin: "https://hub.example.test" });
      c.exposures = async () => [{ agent: "worker", display: "Worker", exposureId: ID, revision: 7, state: "published", enforceable: true }];
      const pg = await mount("/ui/settings/hub", card.HubConnectCard); await until(() => pg.root.querySelector(".hub-exposure a"));
      const a = pg.root.querySelector(".hub-exposure a")!;
      expect(a.textContent).toBe(lang === "en" ? "Allow…" : "允許…");
      expect(a.getAttribute("href")).toBe(`https://hub.example.test/ui/hub/exposures?agent=${ID}&grant=1`);
      expect(pg.root.textContent).not.toContain("hub.allowOnHub");
    } finally { i18n.register("hub", { en: { allowOnHub: original.en }, "zh-TW": { allowOnHub: original["zh-TW"] } }); }
  });
  it("only committed, published rows get a link on the approved paired browser origin", async () => {
    const c = client.createStubClient({ agents: () => [{ name: "worker" }] }); client.setHubClient(c);
    await c.connect({ address: "https://members.example.test:9443", code: "ABCD-EFGH" }); c.control.approve({ webOrigin: "https://hub.example.test" });
    let rows = [{ agent: "worker", display: "Worker", exposureId: ID, revision: 7, state: "published", enforceable: true }];
    c.exposures = async () => rows;
    const pg = await mount("/ui/settings/hub", card.HubConnectCard);
    await until(() => pg.root.querySelector(".hub-exposure"));
    const a = pg.root.querySelector(".hub-exposure a")!;
    expect(a?.getAttribute("href")).toBe(`https://hub.example.test/ui/hub/exposures?agent=${ID}&grant=1`);
    expect([a?.getAttribute("target"), a?.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    c.control.keyChanged(); await until(() => pg.root.querySelector(".hub-key-changed")); expect(pg.root.querySelector(".hub-exposure a")).toBeNull();
  });
  it.each(["origin", "binding"])("a pairing %s change drops the previous Hub's rows while the new read is held", async change => {
    const c = client.createStubClient({ agents: () => [{ name: "worker" }] }); client.setHubClient(c);
    await c.connect({ address: "https://members.example.test:9443", code: "ABCD-EFGH" }); c.control.approve({ webOrigin: "https://hub.example.test" });
    c.exposures = async () => [{ agent: "worker", display: "Worker", exposureId: ID, revision: 7, state: "published", enforceable: true }];
    let update!: (p: any) => void;
    c.subscribe = (fn: any) => { update = fn; return () => {}; };
    const pg = await mount("/ui/settings/hub", card.HubConnectCard); await until(() => pg.root.querySelector(".hub-exposure a"));
    expect(pg.root.querySelector(".hub-exposure a")).not.toBeNull();
    let release!: (v: any) => void; const held = new Promise(r => { release = r; }); c.exposures = () => held;
    const paired = await c.pairing(); update(change === "binding" ? { ...paired, binding: "new-binding" } : { ...paired, hub: { ...paired.hub, webOrigin: "https://other-hub.example.test" } }); await settle(10);
    expect(pg.root.querySelector(".hub-exposure a")).toBeNull(); release([]); await settle(5);
  });
  it.each(["withdrawn", "frozen", "pending", "no-id"])("no continuation for %s rows", async state => {
    const c = client.createStubClient(); client.setHubClient(c);
    await c.connect({ address: "https://members.example.test:9443", code: "ABCD-EFGH" }); c.control.approve({});
    c.exposures = async () => [{ agent: "worker", display: "Worker", exposureId: state === "no-id" ? null : ID, revision: 1, state: ["pending", "no-id"].includes(state) ? "published" : state, pending: state === "pending" ? {} : null, enforceable: true }];
    const pg = await mount("/ui/settings/hub", card.HubConnectCard); await until(() => pg.root.querySelector(".hub-exposure"));
    expect(pg.root.querySelector(".hub-exposure a")).toBeNull();
  });
  it("retains the exact agent across sign-in; opens Allow once, never posts a grant before submission", async () => {
    const calls = api({ signedIn: false });
    const pg = await mount(`/ui/hub/exposures?agent=${ID}&grant=1`, panel.HubPanel, { route: { tab: "exposures" } });
    await until(() => pg.root.querySelector(".hub-signin")); input(pg, "#hubLogin", "owner"); input(pg, "#hubPassword", "pw"); await settle(4);
    fire(pg.root.querySelector(".hub-signin form")!, "submit"); await until(() => pg.root.querySelector(".hub-grant"));
    expect(pg.root.querySelector(".hub-grant")).not.toBeNull();
    expect(calls.filter(c => c.path === "/hub/v1/grants")).toHaveLength(0);
    input(pg, ".hub-grant input", "alex"); await settle(4); fire(pg.root.querySelector(".hub-grant")!, "submit");
    await until(() => calls.some(c => c.path === "/hub/v1/grants"));
    expect(calls.find(c => c.path === "/hub/v1/grants")).toMatchObject({ method: "POST", body: { exposureId: ID, exposureRevision: 7, login: "alex", days: 7 }, csrf: "c".repeat(64) });
    await until(() => !pg.root.querySelector(".hub-grant")); await settle(10); expect(pg.root.querySelector(".hub-grant")).toBeNull();
  });
  it.each(["unknown", "not-owner", "withdrawn", "frozen", "no-intent"])("never opens Allow for %s", async control => {
    api({ mine: ["unknown", "not-owner"].includes(control) ? [] : [exposure(["withdrawn", "frozen"].includes(control) ? control : "published")], askable: control === "not-owner" ? [exposure()] : [] });
    const pg = await mount(`/ui/hub/exposures?agent=${ID}${control === "no-intent" ? "" : "&grant=1"}`, panel.HubPanel, { route: { tab: "exposures" } });
    await until(() => pg.root.querySelector(".hub-owner")); await settle(10); expect(pg.root.querySelector(".hub-grant")).toBeNull();
  });
});
