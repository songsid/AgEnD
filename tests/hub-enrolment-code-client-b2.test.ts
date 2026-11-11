/** Inert fetch at the production Hub client boundary; no network, accounts or credentials. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "./helpers/app-harness.js";
let create: any;
beforeAll(async () => { const p = page(); create = (await import("/ui/js/hub-client.js")).createHubWebClient; p.restore(); });
describe("B2 code management through the Hub's same-origin client", () => {
  it("uses the current session's CSRF and exact CRUD routes without a code in the URL", async () => {
    const calls: any[] = [], fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, headers: new Headers(), json: async () => url.endsWith("session")
        ? { signedIn: true, csrf: "inert-current-session" } : { codes: [] } };
    });
    const c = create({ fetchImpl }); await c.session();
    expect(c.enrolmentCodeV1).toBe(true);
    await c.enrolmentCodes(); const input = { expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } };
    await c.createEnrolmentCode(input); await c.revokeEnrolmentCode("owned/id");
    expect(calls.slice(1).map(c => [c.url, c.init.method])).toEqual([
      ["/hub/v1/admin/enrolment-codes", "GET"], ["/hub/v1/admin/enrolment-codes", "POST"],
      ["/hub/v1/admin/enrolment-codes/owned%2Fid/revoke", "POST"],
    ]);
    expect(JSON.parse(calls[2].init.body)).toEqual(input); expect(JSON.parse(calls[3].init.body)).toEqual({});
    for (const { init } of calls.slice(1)) { expect(init.credentials).toBe("same-origin"); expect(init.cache).toBe("no-store"); }
    expect(calls[2].init.headers["X-AgEnD-Hub-CSRF"]).toBe("inert-current-session");
    expect(calls[3].init.headers["X-AgEnD-Hub-CSRF"]).toBe("inert-current-session");
  });
  it("a signed-out read retires the session and cannot leave the prior CSRF on a write", async () => {
    const calls: any[] = [], off = vi.fn(); let n = 0;
    const c = create({ fetchImpl: vi.fn(async (_url: string, init: any) => {
      calls.push(init); const status = ++n === 2 ? 401 : 200;
      return { ok: status === 200, status, headers: new Headers(), json: async () => n === 1 ? { signedIn: true, csrf: "old-session" } : { code: "denied" } };
    }) });
    c.onSignedOut(off); await c.session(); expect((await c.enrolmentCodes()).ok).toBe(false);
    await c.createEnrolmentCode({}); expect(off).toHaveBeenCalledOnce(); expect(calls[2].headers["X-AgEnD-Hub-CSRF"]).toBeUndefined();
  });
  it("code-aware notices require both an explicit UI opt-in and this session's server capability", async () => {
    let features: string[] = [];
    const calls: string[] = [], streams: string[] = [];
    class Stream { constructor(url: string) { streams.push(url); } addEventListener() {} close() {} }
    vi.stubGlobal("EventSource", Stream);
    try {
      const c = create({ fetchImpl: vi.fn(async (url: string) => {
        calls.push(url); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ signedIn: true, csrf: "inert", features, notices: [] }) };
      }) });
      await c.session(); await c.pairingNotices(3); expect(calls.at(-1)).toBe("/hub/v1/notices?v=2");
      features = ["enrolment-code-v1"]; await c.session();
      await c.pairingNotices(); expect(calls.at(-1)).toBe("/hub/v1/notices?v=2");
      await c.pairingNotices(3); expect(calls.at(-1)).toBe("/hub/v1/notices?v=3");
      expect(c.pairingNoticesV3).toBe(true);
      c.subscribePairingNotices(() => {})(); c.subscribePairingNotices(() => {}, () => {}, 3)();
      expect(streams).toEqual(["/hub/v1/notices/events?v=2", "/hub/v1/notices/events?v=3"]);
    } finally { vi.unstubAllGlobals(); }
  });
});
