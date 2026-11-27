/**
 * M-3680 (the user, 11-25; decision 7933bf90: an admin session has the same features on every link): Fleet › 授權, an
 * agent's Permissions tab and Needs you's Approve read and write /ui/api/contact-authorizations and
 * /ui/api/instances/<n>/contact-permissions — routes the public link's list did not have, so the fixed link answered 404
 * and the page said only 「無法載入權限。」.
 *  - The gateway passes them on (and still nothing else under /ui/api/); the handler admits a verified admin only.
 *  - With no verified admin behind the session, the handler says `verification-required`, and both pages say to verify in
 *    Sign-in status, not "only this agent's managers" nor "couldn't load".
 */
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleContactAuthorizationApi, type ContactApiHost } from "../src/contact-auth-api.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const TICKET = "R39dd137e-1234-4321-abcd-123456789012";
const ROUTES = [
  ["GET", "/ui/api/contact-authorizations"], ["GET", "/ui/api/contact-authorizations?status=pending"], ["GET", `/ui/api/contact-authorizations/${TICKET}`],
  ["POST", `/ui/api/contact-authorizations/${TICKET}/decision`],
  ["GET", "/ui/api/instances/agend-dev-sol/contact-permissions"], ["PUT", "/ui/api/instances/agend-dev-sol/contact-permissions"],
  ["POST", "/ui/api/instances/agend-dev-sol/contact-permissions/origin-clear"],
] as const;

describe("the public link routes contact permissions and requests (decision 7933bf90)", () => {
  it.each(ROUTES)("%s %s is on the list", (method, path) => {
    expect(isPublicWebRoute(method, path.split("?")[0]!)).toBe(true);
  });
  it("only those: other methods, other ids and the rest of /ui/api/ stay off", () => {
    for (const [m, p] of [
      ["DELETE", "/ui/api/contact-authorizations"], ["POST", "/ui/api/contact-authorizations"], ["PUT", `/ui/api/contact-authorizations/${TICKET}`],
      ["GET", `/ui/api/contact-authorizations/${TICKET}/decision`], ["POST", "/ui/api/contact-authorizations/not-a-ticket/decision"],
      ["POST", "/ui/api/instances/agend-dev-sol/contact-permissions"], ["DELETE", "/ui/api/instances/agend-dev-sol/contact-permissions"],
      ["GET", "/ui/api/instances/agend-dev-sol/contact-permissions/origin-clear"], ["GET", "/ui/api/instances/a/b/contact-permissions"],
      ["GET", "/ui/api/instances"], ["GET", "/ui/api/other"],
    ] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
  });
  it("the real gateway dispatches them to the dashboard (before: a 404 at the gateway, never dispatched)", () => {
    let callback!: (req: IncomingMessage, res: ServerResponse) => void;
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn(), setTimeout: vi.fn() }), dispatch = vi.fn();
    const gateway = createPublicWebGateway({ exposureId: "e".repeat(32), isCurrent: () => true, isOpen: () => true, dispatch,
      create: ((handler: typeof callback) => { callback = handler; return server; }) as never });
    gateway.setHost("gateway-fixture.trycloudflare.com");
    for (const [method, path] of ROUTES) {
      const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "gateway-fixture.trycloudflare.com" }, socket: { remoteAddress: "198.51.100.7", encrypted: true } });
      let status = 0; const res = { headersSent: false, destroyed: false, writableEnded: false, setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: vi.fn(), destroy: vi.fn() };
      dispatch.mockClear();
      callback(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect([method, path, dispatch.mock.calls.length, status]).toEqual([method, path, 1, 0]);
    }
  });
});

describe("no verified admin behind the session: the handler says so", () => {
  it.each(ROUTES)("%s %s: 403 verification-required, nothing read or written", async (method, path) => {
    const host = { contactActor: vi.fn(() => null), contactPermissions: vi.fn(), writeContactPermissions: vi.fn(), clearContactOrigin: vi.fn(),
      contactAuthorization: vi.fn(), contactAuthorizations: vi.fn(), decideContactAuthorization: vi.fn() };
    const req = Readable.from(["{}"]) as unknown as IncomingMessage;
    req.method = method; req.url = path; req.headers = { host: "localhost" };
    let code = 0, body = "";
    const res = { destroyed: false, writableEnded: false, writeHead: (c: number) => { code = c; }, end: (v?: unknown) => { body = String(v ?? ""); } };
    expect(handleContactAuthorizationApi(req, res as unknown as ServerResponse, new URL(path, "http://localhost"), host as unknown as ContactApiHost)).toBe(true);
    expect([code, JSON.parse(body)]).toEqual([403, { error: "verification-required" }]);
    for (const fn of Object.values(host)) if (fn !== host.contactActor) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the pages say to verify, in en and zh-TW", () => {
  const g = globalThis as any, realFetch = g.fetch, mounted: AppPage[] = [];
  afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } g.fetch = realFetch; });
  const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  async function show(which: "list" | "agent", language: "en" | "zh-TW", answer: { status: number; body: unknown }) {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/authorizations", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    // M-3736 J: a host without the same-card route (it answers 404), as every host is until slice L installs it.
    g.fetch = async (url: string) => (String(url).startsWith("/ui/api/request-contact-authorizations") ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: answer.status < 400, status: answer.status, json: async () => answer.body });
    (await import("/assets/app-i18n.js") as any).setLang(language);
    const store = await import("/assets/app-store.js") as any;
    store.appStore.set({ streamOn: () => () => {}, instances: [{ name: "agend-dev-sol" }] });
    const Comp = which === "list" ? (await import("/ui/js/contact-authorizations.js") as any).ContactAuthorizations : (await import("/ui/js/contact-permissions.js") as any).ContactPermissionsPanel;
    await pg.mount(h(Comp, which === "list" ? {} : { name: "agend-dev-sol" }));
    await settle(6);
    return text(pg.root);
  }
  const VERIFY = { en: "Permissions and contact requests need a verified administrator. Authorize this browser, then try again.",
    "zh-TW": "權限和聯絡申請需要已驗證的管理員。請先授權這個瀏覽器，再試一次。" } as const;
  it.each([["list", "en"], ["list", "zh-TW"], ["agent", "en"], ["agent", "zh-TW"]] as const)("%s page, %s: verification-required says where to verify", async (which, language) => {
    const said = await show(which, language, { status: 403, body: { error: "verification-required" } });
    expect(said).toContain(VERIFY[language]);
    expect(said).not.toMatch(/Couldn't load permissions|無法載入權限|Only this agent's managers|只有這個 Agent 的管理員/);
  });
  it("a plain 403 (a manager-only read) still says only managers may see it", async () => {
    expect(await show("agent", "en", { status: 403, body: { error: "forbidden" } })).toContain("Only this agent's managers can see its permissions.");
  });
  it("Needs you's request title names the agents as the page does (their display names)", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    g.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    (await import("/assets/app-i18n.js") as any).setLang("en");
    const store = await import("/assets/app-store.js") as any;
    store.appStore.set({ streamOn: () => () => {}, instances: [{ name: "lead", display_name: "Example lead" }, { name: "worker", display_name: "Example worker" }] });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    await pg.mount(h(ContactNeedsItem, { item: { id: `contact:${TICKET}`, type: "contact", reason: "contact_request", instance: "worker", since: 0,
      contactTicket: { id: TICKET, source: "lead", target: "worker" } } }));
    await settle(4);
    expect(text(pg.root.querySelector(".n-title"))).toBe("Example lead wants to contact Example worker");
  });
});
