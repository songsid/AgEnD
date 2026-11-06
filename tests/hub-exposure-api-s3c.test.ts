/**
 * S3c (S-55): the member's exposure API (exposure-api.ts) and its routes (settings-api.ts, settings-effect.ts).
 * - The projection: the owner's agents only; P1 shares the agent itself (docs/design/hub-representative-agent.md):
 *   one "agent" choice, no Hub tools; a legacy (container) mapping says republish_required until shared again.
 * - Publish/revise only as a confirmed Settings replay by the local admin; the confirmation's effect is the request
 *   (summary, fingerprint over the body); never over the public link; 404 "unavailable" with no member composed.
 * - Withdraw: immediate (no confirmation), admin only, ok once saved, remote "pending".
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { HubDocumentView, executionPolicyDigest } from "../src/hub/execution/views.js";
import type { HubExecutionReadiness, HubLocalExposure } from "../src/hub/execution/service.js";
import { HUB_EXPOSURE_MIGRATION, HubExposureStore, publishExposure } from "../src/hub/member/exposures.js";
import { createHubMemberExposureApi, type HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import { agentPolicyDigest, isAgentDescriptor } from "../src/hub/member/agent-mode.js";

const dbs: Database.Database[] = [], caps: SettingsExecution[] = [];
afterEach(() => { dbs.splice(0).forEach((d) => d.close()); caps.splice(0).forEach((c) => c.close()); });

function member(opts: { agents?: () => Array<{ name: string; display: string }>; readinessCandidate?: ((c: HubLocalExposure) => HubExecutionReadiness) | null } = {}) {
  const db = new Database(":memory:"); dbs.push(db);
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_EXPOSURE_MIGRATION]);
  let floor = 0;
  const owner = { realm: "directory", objectId: randomUUID() }, fleetId = randomUUID();
  const view = new HubDocumentView("notes", [{ id: "n", title: "Notes", text: "x" }]);
  const views = new Map([[view.id, view]]);
  const store = new HubExposureStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, audit: createHubAudit({ db, contentKey: randomBytes(32) }), views,
    binding: () => ({ owner, fleetId }) });
  store.initialize();
  const afterCommit = vi.fn(async () => "pending");
  // S5's seam: a stub that accepts the candidate (opts.readinessCandidate: null leaves it out — no delivery path composed).
  const seam = opts.readinessCandidate === undefined ? (c: HubLocalExposure): HubExecutionReadiness => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision })
    : opts.readinessCandidate;
  const api = createHubMemberExposureApi({ store, agents: opts.agents ?? (() => [{ name: "atlas", display: "Atlas" }]), afterCommit, pending: (a) => (a === "atlas" ? null : null),
    ...(seam ? { readinessCandidate: seam } : {}) });
  /** A mapping from before P1's change: S4's restricted container over an approved view (the store still holds it). */
  const legacy = () => publishExposure(store, { agent: "atlas", providerId: "claude", displayName: "Atlas", dataViewId: "notes", allowedTools: ["documents.read"], expectedRevision: 0 },
    (c: HubLocalExposure): HubExecutionReadiness => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision }));
  return { api, store, view, afterCommit, legacy };
}
const AGENT = { agent: "atlas", dataViewId: "agent", tools: [] as string[] };

