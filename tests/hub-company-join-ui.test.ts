/** Mounted production panels: explicit identity-submit, no invented readiness, scoped recovery and old-shell imports. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let fleet: any, hub: any;
const mounted: AppPage[] = [], id = "0f1e2d3c-4b5a-4968-8776-655443322110", calls: Array<{ path: string; init: any }> = [];
beforeAll(async () => {
  const p = page({ url: "http://127.0.0.1:19290/settings/hub", storage: { agend_lang: "en" } });
  fleet = await import("/ui/js/settings-hub-company-join.js"); hub = await import("/ui/js/hub-company-join.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.length = 0; });
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
  it("opening Settings or a prefilled link never starts a join", async () => {
    fetcher(() => ({ ok: true, operation: null })); const p = await mount(fleet.CompanyJoinSettings);
    expect(p.root.querySelector("#hubCompanyAddress")).not.toBeNull(); expect(button(p, "Sign in with company account")).toBeTruthy();
    expect(calls.every(c => !c.init.method || c.init.method === "GET")).toBe(true);
  });
  it("a saved profile with an offline link stays Connecting, polls and only reports Connected when ready", async () => {
    let online = false; fetcher(() => ({ ok: true, operation: { ...pending, state: "saved", link: online ? "online" : "offline" } }));
    const timers: Array<() => void> = [], real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 1500 ? (timers.push(fn), 999 as any) : real(fn, ms, ...args));
    const p = await mount(fleet.CompanyJoinSettings); expect(p.root.textContent).toContain("Connecting your Fleet"); expect(p.root.textContent).not.toContain("Fleet connected");
    expect(timers.length).toBeGreaterThan(0); online = true; timers.shift()!(); await settle(12);
    expect(p.root.textContent).toContain("Fleet connected");
  });
  it.each([false, true])("a cancelled operation allows a fresh Start only when its unissued result is known (%s)", async unknown => {
    fetcher(() => ({ ok: true, operation: { ...pending, state: "cancelled", outcomeKnown: !unknown } }));
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
    expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
  });
});
