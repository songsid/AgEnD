/** A normal admin page must not exhaust its own fresh-eligibility admission. No directory/account operations. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let clients: any, panel: any, steps: any, words: any, codeUI: any, company: any;
const pages: AppPage[] = [];
const session = { signedIn: true, admin: true, csrf: "owned-session", displayName: "Ada", features: ["company-join-v1", "group-policy-v1", "enrolment-code-v1"] };
const policy = { realm: "example", generation: "g1", revision: 1, state: "enabled", groups: [{ group: { realm: "example", objectId: "g" }, dn: "CN=Colleagues,DC=test", allow: ["pair_fleet"], maxFleets: 1 }], denies: [] };
const response = (body: any, status = 200, after = "0") => ({ ok: status === 200, status, headers: new Headers({ "Retry-After": after }), json: async () => body });
const busy = () => response({ code: "backpressure" }, 429);
const until = async (fn: () => unknown) => { for (let i = 0; i < 150 && !fn(); i++) await settle(3); expect(fn()).toBeTruthy(); };
beforeAll(async () => { const p = page(); clients = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/panel-hub.js"); steps = await import("/ui/js/hub-join-steps.js"); words = await import("/assets/app-i18n.js"); codeUI = await import("/ui/js/hub-enrolment-code.js"); company = await import("/ui/js/hub-company-join.js"); p.restore(); });
afterEach(async () => { vi.useRealTimers(); for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } panel.resetHubSession(); clients.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hub read admission and bounded recovery", () => {
  it("coalesces duplicate reads and serializes distinct reads, including company settings", async () => {
    let release!: () => void, active = 0, max = 0;
    const hold = new Promise<void>(r => { release = r; });
    const fetchImpl = vi.fn(async (_path: string) => { active++; max = Math.max(max, active); await hold; active--; return response({}); });
    const c = clients.createHubWebClient({ fetchImpl });
    const reads = [c.adminOverview(), c.groupPolicy(), c.groupPolicy(), c.enrolmentCodes(), c.enrolmentCodes(), c.rooms(), c.thisHub()];
    await Promise.resolve(); await Promise.resolve(); release(); await Promise.all(reads);
    expect(max).toBe(1); expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(typeof c.companyJoinSettings).toBe("function"); await c.companyJoinSettings();
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe("/hub/v1/admin/company-join");
  });
  it("backs off on read-only 429, caps a foreign Retry-After, and stops after four attempts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => response({ code: "backpressure" }, 429, "999999"));
    const c = clients.createHubWebClient({ fetchImpl }), result = c.adminOverview();
    await vi.advanceTimersByTimeAsync(0); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(await result).toMatchObject({ ok: false, status: 429, code: "backpressure" });
    await vi.advanceTimersByTimeAsync(60000); expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each([403, 500])("does not retry a %i or a write, including creation limits", async status => {
    const fetchImpl = vi.fn(async () => response({ code: "backpressure", reason: "live-code-limit" }, status));
    const c = clients.createHubWebClient({ fetchImpl }); await c.adminOverview(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async () => response({ code: "backpressure", reason: "live-code-limit" }, 429));
    expect(await c.createEnrolmentCode({})).toMatchObject({ reason: "live-code-limit" }); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("a retry succeeds; a later explicit read is fresh, not a cached authority answer", async () => {
    vi.useFakeTimers(); let n = 0;
    const fetchImpl = vi.fn(async () => ++n === 1 ? busy() : response({ fleets: [], version: n }));
    const c = clients.createHubWebClient({ fetchImpl }), read = c.adminOverview(); await vi.advanceTimersByTimeAsync(4000);
    expect(await read).toMatchObject({ ok: true, version: 2 }); expect(await c.adminOverview()).toMatchObject({ version: 3 });
  });
  it("session end cancels backoff and refuses queued reads without another eligibility call", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_p: string, init: any) => init.method === "POST" ? response({ code: "denied" }, 401) : busy());
    const c = clients.createHubWebClient({ fetchImpl }), ended = vi.fn(); c.onSignedOut(ended);
    const first = c.adminOverview(), queued = c.groupPolicy(); await vi.advanceTimersByTimeAsync(0);
    await c.createPairing("colleague"); await vi.advanceTimersByTimeAsync(20000);
    expect(await first).toMatchObject({ ok: false }); expect(await queued).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(ended).toHaveBeenCalledTimes(1);
  });
  it("a late old-session 401 cannot revoke a newly signed-in client", async () => {
    let finish!: (value: any) => void;
    const fetchImpl = vi.fn(async (path: string, init: any) => {
      if (init.method === "POST" && path === "/hub/v1/session") return response({ csrf: "new-session" });
      if (init.method === "POST") return response({});
      return await new Promise(r => { finish = r; });
    });
    const c = clients.createHubWebClient({ fetchImpl }), ended = vi.fn(); c.onSignedOut(ended);
    const old = c.adminOverview(); await Promise.resolve(); await Promise.resolve();
    await c.signIn("admin", "fixture-only"); finish(response({ code: "unauthenticated" }, 401)); await old;
    await c.createPairing("colleague"); expect(ended).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.at(-1)?.[1].headers["X-AgEnD-Hub-CSRF"]).toBe("new-session");
  });
  it("a write invalidates coalescing: its subsequent read cannot reuse the earlier snapshot", async () => {
    let release!: (value: any) => void, version = 0;
    const fetchImpl = vi.fn(async (_path: string, init: any) => {
      if (init.method !== "GET") { version++; return response({}); }
      if (!version) return await new Promise(r => { release = r; });
      return response({ version });
    });
    const c = clients.createHubWebClient({ fetchImpl }), before = c.groupPolicy(); await Promise.resolve(); await Promise.resolve();
    await c.saveGroupPolicy({}, "preview"); const after = c.groupPolicy(); release(response({ version: 0 }));
    expect(await before).toMatchObject({ version: 0 }); expect(await after).toMatchObject({ version: 1 });
  });
  it("aborting a queued directory read does not start it", async () => {
    let done!: (v: any) => void;
    const held = new Promise(r => { done = r; });
    const fetchImpl = vi.fn(() => held);
    const c = clients.createHubWebClient({ fetchImpl }), first = c.adminOverview(), abort = new AbortController();
    const next = c.directorySettings(abort.signal); await Promise.resolve(); await Promise.resolve(); abort.abort(); done(response({}));
    await Promise.all([first, next]); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

async function mount(vnode: any, lang = "en") { const p = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang, { store: false }); await p.mount(vnode); await settle(25); return p; }
const button = (p: AppPage, name: string) => [...p.root.querySelectorAll("button")].find((e: any) => e.textContent === name);

describe("mounted Administration", () => {
  it.each([false, true])("a normal page with one transient 429=%s reaches enabled controls without reload or a write", async transient => {
    let active = 0, max = 0, rejected = false; const reads: string[] = [];
    const fetchImpl = vi.fn(async (path: string, init: any) => {
      reads.push(path); expect(init.method).toBe("GET");
      if (active >= 4) return busy();
      active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 0)); active--;
      if (transient && path === "/hub/v1/admin/company-join" && !rejected) { rejected = true; return busy(); }
      if (path === "/hub/v1/session") return response(session);
      if (path === "/hub/v1/admin/overview") return response({ fleets: [], pairings: [] });
      if (path === "/hub/v1/admin/group-policy") return response({ supported: true, binding: "ready", policy, paused: [] });
      if (path === "/hub/v1/admin/company-join") return response({ enabled: true, revision: 1, companyLink: "https://hub.example.test/join-info#hub=owned" });
      if (path === "/hub/v1/admin/enrolment-codes") return response({ codes: [] });
      if (path === "/hub/v1/admin/hub") return response({ hub: { name: "Owned Hub" } });
      return response({ rooms: [], askable: [], features: [] });
    });
    const c = clients.createHubWebClient({ fetchImpl }); clients.setHubClient(c); vi.stubGlobal("fetch", fetchImpl);
    const p = await mount(h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } }));
    await until(() => button(p, "Create join code") && !button(p, "Create join code").disabled);
    expect(p.root.querySelector('li[data-step="1"]').classList.contains("done")).toBe(true);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(true);
    expect(p.root.textContent).not.toContain("Finish steps 1 and 2 first.");
    expect(max).toBe(1); expect(reads).toContain("/hub/v1/admin/company-join");
    await p.unmount();
  });
  it("keeps known completed steps across a backpressured refresh, but a successful disabled policy clears step 2", async () => {
    let fail = false, disabled = false, n = 0;
    const c = { enrolmentCodeV1: true, onSignedOut: () => () => {},
      groupPolicy: vi.fn(async () => fail ? { ok: false, status: 429, code: "backpressure" } : { ok: true, supported: true, binding: "ready", policy: disabled ? { ...policy, state: "disabled", groups: [] } : policy }),
      enrolmentCodes: vi.fn(async () => fail ? { ok: false, status: 429, code: "backpressure" } : { ok: true, codes: [] }),
      createEnrolmentCode: vi.fn(async () => { n++; fail = n === 1; return { ok: true }; }), revokeEnrolmentCode: vi.fn(), searchGroups: vi.fn(async () => ({ ok: true, groups: [] })) };
    const p = await mount(h(steps.HubJoinCard, { view: { enabled: true }, groups: true, client: c, features: ["enrolment-code-v1"] }));
    await until(() => button(p, "Create join code")); expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(true);
    fire(button(p, "Create join code"), "click"); await settle(8); fire(p.root.querySelector("#hubEnrolmentCreate"), "submit"); await settle(15);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(true);
    expect(p.root.textContent).not.toContain("Finish steps 1 and 2 first."); expect(p.root.textContent).toContain("Try again");
    fail = false; disabled = true;
    const retry = [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Try again" && b.closest(".hub-join-read-status"));
    expect(retry).toBeTruthy(); fire(retry, "click"); await settle(12);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(false); expect(c.createEnrolmentCode).toHaveBeenCalledTimes(1);
  });
  it("a backpressured code-list refresh retains known rows and Retry clears the error without a write", async () => {
    let fail = false;
    const timers: Array<() => void> = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 5000 ? (timers.push(fn), 123 as any) : original(fn, ms, ...args));
    const c = { enrolmentCodeV1: true, enrolmentCodes: vi.fn(async () => fail ? { ok: false, code: "backpressure", status: 429 } : { ok: true, codes: [{ id: "owned", code: "1234-ABCD", state: "live", scope: { kind: "directory" }, expiresAt: Date.now() + 60000 }] }), createEnrolmentCode: vi.fn(), revokeEnrolmentCode: vi.fn() };
    const p = await mount(h(codeUI.HubEnrolmentCode, { client: c, enabled: true })); expect(p.root.textContent).toContain("1234-ABCD");
    fail = true; timers.shift()!(); await settle(10); expect(p.root.textContent).toContain("1234-ABCD"); expect(button(p, "Try again")).toBeTruthy();
    fail = false; fire(button(p, "Try again"), "click"); await settle(10); expect(button(p, "Create join code").disabled).toBe(false);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled(); expect(c.revokeEnrolmentCode).not.toHaveBeenCalled();
  });
  it("a held company-settings read cannot restore the card after session end", async () => {
    let end!: () => void, finish!: (v: any) => void;
    const c = { session: async () => ({ ok: true, ...session }), companyJoinSettings: () => new Promise(r => { finish = r; }), onSignedOut: (fn: () => void) => { end = fn; return () => {}; } };
    clients.setHubClient(c); const p = await mount(h(company.CompanyJoinAdminCard)); end(); await settle(5);
    finish({ ok: true, enabled: true, companyLink: "https://hub.example.test/owned" }); await settle(10);
    expect(p.root.querySelector('input[role="switch"]')).toBeNull(); expect(p.root.querySelector("textarea")).toBeNull();
  });
  it("an initial group-list failure offers read retry, not the misleading save error", async () => {
    let fail = true; const c = { groupPolicy: vi.fn(async () => fail ? { ok: false, status: 429, code: "backpressure" } : { ok: true, supported: true, binding: "ready", policy }) };
    const p = await mount(h(steps.JoinStep2, { client: c })); expect(p.root.textContent).toContain("Try again"); expect(p.root.textContent).not.toContain("Could not save");
    fail = false; fire(button(p, "Try again"), "click"); await settle(10); expect(p.root.textContent).toContain("CN=Colleagues,DC=test");
  });
});