describe("the member's exposure API", () => {
  it("lists the owner's agents with the agent itself as the one choice; publish (after confirmation) and withdraw move the revision; each commit sends the snapshot", async () => {
    const m = member();
    expect(m.api.list()).toEqual([{ agent: "atlas", display: "Atlas", exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true,
      choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] }, pending: null }]);
    expect(m.api.preview({ ...AGENT, expectedRevision: 0 }).summary).toEqual(
      ['Share "Atlas" with the Hub', "Hub questions go to this agent's own conversation, with its folder and Settings tools", "Revision: 1"]);
    const v = m.api.publish({ ...AGENT, expectedRevision: 0 });
    expect(v).toMatchObject({ state: "published", revision: 1, policy: { dataView: "agent", tools: [] }, enforceable: true });
    expect(v.reason).toBeUndefined();
    const local = m.store.localExposure(v.exposureId!)!;
    expect(local).toMatchObject({ agent: "atlas", providerId: "agent", exposure: { dataViewId: "agent", allowedTools: [], policyDigest: agentPolicyDigest("atlas") } });
    expect(isAgentDescriptor(local)).toBe(true);
    expect(m.store.snapshot().exposures).toEqual([expect.objectContaining({ id: v.exposureId, dataViewId: "agent", allowedTools: [], policyDigest: agentPolicyDigest("atlas"), state: "published" })]);
    expect(m.afterCommit).toHaveBeenCalledTimes(1);
    expect(await m.api.withdraw(v.exposureId!, 1)).toEqual({ remote: "pending" });
    expect(m.api.list()[0]).toMatchObject({ state: "withdrawn", revision: 2, policy: null, enforceable: true });
    expect(m.afterCommit).toHaveBeenCalledTimes(2);
    await expect(m.api.withdraw(v.exposureId!, 1)).rejects.toMatchObject({ code: "conflict" });
  });
  it("refused: an unknown agent, a stale revision, odd input, an old tab's document view, any Hub tool; nothing committed", () => {
    const m = member();
    expect(() => m.api.publish({ ...AGENT, agent: "ghost", expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "unknown_agent" }));
    expect(() => m.api.publish({ ...AGENT, expectedRevision: 3 })).toThrow(expect.objectContaining({ code: "conflict" }));
    for (const bad of [null, [], { agent: "atlas" }, { ...AGENT, tools: "x", expectedRevision: 0 }, { ...AGENT, expectedRevision: -1 }, { ...AGENT, expectedRevision: 0, owner: "me" }]) {
      expect(() => m.api.preview(bad)).toThrow();
    }
    // A tab loaded before the change sends a document view and a tool: refused with codes it already knows.
    expect(() => m.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "unknown_view" }));
    expect(() => m.api.preview({ agent: "atlas", dataViewId: "notes", tools: [], expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "unknown_view" }));
    expect(() => m.api.publish({ ...AGENT, tools: ["documents.read"], expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(m.store.list()).toEqual([]); expect(m.afterCommit).not.toHaveBeenCalled();
  });
  it("an agent removed between the check and the atomic publish: readiness asked again inside it refuses; the candidate goes", () => {
    let calls = 0;
    const m = member({ agents: () => (++calls <= 2 ? [{ name: "atlas", display: "Atlas" }] : []) });
    expect(() => m.api.publish({ ...AGENT, expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(m.store.list()).toEqual([]); expect(m.afterCommit).not.toHaveBeenCalled();
  });
  it("S5's readinessCandidate: asked before the stage and again inside the atomic publish; its refusal refuses and drops the candidate", () => {
    const seen: Array<{ inTx: boolean; consentId: string; digest: string }> = [];
    let db!: Database.Database;
    const ok = vi.fn((c: HubLocalExposure): HubExecutionReadiness => {
      seen.push({ inTx: db.inTransaction, consentId: c.consentId, digest: c.exposure.policyDigest });
      return { ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision };
    });
    const m = member({ readinessCandidate: ok }); db = m.store.database;
    const v = m.api.publish({ ...AGENT, expectedRevision: 0 });
    expect(seen.map((x) => x.inTx)).toEqual([false, true]);
    expect(new Set(seen.map((x) => x.consentId)).size).toBe(1);
    expect(seen[0]!.digest).toBe(agentPolicyDigest("atlas"));
    expect(m.store.localExposure(v.exposureId!)!.consentId).toBe(seen[1]!.consentId);
    const no = member({ readinessCandidate: () => ({ ok: false, reasonCode: "stale" }) });
    expect(() => no.api.publish({ ...AGENT, expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(no.store.list()).toEqual([]); expect(no.afterCommit).not.toHaveBeenCalled();
  });
  it("#3146 r1: no S5 seam composed (no delivery path): every row unshareable (delivery_unavailable) and publish refused", () => {
    const m = member({ readinessCandidate: null });
    expect(m.api.list()[0]).toMatchObject({ state: "withdrawn", enforceable: false, reason: "delivery_unavailable" });
    expect(() => m.api.publish({ ...AGENT, expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(m.store.list()).toEqual([]); expect(m.afterCommit).not.toHaveBeenCalled();
    m.legacy();                                                                           // a legacy row still says why it is refused
    expect(m.api.list()[0]).toMatchObject({ state: "published", enforceable: false, reason: "republish_required" });
  });
  it("a legacy container mapping: durable, shown as republish_required (never as shared), withdrawable; never converted silently", async () => {
    const m = member(), old = m.legacy();
    expect(isAgentDescriptor(old)).toBe(false);
    expect(m.api.list()[0]).toMatchObject({ exposureId: old.exposure.id, state: "published", revision: 1, policy: { dataView: "notes", tools: ["documents.read"] },
      enforceable: false, reason: "republish_required", choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] } });
    expect(m.store.localExposure(old.exposure.id)).toEqual(old);                         // listing changed nothing
    expect(await m.api.withdraw(old.exposure.id, 1)).toEqual({ remote: "pending" });
    expect(m.api.list()[0]).toMatchObject({ state: "withdrawn", revision: 2, enforceable: true });
    expect(m.api.list()[0].reason).toBeUndefined();
  });
  it("a legacy mapping shared again: the same confirmed, revision-checked publish gives a new revision, consent and the agent tuple", () => {
    const m = member(), old = m.legacy();
    expect(() => m.api.publish({ ...AGENT, expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "conflict" }));   // stale tab
    expect(m.store.localExposure(old.exposure.id)).toEqual(old);
    const v = m.api.publish({ ...AGENT, expectedRevision: 1 });
    expect(v).toMatchObject({ exposureId: old.exposure.id, state: "published", revision: 2, policy: { dataView: "agent", tools: [] }, enforceable: true });
    const now = m.store.localExposure(old.exposure.id)!;
    expect(isAgentDescriptor(now)).toBe(true);
    expect(now.consentId).not.toBe(old.consentId); expect(now.generation).toBe(old.generation + 1);
    expect(m.store.snapshot().exposures).toEqual([expect.objectContaining({ revision: 2, dataViewId: "agent", allowedTools: [], policyDigest: agentPolicyDigest("atlas") })]);
  });
});

describe("the routes", () => {
  const body = { agent: "atlas", dataViewId: "agent", tools: [] as string[], expectedRevision: 0 };
  async function call(o: { method: string; path: string; json?: unknown; replay?: boolean; admin?: boolean; gateway?: boolean; api?: HubMemberExposureApi | null; meanwhile?: (ctx: any) => void }) {
    const raw = Buffer.from(JSON.stringify(o.json ?? {}));
    const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
    const req = o.replay ? createSettingsReplay({ method: o.method, url: o.path, body: raw, binding: "owned", localAdmin: () => o.admin !== false }, cap)
      : Object.assign(new EventEmitter(), { method: o.method, url: o.path, headers: o.admin === false ? {} : { "x-agend-token": "tok" } }) as unknown as IncomingMessage;
    if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
    const api = o.api === undefined ? member().api : o.api;
    const ctx = { webToken: "tok", webSessions: null, fleetConfig: { instances: {} }, logger: { warn: vi.fn() }, hubMemberExposures: () => api };
    return new Promise<{ status: number; body: any }>((resolve) => {
      let status = 0;
      const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
      expect(handleSettingsRequest(req, res as never, new URL(o.path, "http://localhost"), ctx as never)).toBe(true);
      o.meanwhile?.(ctx);                                               // between the request's start and its body
      if (!o.replay) { req.emit("data", raw); req.emit("end"); }
    });
  }
  it("the confirmation layer: publish is a Settings mutation whose effect is the request; withdraw and the list are not", () => {
    expect([isSettingsMutation("POST", "/api/hub/member/exposures"), isSettingsMutation("GET", "/api/hub/member/exposures"),
      isSettingsMutation("POST", `/api/hub/member/exposures/${randomUUID()}/withdraw`)]).toEqual([true, false, false]);
    const preview = vi.fn(() => ({ summary: ["Share it"] }));
    const e = prepareSettingsEffect("POST", "/api/hub/member/exposures", body, { config: { instances: {} } as never, classic: {}, hubExposure: preview });
    expect(e.diff).toMatchObject({ summary: ["Share it"], affectedConnections: [], authority: { connections: [], primaryGeneral: false, unknown: false } });
    const e2 = prepareSettingsEffect("POST", "/api/hub/member/exposures", { ...body, tools: ["documents.list"] }, { config: { instances: {} } as never, classic: {}, hubExposure: preview });
    expect(e2.diff!.fingerprint).not.toBe(e.diff!.fingerprint);
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/exposures", body, { config: null, classic: {} })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/exposures", body, { config: null, classic: {}, hubExposure: () => { throw Object.assign(Error("x"), { code: "unknown_view" }); } }))
      .toThrow(expect.objectContaining({ status: 409, code: "unknown_view" }));
  });
  it("publish runs only as a confirmed local-admin replay; never over the public link", async () => {
    expect(await call({ method: "POST", path: "/api/hub/member/exposures", json: body, replay: true })).toMatchObject({ status: 200, body: { ok: true, view: { state: "published", revision: 1 } } });
    for (const o of [{ replay: false }, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      expect((await call({ method: "POST", path: "/api/hub/member/exposures", json: body, ...o })).status).toBe(403);
    }
    expect(await call({ method: "POST", path: "/api/hub/member/exposures", json: { ...body, agent: "ghost" }, replay: true })).toMatchObject({ status: 409, body: { ok: false, error: "unknown_agent" } });
  });
  it("list and withdraw: admin only, not over the public link; no member composed: 404 unavailable", async () => {
    expect(await call({ method: "GET", path: "/api/hub/member/exposures" })).toMatchObject({ status: 200, body: { ok: true, exposures: [{ agent: "atlas" }] } });
    expect((await call({ method: "GET", path: "/api/hub/member/exposures", admin: false })).status).toBe(403);
    expect((await call({ method: "GET", path: "/api/hub/member/exposures", gateway: true })).status).toBe(403);
    expect(await call({ method: "GET", path: "/api/hub/member/exposures", api: null })).toMatchObject({ status: 404, body: { error: "unavailable" } });
    const m = member();
    const v = m.api.publish(body);
    const path = `/api/hub/member/exposures/${v.exposureId}/withdraw`;
    expect((await call({ method: "POST", path, json: { expectedRevision: 1 }, admin: false, api: m.api })).status).toBe(403);
    expect((await call({ method: "POST", path, json: { expectedRevision: 1 }, gateway: true, api: m.api })).status).toBe(403);
    expect(await call({ method: "POST", path, json: { expectedRevision: 1 }, api: m.api })).toMatchObject({ status: 200, body: { ok: true, remote: "pending" } });
    expect(await call({ method: "POST", path, json: { expectedRevision: 1 }, api: m.api })).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
    expect(m.store.localExposure(v.exposureId!)).toBeNull();
  });
});

describe("Prism #3115 r1 (exposures)", () => {
  it("P3: withdraw rechecks the same live caller and the same composed member at the effect", async () => {
    const m = member(), v = m.api.publish({ ...AGENT, expectedRevision: 0 });
    const path = `/api/hub/member/exposures/${v.exposureId}/withdraw`;
    const routes = (await import("../src/settings-api.js")).handleSettingsRequest;
    const run = async (meanwhile: (ctx: any) => void) => {
      const req: any = Object.assign(new (await import("node:events")).EventEmitter(), { method: "POST", url: path, headers: { "x-agend-token": "tok" } });
      const ctx: any = { webToken: "tok", webSessions: null, fleetConfig: { instances: {} }, logger: { warn: vi.fn() }, hubMemberExposures: () => m.api };
      return new Promise<{ status: number; body: any }>((resolve) => {
        let status = 0;
        const res = { writeHead(x: number) { status = x; }, setHeader() {}, end(x: string) { resolve({ status, body: JSON.parse(x) }); } };
        routes(req, res as never, new URL(path, "http://localhost"), ctx);
        meanwhile(ctx);
        req.emit("data", Buffer.from(JSON.stringify({ expectedRevision: 1 }))); req.emit("end");
      });
    };
    expect((await run((ctx) => { ctx.webToken = "rotated"; })).status).toBe(401);
    expect(await run((ctx) => { const other = member().api; ctx.hubMemberExposures = () => other; })).toMatchObject({ status: 409, body: { error: "unavailable" } });
    expect(m.store.localExposure(v.exposureId!)).not.toBeNull();       // neither committed
    expect((await run(() => {})).status).toBe(200);
  });
  it("P6: an audit sink that returns a promise is refused — nothing committed, the store uncertain, a late rejection observed", async () => {
    const db = new Database(":memory:"); dbs.push(db);
    applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_EXPOSURE_MIGRATION]);
    let floor = 0;
    const view = new HubDocumentView("notes", [{ id: "n", title: "Notes", text: "x" }]);
    const owner = { realm: "directory", objectId: randomUUID() }, fleetId = randomUUID();
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    const store = new HubExposureStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, views: new Map([[view.id, view]]), binding: () => ({ owner, fleetId }),
      audit: { appendInTransaction: (() => Promise.reject(new Error("late"))) as never } });
    store.initialize();
    expect(() => store.stage({ agent: "atlas", providerId: "inert", displayName: "Atlas", dataViewId: "notes", allowedTools: ["documents.read"], expectedRevision: 0 })).toThrow(/uncertain/);
    expect(floor).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hub_exposures").get()).toEqual({ n: 0 });
    expect(() => store.snapshot()).toThrow(/uncertain/);
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
