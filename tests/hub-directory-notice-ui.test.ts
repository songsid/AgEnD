/** Mounted production Preact and actual client adapters. Network boundaries are covered by the two real-listener suites. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let ui: any, host: any, hub: any, i18n: any;
const pages: AppPage[] = [];
const ID = "0f1e2d3c-4b5a-4968-8776-655443322110", OLD = "0f1e2d3c-4b5a-4968-8776-655443322111";
const row = (id = ID, overrides = {}) => ({ id, operationId: id, kind: "directory", phase: "applying", at: 1000,
  changes: ["server", "ca", "secret"], actor: { kind: "host-owner" }, acknowledged: false, ...overrides });
beforeAll(async () => {
  const p = page(); ui = await import("/ui/js/hub-directory-notices.js"); host = await import("/ui/js/hub-host-security-notices.js");
  hub = await import("/ui/js/hub-client.js"); i18n = await import("/assets/app-i18n.js"); p.restore();
});
afterEach(async () => { vi.restoreAllMocks(); for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); i18n.setLang("en", { store: false }); });
const fake = (over: Record<string, unknown> = {}): any => ({ directorySecurityNotices: vi.fn(async () => ({ ok: true, items: [row()], nextBefore: null })),
  acknowledgeDirectorySecurityNotice: vi.fn(async () => ({ ok: true })), ...over });
async function mount(client: any, lang = "en") {
  const p = page({ url: "http://127.0.0.1:19290/ui/hub?view=notices" }); pages.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(ui.DirectoryNotices, { client })); await settle(15); return p;
}
const button = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((e: any) => e.textContent === label);
const click = async (p: AppPage, label: string) => { const b = button(p, label); expect(b, label).toBeTruthy(); fire(b, "click"); await settle(15); };
const held = () => { let release!: (value: any) => void; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

describe("directory notice history and explicit acknowledgments", () => {
  it.each(["en", "zh-TW"])("reads only when mounted, never acknowledges on display (%s)", async lang => {
    const c = fake(), p = await mount(c, lang);
    expect(c.directorySecurityNotices).toHaveBeenCalledExactlyOnceWith({ limit: 25 });
    expect(c.acknowledgeDirectorySecurityNotice).not.toHaveBeenCalled();
    expect(p.root.querySelectorAll("[data-directory-notice]")).toHaveLength(1);
    expect(p.root.textContent).toContain(lang === "en" ? "does not acknowledge" : "不會自動確認");
    expect(p.root.textContent).not.toContain("directoryNotices.");
    expect(p.root.textContent).not.toContain("Connection is healthy"); // host-independent event, never a health-success claim
  });
  it("loads older history, deduplicates overlap, and acknowledges exactly the clicked old ID", async () => {
    const c = fake({ directorySecurityNotices: vi.fn().mockResolvedValueOnce({ ok: true, items: [row()], nextBefore: ID })
      .mockResolvedValueOnce({ ok: true, items: [row(), row(OLD, { kind: "directory-compensation" })], nextBefore: null }) });
    const p = await mount(c); await click(p, "Older notices");
    expect(c.directorySecurityNotices).toHaveBeenLastCalledWith({ before: ID, limit: 25 });
    expect(p.root.querySelectorAll("[data-directory-notice]")).toHaveLength(2);
    expect(p.root.textContent).toContain("restoration recorded");
    const old = p.root.querySelector(`[data-directory-notice="${OLD}"]`)!;
    fire(old.querySelector("button"), "click"); await settle(15);
    expect(c.acknowledgeDirectorySecurityNotice).toHaveBeenCalledExactlyOnceWith(OLD);
    expect(old.textContent).toContain("Acknowledged");
    expect(p.root.querySelector(`[data-directory-notice="${ID}"]`)!.querySelector("button")).toBeTruthy();
    expect(c.directorySecurityNotices).toHaveBeenCalledTimes(2);
  });
  it("does not optimistically acknowledge or replay an ambiguous write", async () => {
    const wait = held(), c = fake({ acknowledgeDirectorySecurityNotice: vi.fn(() => wait.promise) }), p = await mount(c);
    fire(button(p, "Acknowledge"), "click"); fire(button(p, "Acknowledge"), "click"); await settle(5);
    expect(c.acknowledgeDirectorySecurityNotice).toHaveBeenCalledTimes(1);
    expect(p.root.textContent).not.toContain("Acknowledged");
    wait.release({ ok: false, code: "unreachable" }); await settle(15);
    expect(p.root.textContent).toContain("couldn't confirm the acknowledgment");
    expect(button(p, "Acknowledge")).toBeTruthy(); expect(c.acknowledgeDirectorySecurityNotice).toHaveBeenCalledTimes(1);
  });
  it("retains already shown history on a failed read, but clears it when authority is refused", async () => {
    const c = fake(), p = await mount(c);
    c.directorySecurityNotices.mockResolvedValueOnce({ ok: false, status: 503 }); await click(p, "Refresh");
    expect(p.root.querySelectorAll("[data-directory-notice]")).toHaveLength(1);
    c.directorySecurityNotices.mockResolvedValueOnce({ ok: false, status: 403 }); await click(p, "Retry");
    expect(p.root.querySelectorAll("[data-directory-notice]")).toHaveLength(0);
    expect(p.root.textContent).toContain("can't read");
  });
  it("does not publish a read from an unmounted or replaced client", async () => {
    const wait = held(), a = fake({ directorySecurityNotices: vi.fn(() => wait.promise) }), b = fake({ directorySecurityNotices: vi.fn(async () => ({ ok: true, items: [], nextBefore: null })) });
    const p = await mount(a); await p.mount(h(ui.DirectoryNotices, { client: b })); await settle(15);
    wait.release({ ok: true, items: [row()], nextBefore: ID }); await settle(15);
    expect(p.root.querySelectorAll("[data-directory-notice]")).toHaveLength(0); expect(p.root.textContent).toContain("No AD connection notices");
  });
  it("does not let an old acknowledgment change a successor client's identical notice ID", async () => {
    const wait = held(), a = fake({ acknowledgeDirectorySecurityNotice: vi.fn(() => wait.promise) }), b = fake();
    const p = await mount(a); fire(button(p, "Acknowledge"), "click"); await settle(5);
    await p.mount(h(ui.DirectoryNotices, { client: b })); await settle(15); wait.release({ ok: true }); await settle(15);
    expect(button(p, "Acknowledge")).toBeTruthy(); expect(p.root.textContent).not.toContain("Acknowledged");
  });
  it.each([[3, 3000], [0, 10000], [undefined, 10000]])("honors busy Retry-After %s, clears and fences the timer after unmount", async (seconds, delay) => {
    const c = fake({ directorySecurityNotices: vi.fn(async () => ({ ok: false, code: "backpressure", retryAfter: seconds })) }), p = await mount(c);
    let retry!: () => void;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => { if (ms === delay) { retry = fn; return 999; } return setImmediate(fn); }) as any);
    const cleared = vi.spyOn(globalThis, "clearTimeout"); await click(p, "Retry");
    expect(timeout.mock.calls.some(call => call[1] === delay)).toBe(true); expect(p.root.textContent).toContain("busy");
    const reads = c.directorySecurityNotices.mock.calls.length; await p.unmount();
    expect(cleared).toHaveBeenCalledWith(999); retry(); await settle(5); expect(c.directorySecurityNotices).toHaveBeenCalledTimes(reads);
  });
  it("a busy ACK is never retried by a timer", async () => {
    const c = fake({ acknowledgeDirectorySecurityNotice: vi.fn(async () => ({ ok: false, code: "backpressure", retryAfter: 3 })) }), p = await mount(c);
    await click(p, "Acknowledge"); expect(p.root.textContent).toContain("Try Acknowledge again");
    expect(c.acknowledgeDirectorySecurityNotice).toHaveBeenCalledTimes(1); expect(button(p, "Acknowledge")).toBeTruthy();
  });
  it("a missing old-server route has a visible reload exit", async () => {
    const c = fake({ directorySecurityNotices: vi.fn(async () => ({ ok: false, status: 404 })) }), p = await mount(c);
    expect(p.root.textContent).toContain("Reload this page"); expect(c.directorySecurityNotices).toHaveBeenCalledTimes(1);
  });
});

describe("capability skew and private API adapters", () => {
  it("requires both the server feature and the client methods, independent of group/admin permission", () => {
    const c = { ...fake(), directorySecurityNoticesV1: true }, s = { features: ["directory-security-notices-v1"], admin: false };
    expect(ui.directoryNoticesOffered(s, c)).toBe(true);
    expect(ui.directoryNoticesOffered({ features: [] }, c)).toBe(false);
    expect(ui.directoryNoticesOffered(s, { ...c, directorySecurityNoticesV1: false })).toBe(false);
    expect(ui.directoryNoticesOffered(s, { ...c, acknowledgeDirectorySecurityNotice: undefined })).toBe(false);
  });
  it("uses only a local host display mark, never Hub or public-link marks", async () => {
    const p = page(); pages.push(p); const body = p.document.body;
    expect(host.hostDirectoryNoticesOffered()).toBe(false);
    body.dataset.hubDirectoryNotices = "1"; expect(host.hostDirectoryNoticesOffered()).toBe(true);
    body.dataset.publicLink = "1"; expect(host.hostDirectoryNoticesOffered()).toBe(false);
    delete body.dataset.publicLink; body.dataset.hub = "hub"; expect(host.hostDirectoryNoticesOffered()).toBe(false);
  });
  it("the Hub client uses its CSRF-bound same-origin API and exact older anchor", async () => {
    const fetchImpl = vi.fn(async (_path: string, _init?: any) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ signedIn: true, csrf: "hub-csrf", items: [] }) }));
    const c = hub.createHubWebClient({ fetchImpl }); await c.session();
    await c.directorySecurityNotices({ before: OLD, limit: 25 }); await c.acknowledgeDirectorySecurityNotice(OLD);
    expect(fetchImpl.mock.calls[1][0]).toBe(`/hub/v1/security-notices/directory?limit=25&before=${OLD}`);
    expect(fetchImpl.mock.calls[2]).toEqual([`/hub/v1/security-notices/directory/${OLD}/ack`, expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", headers: expect.objectContaining({ "X-AgEnD-Hub-CSRF": "hub-csrf" }) })]);
  });
  it("the host adapter preserves Retry-After and uses the fleet path, never the Hub API", async () => {
    const fetchImpl = vi.fn(async (_path: string, _init?: any) => ({ ok: false, status: 429, headers: { get: () => "3" }, json: async () => ({ error: "backpressure" }) }));
    const c = host.createHostDirectoryNoticeClient({ fetchImpl });
    expect(await c.directorySecurityNotices({ before: OLD })).toMatchObject({ ok: false, status: 429, code: "backpressure", retryAfter: 3 });
    await c.acknowledgeDirectorySecurityNotice(ID);
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/settings/hub/security-notices/directory?limit=25&before=${OLD}`);
    expect(fetchImpl.mock.calls[1]).toEqual([`/api/settings/hub/security-notices/directory/${ID}/ack`, expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store" })]);
  });
});
