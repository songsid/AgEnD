/** Mounted production panels: explicit identity-submit, no invented readiness, scoped recovery and old-shell imports. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let fleet: any, hub: any, words: any, hubPanel: any, client: any;
const mounted: AppPage[] = [], id = "0f1e2d3c-4b5a-4968-8776-655443322110", calls: Array<{ path: string; init: any }> = [];
beforeAll(async () => {
  const p = page({ url: "http://127.0.0.1:19290/settings/hub", storage: { agend_lang: "en" } });
  fleet = await import("/ui/js/settings-hub-company-join.js"); hub = await import("/ui/js/hub-company-join.js"); words = await import("/ui/js/hub-company-join-strings.js");
  client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.length = 0; });
const pending = { operationId: id, state: "awaiting-sign-in", issued: false, outcomeKnown: true, hubOrigin: "https://hub.example.test", expiresAt: Date.now() + 600_000 };
function fetcher(answer: (path: string, init: any) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => { calls.push({ path, init }); const body: any = await answer(path, init);
    return { ok: body.ok !== false, status: body.ok === false ? 409 : 200, json: async () => body }; }));
}
async function mount(component: any, props = {}, url = "http://127.0.0.1:19290/settings/hub") {
  const p = page({ url, storage: { agend_lang: "en" } }); mounted.push(p); await p.mount(h(component, props)); await settle(12); return p;
}
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === text);
describe("company join UI", () => {
  it.each(["", "&view=notices", "&room=" + id])("the join page keeps its title and single heading ahead of other query views (%s)", async suffix => {
    fetcher(path => path.startsWith("/hub/v1/session") ? { signedIn: true, displayName: "Carol", login: "carol", csrf: "csrf", features: [] }
      : path.includes("/browser?") ? { ok: true, state: "pending", label: "Fleet A", outerDeadline: Date.now() + 600_000 } : {});
    client.setHubClient(client.createHubWebClient({ fetchImpl: globalThis.fetch })); hubPanel.resetHubSession();
    const p = await mount(hubPanel.HubPanel, { route: { tab: "ask" } }, "https://hub.example.test/ui/hub?join=" + id + suffix);
    expect(p.document.title).toBe("Connect to a Hub · AgEnD");
    expect([...p.root.querySelectorAll("h1, h2, h3")].filter((el: any) => el.textContent === "Connect to a Hub")).toHaveLength(1);
    expect(p.root.querySelector(".hub-home")).toBeNull();
  });
  it("keeps the specific changed-pin refusal through the shared Settings confirmation outcome", () => {
    const code = words.joinResponseCode({ body: { error: "Could not apply (apply_rejected: identity-changed)" }, confirmed: { outcome: { detail: "apply_rejected: identity-changed" } } });
    expect(code).toBe("identity-changed"); expect(words.joinError(code)).toContain("identity is different");
    expect(words.joinResponseCode({ body: { error: "denied" } })).toBe("denied");
  });
  it("opening Settings or a prefilled link never starts a join", async () => {
    fetcher(() => ({ ok: true, operation: null })); const p = await mount(fleet.CompanyJoinSettings);
    expect(p.root.textContent).toContain("Copy colleague connection link"); expect(p.root.querySelector("#hubCompanyAddress")).not.toBeNull(); expect(button(p, "Sign in with company account")).toBeTruthy();
    expect(calls.every(c => !c.init.method || c.init.method === "GET")).toBe(true);
  });
  it("explains why company sign-in is disabled until address and Fleet name are present",async()=>{
    fetcher(()=>({ok:true,operation:null}));const p=await mount(fleet.CompanyJoinSettings);
    expect(p.root.textContent).toContain("Paste the Hub link first");expect(button(p,"Sign in with company account").getAttribute("aria-describedby")).toBe("hubCompanyStartHint");
    const address=p.root.querySelector("#hubCompanyAddress");address.value="https://hub.example.test";fire(address,"input");await settle(5);
    expect(p.root.querySelector("#hubCompanyStartHint")).toBeNull();expect(button(p,"Sign in with company account").disabled).toBe(false);expect(calls.every(c=>!c.init.method||c.init.method==="GET")).toBe(true);
  });
  it("the distributed public link provides in-surface navigation, without sign-in or an enrollment action", async () => {
    fetcher(() => { throw Error("No request expected"); });
    const p = await mount(hub.CompanyJoinInfoPage, {}, "https://hub.example.test/ui/hub?joinInfo=1#hub=YWJj");
    expect(p.root.querySelector('input[type="password"]')).toBeNull(); expect(calls).toEqual([]);
    const input = p.root.querySelector("input"); input.value = "javascript:alert(1)"; fire(input, "input"); await settle(3);
    expect(p.root.querySelector("a")).toBeNull();
    input.value = "http://127.0.0.1:4444"; fire(input, "input"); await settle(3);
    expect(p.root.querySelector("a")?.getAttribute("href")).toBe("http://127.0.0.1:4444/settings/hub#join=" + encodeURIComponent("https://hub.example.test/join-info#hub=YWJj"));
    expect(calls).toEqual([]);
  });
  it.each(["https://hub.example.test", "https://hub.example.test:4444"])("the public link refuses same-hostname navigation before any request (%s)", async address => {
    fetcher(() => { throw Error("No request expected"); });
    const p = await mount(hub.CompanyJoinInfoPage, {}, "https://hub.example.test/ui/hub?joinInfo=1#hub=YWJj");
    const input = p.root.querySelector("input"); input.value = address; fire(input, "input"); await settle(3);
    expect(p.root.querySelector("a")).toBeNull();
    expect(p.root.textContent).toContain(words.hj("separateHosts"));
    expect(calls).toEqual([]);
    input.value = "https://fleet.example.test:4444"; fire(input, "input"); await settle(3);
    expect(p.root.querySelector("a")?.getAttribute("href")).toBe("https://fleet.example.test:4444/settings/hub#join=" + encodeURIComponent("https://hub.example.test/join-info#hub=YWJj"));
    expect(p.root.textContent).not.toContain(words.hj("separateHosts"));
    expect(calls).toEqual([]);
  });
  it("an already-bound Fleet does not offer another enrollment from a different local session", async () => {
    fetcher(() => ({ ok: true, bound: true, operation: null })); const p = await mount(fleet.CompanyJoinSettings);
    expect(p.root.textContent).toBe(""); expect(calls.filter(c => c.init.method === "POST")).toEqual([]);
  });
  it("a saved profile with an offline link stays Connecting, polls and only reports Connected when ready", async () => {
    let online = false; fetcher(() => ({ ok: true, operation: { ...pending, state: "saved", link: online ? "online" : "offline" } }));
    const timers: Array<() => void> = [], real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 1500 ? (timers.push(fn), 999 as any) : real(fn, ms, ...args));
    const p = await mount(fleet.CompanyJoinSettings); expect(p.root.textContent).toContain("Connecting your Fleet"); expect(p.root.textContent).not.toContain("Fleet connected");
    expect(timers.length).toBeGreaterThan(0); online = true; timers.shift()!(); await settle(12);
    expect(p.root.textContent).toContain("Fleet connected");
  });
  it.each(["cancelled", "ended"].flatMap(state => [false, true].map(unknown => ({ state, unknown }))))("a $state operation allows a fresh Start only when its unissued result is known ($unknown)", async ({ state, unknown }) => {
    fetcher(() => ({ ok: true, operation: { ...pending, state, outcomeKnown: !unknown } }));
    const p = await mount(fleet.CompanyJoinSettings); expect(!!p.root.querySelector("form")).toBe(!unknown);
    expect(p.root.textContent).not.toContain("Fleet connected");
  });
  it("a Fleet-owned waiting tab keeps a same-surface return path when Start is refused or awaits confirmation", async () => {
    fetcher(() => ({ ok: true, operation: null })); const p = await mount(fleet.CompanyJoinSettings, {}, "http://127.0.0.1:19290/settings/hub?joinWait=" + id);
    expect(p.root.querySelector('a[href="/settings/hub"]')?.textContent).toBe("Return to Fleet Settings"); expect(p.root.querySelector("form")).toBeNull();
  });
  it("an existing Hub session requires the explicit shown identity action and sends only that exact request", async () => {
    fetcher((path, init) => path.includes("/browser?") ? { ok: true, state: "pending", label: "Fleet A", fleetOrigin: "http://127.0.0.1:4444", outerDeadline: Date.now() + 600_000 } : { ok: true, state: "identity-approved" });
    const p = await mount(hub.HubCompanyJoinPage, { session: { displayName: "Carol", csrf: "private-csrf" } }, "https://hub.example.test/ui/hub?join=" + id);
    expect(p.root.textContent).toContain("http://127.0.0.1:4444"); expect(calls.filter(c => c.init.method === "POST")).toEqual([]);
    fire(button(p, "Connect as Carol"), "click"); await settle(12);
    expect(calls.filter(c => c.init.method === "POST")).toMatchObject([{ path: "/hub/v1/join/approve", init: { body: JSON.stringify({ requestId: id }), headers: { "X-AgEnD-Hub-CSRF": "private-csrf" } } }]);
  });
  it("a Hub limit refusal uses plain limit copy, with no success or silent retry", async () => {
    fetcher((path, init) => path.includes("/browser?") ? { ok: true, state: "pending", label: "Fleet A", outerDeadline: Date.now() + 600_000 } : { ok: false, code: "limit-reached" });
    const p = await mount(hub.HubCompanyJoinPage, { session: { login: "carol", csrf: "csrf" } }, "https://hub.example.test/ui/hub?join=" + id);
    fire(button(p, "Connect as carol"), "click"); await settle(12);
    expect(p.root.textContent).toContain("Your Fleet limit is reached"); expect(p.root.textContent).not.toContain("Your Fleet has connected");
    expect(button(p, "Connect as carol")).toBeUndefined();
    expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
  });
});
