/** Inert fetch at the production Hub client boundary; no network, accounts or credentials. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "./helpers/app-harness.js";
let create: any, member: any;
beforeAll(async () => { const p = page(); const module = await import("/ui/js/hub-client.js"); create = module.createHubWebClient; member = module.createMemberClient; p.restore(); });
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
  it.each(["401", "signOut"])("retires the prior session's notice capability after %s", async retirement => {
    const urls: string[] = [], streams: string[] = [];
    class Stream { constructor(url: string) { streams.push(url); } addEventListener() {} close() {} }
    vi.stubGlobal("EventSource", Stream);
    try {
      const response = (status: number, body: Record<string, unknown>) => ({ ok: status === 200, status,
        headers: new Headers(), json: async () => body });
      const fetchImpl = vi.fn(async (url: string) => {
        urls.push(url); return response(200, { signedIn: true, csrf: "inert", features: ["enrolment-code-v1"], notices: [] });
      });
      const c = create({ fetchImpl }); await c.signIn("fixture", "inert");
      await c.pairingNotices(3); expect(urls.at(-1)).toBe("/hub/v1/notices?v=3");
      if (retirement === "401") {
        fetchImpl.mockImplementationOnce(async (url: string) => {
          urls.push(url); return response(401, { code: "denied" });
        });
        expect((await c.enrolmentCodes()).status).toBe(401);
      } else await c.signOut();
      await c.pairingNotices(3); expect(urls.at(-1)).toBe("/hub/v1/notices?v=2");
      c.subscribePairingNotices(() => {}, () => {}, 3)();
      expect(streams).toEqual(["/hub/v1/notices/events?v=2"]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("B2 member notice version is leased by the current renderer", () => {
  const rows = [{ id: "legacy" }, { source: "group" }, { source: "manual" }, { source: "code" }];
  function rig(old = false) {
    const urls: string[] = [], confirm = { api: vi.fn(async (url: string) => {
      urls.push(url); return { ok: true, body: { pairing: { state: "unpaired" }, notices: !old && url.endsWith("notices=3") ? rows : rows.slice(0, 3) } };
    }) };
    return { client: member({ confirm }), confirm, urls };
  }
  it("default callers stay v2; an explicit renderer lease opts in, with v2 preserved for an older host", async () => {
    for (const old of [false, true]) {
      const r = rig(old); await r.client.pairing(); expect(r.urls).toEqual(["/api/hub/member/pairing?v=2"]);
      const release = r.client.usePairingNoticeVersion(3); await r.client.pairing();
      expect(r.urls.at(-1)).toBe("/api/hub/member/pairing?v=2&notices=3"); expect(r.client.pairingNotices()).toHaveLength(old ? 3 : 4);
      release(); expect(r.client.pairingNotices().some((n: any) => n.source === "code")).toBe(false);
      await r.client.pairing(); expect(r.urls.at(-1)).toBe("/api/hub/member/pairing?v=2");
    }
  });
  it("two renderer leases remain v3 until the last one retires; release is idempotent", async () => {
    const r = rig(), a = r.client.usePairingNoticeVersion(3), b = r.client.usePairingNoticeVersion(3);
    a(); a(); await r.client.pairing(); expect(r.urls.at(-1)).toContain("notices=3");
    b(); await r.client.pairing(); expect(r.urls.at(-1)).not.toContain("notices=3");
  });
  it("an outstanding v3 read cannot restore code rows after its renderer retires", async () => {
    const r = rig(), release = r.client.usePairingNoticeVersion(3); let done!: (value: any) => void;
    r.confirm.api.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = r.client.pairing(); release();
    done({ ok: true, body: { pairing: { state: "unpaired" }, notices: rows } }); await pending;
    expect(r.client.pairingNotices()).toEqual([]);
  });
  it("an older v2 read cannot overwrite a newer code-aware snapshot", async () => {
    const r = rig(); let done!: (value: any) => void;
    r.confirm.api.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const older = r.client.pairing(), release = r.client.usePairingNoticeVersion(3); await r.client.pairing();
    done({ ok: true, body: { pairing: { state: "unpaired" }, notices: rows.slice(0, 3) } }); await older;
    expect(r.client.pairingNotices()).toHaveLength(4); release();
  });
  it("a default reader does not publish an unexpected code row from its response", async () => {
    const r = rig(); r.confirm.api.mockResolvedValueOnce({ ok: true, body: { pairing: { state: "unpaired" }, notices: rows } });
    await r.client.pairing(); expect(r.client.pairingNotices()).toEqual(rows.slice(0, 3));
  });
});
