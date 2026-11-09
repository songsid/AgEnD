/**
 * alpha.6 #2c (hmsg-468cc290), reworked by AGEND-122 (upstream #3486): POST /api/settings/pending/:id/confirm-totp, the route itself.
 * It no longer refuses a link request up front — the fleet decides who may confirm with a code (settingsCodeSession: a change that
 * opens a link is never code-confirmed over a link, answered `not_here` like any other refusal); a bounded body with the code and
 * this change's digest; each refusal its own status (wrong 401, changed 409, paused 429 with Retry-After, not here 403); a correct
 * code decides the change once — over a link too, when the fleet says it may.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function rig(answer: any) {
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
  const view = store.propose({ session: "me", key: "k", bytes: 1, source: "web_session", section: "access", requestedBy: "me", fingerprint: "f".repeat(64),
    summary: ["Enable Hub membership"], affectedConnections: [], authority: { connections: [], primaryGeneral: true, unknown: false },
    current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
  const confirm = vi.fn(() => answer);
  const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: "me", label: "me", source: "web_session", current: () => true }),
    baseline: async () => ({ fingerprint: "b" } as any), snapshot: () => null, totp: { state: () => "ready", confirm } });
  const send = (body: unknown, o: { gateway?: boolean } = {}) => new Promise<{ status: number; headers: Record<string, string>; body: any }>((resolve) => {
    const req: any = Object.assign(new EventEmitter(), { method: "POST", url: `/api/settings/pending/${view.id}/confirm-totp`, headers: {} });
    if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: "https://x.example", isCurrent: () => true });
    const headers: Record<string, string> = {}; let status = 0;
    const res: any = { destroyed: false, headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v; }, writeHead: (s: number, h: any) => { status = s; Object.assign(headers, h); },
      end: (b: string) => resolve({ status, headers, body: JSON.parse(b) }) };
    expect(gate.handle(req, res, new URL(req.url, "http://localhost"), () => false)).toBe(true);
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
  return { store, view, apply, confirm, send };
}

describe("POST /api/settings/pending/:id/confirm-totp", () => {
  it("over a link: not refused up front — the fleet is asked (with the link's request) and its refusal is the answer; the change stays pending", async () => {
    const r = rig({ error: "not_here" });
    const out = await r.send({ code: "123456", digest: "d" }, { gateway: true });
    expect([out.status, out.body.error, r.confirm.mock.calls.length, r.store.get(r.view.id, "me")!.state, r.apply.mock.calls.length]).toEqual([403, "totp_confirm_unavailable", 1, "pending", 0]);
  });
  it("over a link, when the fleet allows it (an ordinary change, the owner signed in from outside): a correct code decides the change once", async () => {
    const r = rig({ label: "Authenticator code", current: () => true });
    const out = await r.send({ code: "123456", digest: "abc" }, { gateway: true });
    await vi.waitFor(() => expect(r.store.get(r.view.id, "me")!.state).toBe("applied"));
    expect([out.status, r.apply.mock.calls.length, r.confirm.mock.calls[0]!.slice(2)]).toEqual([202, 1, ["123456", "abc"]]);
  });
  it("a body without the code or the digest: 400, nothing checked", async () => {
    const r = rig({ label: "Authenticator code", current: () => true });
    expect([(await r.send({ code: "123456" })).status, (await r.send({ digest: "d" })).status]).toEqual([400, 400]);
    expect(r.confirm).not.toHaveBeenCalled();
  });
  it.each([
    [{ error: "wrong" }, 401, "wrong_code"], [{ error: "changed" }, 409, "confirmation_changed"],
    [{ error: "not_here" }, 403, "totp_confirm_unavailable"], [{ error: "unavailable" }, 503, "unavailable"],
  ])("%j → %i %s, still pending", async (answer, status, error) => {
    const r = rig(answer);
    const out = await r.send({ code: "123456", digest: "d" });
    expect([out.status, out.body.error, r.store.get(r.view.id, "me")!.state, r.apply.mock.calls.length]).toEqual([status, error, "pending", 0]);
  });
  it("paused: 429 with Retry-After, as the sign-in path shows it", async () => {
    const out = await rig({ error: "paused", retryAfterMs: 15 * 60_000 }).send({ code: "123456", digest: "d" });
    expect([out.status, out.headers["Retry-After"], out.body]).toEqual([429, "900", { error: "paused", retryAfterMs: 900000 }]);
  });
  it("a correct code: the change is decided (applied once), the code and digest passed through", async () => {
    const r = rig({ label: "Authenticator code", current: () => true });
    const out = await r.send({ code: "123456", digest: "abc" });
    await vi.waitFor(() => expect(r.store.get(r.view.id, "me")!.state).toBe("applied"));
    expect([out.status, r.apply.mock.calls.length, r.confirm.mock.calls[0]!.slice(2)]).toEqual([202, 1, ["123456", "abc"]]);
  });
});
