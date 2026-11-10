/** Start's narrowly scoped host consent and detached, private requester/confirmer capability. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { settingsRequestExecution, settingsRequestJoinAuthority } from "../src/settings-request-capability.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { companyJoinSession } from "../src/hub/join/fleet-authority.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function harness(hostHere: boolean, feature = true) {
  let requester = true, confirmer = true;
  const session = { ownerKey: {}, sessionId: "a".repeat(64), authorityEpoch: 1, hostHere, current: () => requester };
  const notify = vi.fn(), store = new SettingsConfirmationStore({ audit: vi.fn(), notify }); stores.push(store);
  const captured: any[] = [];
  const baseline = { config: { defaults: {}, instances: {} } as any, classic: {}, fingerprint: "unchanged" };
  const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: session.sessionId, label: "Host", source: "web_session", current: () => requester,
    localAdmin: () => requester, localSession: session }), baseline: async () => baseline, snapshot: () => "constant", directCompanyJoin: feature, selfConfirm: () => null });
  const req = new EventEmitter() as any; req.method = "POST"; req.url = "/api/hub/member/company-join/start"; req.headers = { cookie: "private", "idempotency-key": "start-once" }; req.destroy = () => {};
  const response = new Promise<any>(resolve => {
    const res = { destroyed: false, headersSent: false, setHeader: vi.fn(), writeHead() { this.headersSent = true; }, end(text: string) { resolve(JSON.parse(text)); } } as any;
    gate.handle(req, res, new URL(req.url, "http://127.0.0.1:4444"), (replay, output) => {
      captured.push({ authority: settingsRequestJoinAuthority(replay), execution: settingsRequestExecution(replay), headers: replay.headers });
      output.writeHead(200); output.end(JSON.stringify({ ok: true, operation: { operationId: "original-op" } })); return true;
    });
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify({ address: "https://hub.example.test", label: "My Fleet" }))); req.emit("end"); });
  });
  const first = await response;
  return { first, store, session, notify, captured, lose: () => { requester = false; }, deny: () => { confirmer = false; },
    decide: () => store.decide(first.pending_change.id, "confirm", { label: "General admin", current: () => confirmer }) };
}
describe("company Start Settings authority", () => {
  it("only an actual local cookie session creates the private capability; loopback/header/forwarding never grant host authority", () => {
    const token = "d".repeat(48), sessions = new WebSessionStore(), issued = sessions.create({ tier: "admin", surface: "local", host: true, label: "host", tokenEpoch: tokenEpoch(token) });
    const input = { token, sessions, config: null, epoch: 1, current: () => true };
    const req = (headers = {}, remoteAddress = "127.0.0.1"): any => ({ method: "POST", socket: { remoteAddress }, headers: { host: "127.0.0.1:4444", origin: "http://127.0.0.1:4444", cookie: `agend_session=${issued.sessionId}`, "x-agend-csrf": csrfTokenFor(issued.sessionId), ...headers } });
    const own = companyJoinSession(req(), input)!; expect(own.hostHere).toBe(true); expect(own.fleetOrigin).toBe("http://127.0.0.1:4444");
    expect(companyJoinSession(req({ cookie: "", "x-agend-token": token }), input)).toBeNull();
    expect(companyJoinSession(req({ origin: "null" }), input)).toBeNull();
    expect(companyJoinSession(req({ host: "evil.test", origin: "https://evil.test" }), input)).toBeNull();
    expect(companyJoinSession(req({ "x-forwarded-for": "192.0.2.2" }), input)?.hostHere).toBe(false);
    const publicReq = req(); bindGatewayRequest(publicReq, { surface: "gateway", exposureId: "test", expectedOrigin: "https://public.example", isCurrent: () => true });
    expect(companyJoinSession(publicReq, input)).toBeNull();
    sessions.revokeByHandle(issued.record.handle); expect(own.current()).toBe(false);
  });
  it("the original host Start auto-claims before General notification and its private capability remains current after Settings completes", async () => {
    const h = await harness(true);
    await vi.waitFor(() => expect(h.store.get(h.first.pending_change.id, h.session.sessionId)?.state).toBe("applied"));
    expect(h.notify.mock.calls.some(([view]) => view.state === "pending")).toBe(false); expect(h.captured).toHaveLength(1);
    const c = h.captured[0]; expect(c.headers.cookie).toBeUndefined(); expect(c.authority.session).toBe(h.session);
    expect(c.execution.current()).toBe(false); expect(c.authority.confirmedCurrent()).toBe(true); expect(c.authority.session.current()).toBe(true);
    h.lose(); expect(c.authority.session.current()).toBe(false); expect(c.authority.confirmedCurrent()).toBe(false);
  });
  it.each([[false, true], [true, false]])("nonhost or a composition without the new scoped feature remains held (%s, %s)", async (host, feature) => {
    const h = await harness(host, feature); await Promise.resolve();
    expect(h.first.pending_change.state).toBe("pending"); expect(h.captured).toHaveLength(0); expect(h.notify).toHaveBeenCalledOnce();
    const done = await h.decide(); expect(done.state).toBe("applied");
    const c = h.captured[0]; expect(c.authority.session).toBe(h.session); expect(c.execution.current()).toBe(false);
    expect(c.authority.confirmedCurrent()).toBe(true); h.deny(); expect(c.authority.confirmedCurrent()).toBe(false);
  });
  it("company Start stays outward-Hub sensitive and rejects browser-supplied authority/origin/redirect fields", () => {
    const context = { config: { defaults: {}, instances: {} } as any, classic: {} };
    const body = { address: "https://hub.example.test", label: "My Fleet" };
    expect(prepareSettingsEffect("POST", "/api/hub/member/company-join/start", body, context).diff).toMatchObject({ authority: { primaryGeneral: true, connections: [] } });   // AGEND-122: still the Hub's authority scope, no longer host-only
    expect(prepareSettingsEffect("POST", "/api/hub/member/company-join/start", body, context).diff).not.toHaveProperty("noSelfConfirm");
    for (const extra of [{ fleetOrigin: "https://victim.test" }, { hostHere: true }, { return_to: "https://evil.test" }]) {
      expect(() => prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...body, ...extra }, context)).toThrow();
    }
    expect(settingsRequestJoinAuthority({ headers: { cookie: "private", hostHere: true } })).toBeUndefined();
  });
});
