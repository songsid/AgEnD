/**
 * S3c (S-55): the member's exposure API (exposure-api.ts) and its routes (settings-api.ts, settings-effect.ts).
 * - The projection: the owner's agents only, `choices` from the approved views (none without an S4 provider),
 *   `enforceable` from S4, the committed revision and state.
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
import { HUB_EXPOSURE_MIGRATION, HubExposureStore } from "../src/hub/member/exposures.js";
import { createHubMemberExposureApi, type HubMemberExposureApi } from "../src/hub/member/exposure-api.js";

const dbs: Database.Database[] = [], caps: SettingsExecution[] = [];
afterEach(() => { dbs.splice(0).forEach((d) => d.close()); caps.splice(0).forEach((c) => c.close()); });

function member(opts: { provider?: boolean; views?: boolean; providerReason?: Parameters<typeof createHubMemberExposureApi>[0]["providerReason"] } = {}) {
  const db = new Database(":memory:"); dbs.push(db);
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_EXPOSURE_MIGRATION]);
  let floor = 0;
  const owner = { realm: "directory", objectId: randomUUID() }, fleetId = randomUUID();
  const view = new HubDocumentView("notes", [{ id: "n", title: "Notes", text: "x" }]);
  const views = new Map(opts.views === false ? [] : [[view.id, view]]);
  const store = new HubExposureStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, audit: createHubAudit({ db, contentKey: randomBytes(32) }), views,
    binding: () => ({ owner, fleetId }) });
  store.initialize();
  const readinessCandidate = vi.fn((c: HubLocalExposure): HubExecutionReadiness => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision }));
  const afterCommit = vi.fn(async () => "pending");
  const api = createHubMemberExposureApi({ store, views, readinessCandidate, readiness: () => ({ ok: true, policyDigest: "x", exposureRevision: 1 }) as HubExecutionReadiness,
    providerReason: opts.providerReason,
    agents: () => [{ name: "atlas", display: "Atlas", providerId: opts.provider === false ? null : "inert" }], afterCommit, pending: (a) => (a === "atlas" ? null : null) });
  return { api, store, view, afterCommit, readinessCandidate };
}

describe("the member's exposure API", () => {
  it.each(["engine-unavailable", "engine-unsupported", "image-unconfigured", "image-mismatch", "credential-unconfigured", "unavailable"] as const)("explains %s before a first publish while preserving S4's exact candidate gate", reason => {
    const m = member({ providerReason: () => reason });
    expect(m.api.list()[0]).toMatchObject({ exposureId: null, enforceable: false, reason });
    expect(m.readinessCandidate).not.toHaveBeenCalled();
    m.readinessCandidate.mockReturnValue({ ok: false, reasonCode: reason });
    expect(() => m.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 })).toThrow();
    expect(m.store.list().every(row => !row.committed)).toBe(true); expect(m.afterCommit).not.toHaveBeenCalled();
  });
  it("sanitizes a throwing or unknown provider diagnostic and cannot gain readiness from null", () => {
    for (const providerReason of [() => { throw Error("PRIVATE-KEY"); }, () => "PRIVATE-KEY" as never]) {
      expect(member({ providerReason }).api.list()[0]).toMatchObject({ enforceable: false, reason: "provider-unavailable" });
    }
    expect(member({ provider: false, providerReason: () => null }).api.list()[0].enforceable).toBe(false);
    expect(member({ views: false, providerReason: () => null }).api.list()[0].enforceable).toBe(false);
  });
  it("lists the owner's agents with their choices; publish (after confirmation) and withdraw move the revision; each commit sends the snapshot", async () => {
    const m = member();
    expect(m.api.list()).toEqual([{ agent: "atlas", display: "Atlas", exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true,
      choices: { dataViews: [{ id: "notes", label: "notes" }], tools: [{ name: "documents.list", label: "List documents" }, { name: "documents.read", label: "Read documents" }] }, pending: null }]);
    expect(m.api.preview({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 }).summary).toEqual(
      ['Share "Atlas" with the Hub', "Data view: notes", "Tools: documents.read", "Revision: 1"]);
    const v = m.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 });
    expect(v).toMatchObject({ state: "published", revision: 1, policy: { dataView: "notes", tools: ["documents.read"] } });
    expect(m.store.exposure(v.exposureId!)!.policyDigest).toBe(executionPolicyDigest(m.view, ["documents.read"]));
    expect(m.afterCommit).toHaveBeenCalledTimes(1);
    expect(await m.api.withdraw(v.exposureId!, 1)).toEqual({ remote: "pending" });
    expect(m.api.list()[0]).toMatchObject({ state: "withdrawn", revision: 2, policy: null });
    expect(m.afterCommit).toHaveBeenCalledTimes(2);
    await expect(m.api.withdraw(v.exposureId!, 1)).rejects.toMatchObject({ code: "conflict" });
  });
  it("refused: an unknown agent, a stale revision, odd input; no S4 provider or no approved view: nothing to choose, not enforceable", () => {
    const m = member();
    expect(() => m.api.publish({ agent: "ghost", dataViewId: "notes", tools: [], expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "unknown_agent" }));
    expect(() => m.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 3 })).toThrow(expect.objectContaining({ code: "conflict" }));
    for (const bad of [null, [], { agent: "atlas" }, { agent: "atlas", dataViewId: "notes", tools: "x", expectedRevision: 0 }, { agent: "atlas", dataViewId: "notes", tools: [], expectedRevision: -1 },
      { agent: "atlas", dataViewId: "notes", tools: [], expectedRevision: 0, owner: "me" }]) expect(() => m.api.preview(bad)).toThrow();
    const p = member({ provider: false });
    expect(p.api.list()[0]).toMatchObject({ enforceable: false, reason: "no_restricted_provider", choices: { dataViews: [], tools: [] } });
    expect(() => p.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 })).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(member({ views: false }).api.list()[0]).toMatchObject({ enforceable: false, reason: "no_approved_view" });
  });
});

describe("the routes", () => {
  const body = { agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 };
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
    const m = member(), v = m.api.publish({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 });
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
