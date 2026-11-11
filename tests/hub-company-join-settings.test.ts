/** Start's narrowly scoped host consent and detached, private requester/confirmer capability. */
import { FleetManager } from "../src/fleet-manager.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { settingsRequestExecution, settingsRequestJoinAuthority } from "../src/settings-request-capability.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { randomUUID } from "node:crypto";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { companyJoinSession } from "../src/hub/join/fleet-authority.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function harness(hostHere: boolean, feature = true, policy = true) {
  let requester = true, confirmer = true, policyCurrent = policy;
  const session = { ownerKey: {}, sessionId: "a".repeat(64), authorityEpoch: 1, hostHere, current: () => requester };
  const notify = vi.fn(), asked = vi.fn(() => null), store = new SettingsConfirmationStore({ audit: vi.fn(), notify }); stores.push(store);
  const captured: any[] = [];
  const baseline = { config: { defaults: {}, instances: {} } as any, classic: {}, fingerprint: "unchanged" };
  const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: session.sessionId, label: "Host", source: "web_session", current: () => requester,
    localAdmin: () => requester, localSession: session }), baseline: async () => baseline, snapshot: () => "constant", directCompanyJoin: feature, companyJoinPolicy: () => policyCurrent, totp: { state: () => "ready", confirm: () => ({ error: "wrong" }) }, selfConfirm: asked });
  const send = () => {
   const req = new EventEmitter() as any; req.method = "POST"; req.url = "/api/hub/member/company-join/start"; req.headers = { cookie: "private", "idempotency-key": "start-once" }; req.destroy = () => {};
   return new Promise<any>(resolve => {
    const res = { destroyed: false, headersSent: false, setHeader: vi.fn(), writeHead() { this.headersSent = true; }, end(text: string) { resolve(JSON.parse(text)); } } as any;
    gate.handle(req, res, new URL(req.url, "http://127.0.0.1:4444"), (replay, output) => {
      captured.push({ authority: settingsRequestJoinAuthority(replay), execution: settingsRequestExecution(replay), headers: replay.headers });
      output.writeHead(200); output.end(JSON.stringify({ ok: true, operation: { operationId: "original-op" } })); return true;
    });
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify({ address: "https://hub.example.test", label: "My Fleet" }))); req.emit("end"); });
   });
  };
  const first = await send();
  return { first, send, store, session, notify, asked, captured, revokePolicy: () => { policyCurrent = false; }, lose: () => { requester = false; }, deny: () => { confirmer = false; },
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
    for (const tier of ["guest", "read"] as const) {
      const other = sessions.create({ tier, surface: "local", owner: { adapterId: "test", userId: tier }, label: tier, tokenEpoch: tokenEpoch(token) });
      expect(companyJoinSession(req({ cookie: `agend_session=${other.sessionId}` }), input)).toBeNull();
    }
    sessions.revokeByHandle(issued.record.handle); expect(own.current()).toBe(false);
  });
  it.each([true, false])("a signed-in Fleet admin Start is consent, with no held card or General wait (host=%s)", async host => {
    const h = await harness(host);
    expect(h.first.pending_change).toMatchObject({ presentation: "hub-join" });
    expect(h.first.pending_change.state).not.toBe("pending");
    await vi.waitFor(() => expect(h.store.get(h.first.pending_change.id, h.session.sessionId)?.state).toBe("applied"));
    expect(h.notify.mock.calls.some(([view]) => view.state === "pending")).toBe(false); expect(h.captured).toHaveLength(1);
    const c = h.captured[0]; expect(c.headers.cookie).toBeUndefined(); expect(c.authority.session).toBe(h.session);
    expect(c.execution.current()).toBe(false); expect(c.authority.confirmedCurrent()).toBe(true); expect(c.authority.session.current()).toBe(true);
    h.revokePolicy(); expect(c.authority.confirmedCurrent()).toBe(false);
    h.lose(); expect(c.authority.session.current()).toBe(false); expect(c.authority.confirmedCurrent()).toBe(false);
  });
  it("a composition without the scoped feature keeps its previous confirmation path", async () => {
    const h = await harness(true, false); await Promise.resolve();
    expect(h.first.pending_change.state).toBe("pending"); expect(h.captured).toHaveLength(0); expect(h.notify).toHaveBeenCalledOnce();
    const done = await h.decide(); expect(done.state).toBe("applied");
    const c = h.captured[0]; expect(c.authority.session).toBe(h.session); expect(c.execution.current()).toBe(false);
    expect(c.authority.confirmedCurrent()).toBe(true); h.deny(); expect(c.authority.confirmedCurrent()).toBe(false);
  });
  it.each([true, false])("an enforced admin code stays inline and never posts a General card (host=%s)", async host => {
    const h = await harness(host, true, false); await Promise.resolve();
    expect(h.first.pending_change).toMatchObject({ state: "pending", presentation: "hub-join", totp: "ready" });
    expect(h.captured).toHaveLength(0); expect(h.notify).not.toHaveBeenCalled();
  });
  it("replaying the same code-protected Start keeps its digest without asking for consent again", async () => {
    const h = await harness(false, true, false), again = await h.send();
    expect(h.first.pending_change.confirm_digest).toEqual(expect.stringMatching(/\S+/));
    expect(again.pending_change).toMatchObject({ id: h.first.pending_change.id, state: "pending", presentation: "hub-join", totp: "ready", confirm_digest: h.first.pending_change.confirm_digest });
    expect(h.asked).not.toHaveBeenCalled(); expect(h.captured).toHaveLength(0); expect(h.notify).not.toHaveBeenCalled();
  });
  it.each([false, true])("company consent retains this admin’s enforced code even with message authority disabled (%s)", enforced => {
    const req = {} as any, role = { ok: true, onHost: false, actor: { adapter_id: "test", user_id: "admin" } };
    const owner = { settingsRole: vi.fn(() => ({ role })), strictFor: vi.fn(() => enforced) };
    const allowed = (FleetManager.prototype as any).settingsCompanyJoinAllowed.call(owner, req);
    expect(allowed).toBe(!enforced); expect(owner.settingsRole).toHaveBeenCalledWith(req, { ignoreSwitch: true });
    owner.settingsRole.mockReturnValue({ role: { ok: false } } as any);
    expect((FleetManager.prototype as any).settingsCompanyJoinAllowed.call(owner, req)).toBe(false);
  });
  it("company Start stays outward-Hub sensitive and rejects browser-supplied authority/origin/redirect fields", () => {
    const context = { config: { defaults: {}, instances: {} } as any, classic: {} };
    const body = { address: "https://hub.example.test", label: "My Fleet" };
    expect(prepareSettingsEffect("POST", "/api/hub/member/company-join/start", body, context).diff).toMatchObject({ authority: { primaryGeneral: true, connections: [] } });   // AGEND-122: still the Hub's authority scope, no longer host-only
    expect(prepareSettingsEffect("POST", "/api/hub/member/company-join/start", body, context).diff).not.toHaveProperty("noSelfConfirm");
    for (const extra of [{ fleetOrigin: "https://victim.test" }, { hostHere: true }, { return_to: "https://evil.test" }, { codePolicy: { kind: "company-start" } }, { presentation: "hub-join" }]) {
      expect(() => prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...body, ...extra }, context)).toThrow();
    }
    expect(settingsRequestJoinAuthority({ headers: { cookie: "private", hostHere: true } })).toBeUndefined();
  });
  it("M-2921: Start takes an enrolment code in the B1 alphabet only; reconnect and 「移除這個連接」 are held Hub changes for exactly one pairing", () => {
    const context = { config: { defaults: {}, instances: {} } as any, classic: {} };
    const start = { address: "https://hub.example.test", label: "My Fleet" };
    expect(isSettingsMutation("POST", "/api/hub/member/company-join/start")).toBe(true);
    expect(prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...start, code: "abcd-ef01" }, context).diff).toBeTruthy();
    for (const code of ["ABCO-EF01", "ABCD-EF0", 12345678]) expect(() => prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...start, code }, context)).toThrow();
    const pairing = { hubId: randomUUID(), binding: "a".repeat(64), address: "https://hub.example.test" };
    for (const step of ["reconnect", "remove"]) {
      const path = `/api/hub/member/company-join/${step}`;
      expect(isSettingsMutation("POST", path)).toBe(true);
      const diff = prepareSettingsEffect("POST", path, pairing, context).diff!;
      expect(diff).toMatchObject({ authority: { primaryGeneral: true, connections: [] } });
      expect(JSON.stringify(diff.summary_i18n)).toContain(`hub.companyJoin.${step}`);
      if (step === "reconnect") expect(prepareSettingsEffect("POST", path, { ...pairing, handoffId: randomUUID() }, context).diff).toBeTruthy();
      else expect(() => prepareSettingsEffect("POST", path, { ...pairing, handoffId: randomUUID() }, context)).toThrow();
      for (const bad of [{ ...pairing, handoffId: "x" }, { ...pairing, binding: "z" }, { ...pairing, hubId: "x" }, { hubId: pairing.hubId, binding: pairing.binding }, { ...pairing, address: "http://hub.example.test" },
        { ...pairing, label: "x" }, { ...pairing, fleetOrigin: "https://victim.test" }]) expect(() => prepareSettingsEffect("POST", path, bad, context)).toThrow();
    }
  });
});
