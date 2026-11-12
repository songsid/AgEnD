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
    expect(p.root.textContent).toContain("Enter the Hub address (for example hub.example.com)"); expect(p.root.querySelector("#hubCompanyAddress")).not.toBeNull(); expect(button(p, "Sign in with company account")).toBeTruthy();
    expect(calls.every(c => !c.init.method || c.init.method === "GET")).toBe(true);
  });
  it("M-2921: one input — Start waits for the Hub's read-only probe; the line names the Hub and this computer; no Fleet name field until 改名", async () => {
    fetcher(path => path.endsWith("/probe") ? { ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity: "new", separateHosts: true, suggestedLabel: "build-box", features: [] } : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    expect(p.root.querySelector("#hubCompanyFleetName")).toBeNull();
    expect(button(p, "Sign in with company account").disabled).toBe(true);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "hub.example.test"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(calls.filter(c => c.path.endsWith("/probe")).map(c => JSON.parse(c.init.body))).toEqual([{ address: "https://hub.example.test" }]);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cAcme Hub\u201d. This Fleet will appear as \u201cbuild-box\u201d.");
    expect(button(p, "Sign in with company account").disabled).toBe(false);
    fire(button(p, "Rename"), "click"); await settle(4);
    const name = p.root.querySelector("#hubCompanyFleetName"); expect(name.getAttribute("placeholder")).toBe("build-box");
    name.value = "QA"; fire(name, "input"); await settle(4);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("\u201cQA\u201d");
    expect(calls.every(c => !c.init.method || c.init.method === "GET" || c.path.endsWith("/probe"))).toBe(true);
  });
  it("M-2921: Start stays off while the probe for this address has not answered; a probe that cannot answer at all does not block it", async () => {
    let answer: (v: any) => void = () => {};
    fetcher(path => path.endsWith("/probe") ? new Promise(r => { answer = r; }) : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "hub.example.test"; fire(address, "input"); await settle(4);
    expect(button(p, "Sign in with company account").disabled).toBe(true);                // typed, not yet probed
    fire(address, "blur"); await settle(6);
    expect(button(p, "Sign in with company account").disabled).toBe(true);                // probing
    answer({ ok: false }); await settle(8);                                                  // no reason: the probe could not answer
    expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
  it("#3675 r1 P2: the same address is looked up again — after it could not be reached, the next blur asks again and the Hub is found", async () => {
    const answers = [{ ok: false, reason: "unreachable" }, { ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity: "new", separateHosts: true, suggestedLabel: "box" }];
    fetcher(path => path.endsWith("/probe") ? answers.shift() ?? answers[0] : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "hub.example.test"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("cannot be reached");
    expect(button(p, "Sign in with company account").disabled).toBe(true);
    fire(address, "blur"); await settle(8);                                                  // the network is back: same address, asked again
    expect(calls.filter(c => c.path.endsWith("/probe"))).toHaveLength(2);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cAcme Hub\u201d");
    expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
  it("#3675 r1 P2: after the saved identity is replaced, the same address is looked up again (no stale E8)", async () => {
    let identity = "changed";
    fetcher((path, init) => path.endsWith("/probe") ? { ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity, separateHosts: true, suggestedLabel: "box" }
      : path.endsWith("/repair-trust") ? (identity = "known", { ok: true }) : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "https://hub.example.test/join-info#hub=YWJj"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("presents a different identity");
    fire(button(p, "Replace saved Hub identity"), "click"); await settle(20);
    expect(calls.filter(c => c.path.endsWith("/repair-trust"))).toHaveLength(1);
    expect(calls.filter(c => c.path.endsWith("/probe"))).toHaveLength(2);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cAcme Hub\u201d");
    expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
  it("#3675 r2 P2: a look held from before the repair answers late with the old identity — retired; the fresh look after the repair stands", async () => {
    const ok = (identity: string) => ({ ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity, separateHosts: true, suggestedLabel: "box" });
    const held: Array<(v: any) => void> = []; let n = 0;
    fetcher(path => path.endsWith("/probe") ? (++n === 2 ? new Promise(r => held.push(r)) : ok(n === 1 ? "changed" : "known"))
      : path.endsWith("/repair-trust") ? { ok: true } : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "https://hub.example.test/join-info#hub=YWJj"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("presents a different identity");
    fire(address, "blur"); await settle(6);                                                 // a second look, held
    fire(button(p, "Replace saved Hub identity"), "click"); await settle(20);              // the fresh look after the repair answers "known"
    expect(calls.filter(c => c.path.endsWith("/probe"))).toHaveLength(3);
    held[0](ok("changed")); await settle(10);                                               // the held, older look answers late
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cAcme Hub\u201d");
    expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
  it("#3675 r2 P2: a repair of A that finishes after the input moved to B (already found) never looks A up again nor disables B", async () => {
    const ok = (identity: string, webOrigin: string) => ({ ok: true, hubName: webOrigin.includes("b.") ? "B Hub" : "A Hub", webOrigin, companyJoin: true, identity, separateHosts: true, suggestedLabel: "box" });
    let release!: (v: any) => void;
    fetcher((path, init) => path.endsWith("/probe") ? (JSON.parse(init.body).address.includes("b.example") ? ok("new", "https://b.example.test") : ok("changed", "https://a.example.test"))
      : path.endsWith("/repair-trust") ? new Promise(r => { release = r; }) : { ok: true, operation: null });
    const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "https://a.example.test/join-info#hub=YWJj"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    fire(button(p, "Replace saved Hub identity"), "click"); await settle(6);              // the repair of A is held
    address.value = "b.example.test"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cB Hub\u201d");
    const looks = calls.filter(c => c.path.endsWith("/probe")).length;
    release({ ok: true }); await settle(20);
    expect(calls.filter(c => c.path.endsWith("/probe"))).toHaveLength(looks);              // A is not looked up again
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain("Found \u201cB Hub\u201d");
    expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
  it.each([
    ["http://hub.example.test", "A Hub address must use https."],
    ["not a hub!", "That is not a Hub address. Enter one like hub.example.com."],
    ["ftp://hub.example.test", "That is not a Hub address."],
  ])("M-2921: %s is refused here, before any request (E1 / E2)", async (typed, message) => {
    fetcher(() => ({ ok: true, operation: null })); const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = typed; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(6);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain(message);
    expect(button(p, "Sign in with company account").disabled).toBe(true);
    expect(calls.some(c => c.path.endsWith("/probe"))).toBe(false);
  });
  it.each([
    [{ ok: false, reason: "unreachable" }, "hub.example.test cannot be reached."],
    [{ ok: false, reason: "certificate" }, "does not trust hub.example.test's certificate"],
    [{ ok: false, reason: "not-hub" }, "hub.example.test is not an AgEnD Hub."],
    [{ ok: true, hubName: "Acme Hub", companyJoin: false, identity: "new", separateHosts: true, suggestedLabel: "x" }, "\u201cAcme Hub\u201d does not accept company-account connections yet."],
    [{ ok: true, hubName: "Acme Hub", companyJoin: true, identity: "new", separateHosts: false, suggestedLabel: "x" }, "need different host names"],
    [{ ok: true, hubName: null, companyJoin: true, identity: "changed", separateHosts: true, suggestedLabel: "x" }, "\u201chub.example.test\u201d presents a different identity"],
  ])("M-2921: the probe's answer %j shows its message (E3–E8) and keeps Start off", async (answer, message) => {
    fetcher(path => path.endsWith("/probe") ? answer : { ok: true, operation: null }); const p = await mount(fleet.CompanyJoinSettings);
    const address = p.root.querySelector("#hubCompanyAddress"); address.value = "https://hub.example.test"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(8);
    expect(p.root.querySelector("#hubCompanyLine").textContent).toContain(message);
    expect(button(p, "Sign in with company account").disabled).toBe(true);
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
  it("M-2921: connected — the Hub tab says so and closes itself; one the browser keeps open offers the way back after 300 ms", async () => {
    const close = vi.fn(); vi.stubGlobal("close", close);
    fetcher(path => path.includes("/browser?") ? { ok: true, state: "acknowledged", connected: true, label: "Fleet A", returnPath: "http://127.0.0.1:4444/settings/hub", outerDeadline: Date.now() + 600_000 } : {});
    const p = await mount(hub.HubCompanyJoinPage, { session: { login: "carol", csrf: "csrf" } }, "https://hub.example.test/ui/hub?join=" + id);
    expect(p.root.querySelector(".hub-join-closing [role=status]").textContent).toBe("Connected. You can close this tab.");
    expect(close).toHaveBeenCalledTimes(1);
    expect(p.root.querySelector(".hub-join-closing a")).toBeNull();
    await new Promise(r => setTimeout(r, 320)); await settle(6);
    expect(p.root.querySelector(".hub-join-closing a")?.getAttribute("href")).toBe("http://127.0.0.1:4444/settings/hub");
  });
  it("M-2921: E13 — approval refused because a pairing-code connection is in progress for this person", async () => {
    fetcher(path => path.includes("/browser?") ? { ok: true, state: "pending", label: "Fleet A", outerDeadline: Date.now() + 600_000 } : { ok: false, code: "offer-pending" });
    const p = await mount(hub.HubCompanyJoinPage, { session: { login: "carol", csrf: "csrf" } }, "https://hub.example.test/ui/hub?join=" + id);
    fire(button(p, "Connect as carol"), "click"); await settle(12);
    expect(p.root.textContent).toContain("Another connection with a pairing code is still in progress for you. Finish or stop it on the Hub first.");
  });
});
