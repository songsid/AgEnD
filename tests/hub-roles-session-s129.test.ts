/** Actual SQL/sessions/role authority, fictional directory, no mounted enforcement claim. */
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_ROLE_IDS } from "../src/hub/roles/model.js";
import { createHubHttp } from "../src/hub/http/compose.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { HubSessions, hubCookieName } from "../src/hub/sessions.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";

describe("S129 session administrative authority", () => {
  it("uses the composed current hub.admin authority for the actual auxiliary session", async () => {
    const w = await roleAuthorityWorld();
    w.core.deps.management = w.authority;
    expect(await w.ctx.ctx.requireAdmin()).toMatchObject({ kind: "directory", person: w.admin });
  });
  it("keeps an auxiliary administrator valid across a fresh browser session without changing the root", async () => {
    const w = await roleAuthorityWorld();
    w.core.deps.management = w.authority;
    const fresh = await w.browser();
    expect(await fresh.ctx.requireAdmin()).toMatchObject({ kind: "directory", person: w.admin });
    expect(w.core.deps.config.administrator).toEqual(w.root);
    expect(w.policy.assignments[0]!.roleId).toBe(BUILTIN_ROLE_IDS.admin);
  });
  it("keeps the configured root as the sole legacy administrator without composed role authority", async () => {
    const w = await roleAuthorityWorld();
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    const root = await w.browser(w.root);
    expect(await root.ctx.requireAdmin()).toMatchObject({ kind: "directory", person: w.root });
  });
});

/** Owned loopback HTTP adapter over real role/session SQL, not the sealed Hub factory or live AD. */
async function throughHttp(w: Awaited<ReturnType<typeof roleAuthorityWorld>>, work: (call: (method: string, token?: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }>) => Promise<void>) {
  const http = createHubHttp(w.core.deps, hubTxDatabase);
  const server = createServer((req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await work(async (method, token, body) => {
      const response = await fetch(`${base}/hub/v1/session`, { method, headers: { Origin: w.core.deps.config.webOrigin,
        ...(token ? { Cookie: `${hubCookieName(w.hubId)}=${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get("set-cookie") };
    });
  } finally { await http.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("S129 session presentation through actual HTTP", () => {
  it("returns current auxiliary administrative presentation on sign-in and subsequent read", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    await throughHttp(w, async call => {
      const login = await call("POST", undefined, { login: w.admin.objectId, password: "synthetic" });
      expect(login.status).toBe(200); expect(login.body).toMatchObject({ signedIn: true, admin: true });
      expect(login.body).not.toHaveProperty("token");
      expect(login.cookie!.split(";").slice(1).map(part => part.trim())).toEqual(expect.arrayContaining(["Secure", "HttpOnly", "Path=/", "SameSite=Strict"]));
      const token = login.cookie!.split(";")[0]!.split("=")[1]!;
      expect((await call("GET", token)).body).toMatchObject({ signedIn: true, admin: true });
      w.save({ ...w.policy, assignments: [] });
      expect((await call("GET", token)).body).toMatchObject({ signedIn: true, admin: false });
      expect((await call("POST", undefined, { login: w.admin.objectId, password: "synthetic" })).body).toMatchObject({ signedIn: true, admin: false });
    });
  });
  it.each(["GET", "POST"])("rechecks the positive proof after the %s presentation await", async method => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const original = HubSessions.prototype.presentation;
    vi.spyOn(HubSessions.prototype, "presentation").mockImplementationOnce(async function (this: HubSessions, token) {
      const result = await original.call(this, token); w.save({ ...w.policy, assignments: [] }); return result;
    });
    await throughHttp(w, async call => {
      const response = await call(method, method === "GET" ? w.ctx.token : undefined, method === "POST" ? { login: w.admin.objectId, password: "synthetic" } : undefined);
      expect(response.status).toBe(503); expect(response.body).toEqual({ code: "unavailable" }); expect(response.cookie).toBeNull();
      expect((await call("GET", w.ctx.token)).body).toMatchObject({ signedIn: true, admin: false });
    });
  });
});

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("S129 current administrative presentation", () => {
  it("presents the real auxiliary session without returning its bearer token", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const shown = await w.sessions.presentation(w.ctx.token);
    expect(shown?.view).toMatchObject({ admin: true, person: w.admin });
    expect(shown?.view).not.toHaveProperty("token");
    shown!.assertCurrent();
    w.save({ ...w.policy, assignments: [] });
    expect(() => shown!.assertCurrent()).toThrow();
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(false);
    expect(w.sessions.session(w.ctx.token)).not.toBeNull();
  });
  it.each(["off", "expiry"] as const)("does not retain the positive flag after %s and keeps root management", async change => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    if (change === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); }
    const shown = await w.sessions.presentation(w.ctx.token);
    expect(shown?.view.admin).toBe(true);
    if (change === "off") w.save({ ...w.policy, rolesActive: false }); else w.time(100);
    expect(() => shown!.assertCurrent()).toThrow();
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(false);
    const root = await w.browser(w.root);
    expect((await w.sessions.presentation(root.token))?.view.admin).toBe(true);
  });
  it.each(["join.manage", "fleets.manage", "roles.assign", "audit.view"] as const)("never treats a %s assignment as hub.admin", async permission => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    w.policy.roles.push({ id: "split", name: "Split", kind: "custom", permissions: [permission], defaultMaxFleets: 0 });
    w.policy.assignments[0]!.roleId = "split"; w.save(w.policy);
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(false);
    const named = await w.core.management(w.ctx.ctx, permission); named.assertCurrent();
  });
  it("does not turn an unavailable fresh eligibility answer into a cached positive flag", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(true);
    w.eligible.mockResolvedValue({ eligible: false, reason: "unavailable" });
    await expect(w.sessions.presentation(w.ctx.token)).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["context", "presentation"] as const)("preserves sign-out while a %s eligibility read is held", async mode => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const entered = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>();
    w.eligible.mockImplementationOnce(() => { entered.resolve(); return answer.promise; });
    const pending = (mode === "context" ? w.ctx.ctx.requireAdmin() : w.sessions.presentation(w.ctx.token)).catch(error => error);
    await entered.promise;
    try {
      w.sessions.signOut(w.ctx.token); answer.resolve({ eligible: true, person: w.person(w.admin) });
      expect(await pending).toMatchObject({ code: "revoked" });
    } finally { answer.resolve({ eligible: true, person: w.person(w.admin) }); await pending; }
  });
  it.each(["object", "method"] as const)("permanently retires a core proof after observed management %s replacement", async mode => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const original = w.authority.require, permit = await w.core.management(w.ctx.ctx, "hub.admin");
    if (mode === "object") w.core.deps.management = { require: original };
    else w.authority.require = (...args) => original(...args);
    expect(() => permit.assertCurrent()).toThrow();
    w.core.deps.management = w.authority; w.authority.require = original;
    expect(() => permit.assertCurrent()).toThrow();
    (await w.core.management(w.ctx.ctx, "hub.admin")).assertCurrent();
  });
  it("retires a presentation after observed authority replacement even if the same object returns", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const shown = await w.sessions.presentation(w.ctx.token);
    delete w.core.deps.management; expect(() => shown!.assertCurrent()).toThrow();
    w.core.deps.management = w.authority; expect(() => shown!.assertCurrent()).toThrow();
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(true);
  });
});

describe("S129 role session classification is never authority", () => {
  it("keeps legacy session presentation and configured-root repair independent of the strict policy reader", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority; w.core.deps.roleSessionMode = () => false;
    const root = await w.browser(w.root);
    const require = vi.spyOn(w.authority, "require");
    expect((await w.sessions.presentation(w.ctx.token))?.view.admin).toBe(false);
    expect((await w.sessions.presentation(root.token))?.view.admin).toBe(true);
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    expect(await root.ctx.requireAdmin()).toMatchObject({ person: w.root });
    expect(require).not.toHaveBeenCalled();
    // The false classifier does not revoke or mint a named permit; that boundary evaluates real role authority.
    (await w.core.management(w.ctx.ctx, "hub.admin")).assertCurrent();
  });
  it("does not allow an auxiliary administrator when classification changes during its physical read", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority; let roles = true;
    w.core.deps.roleSessionMode = () => roles;
    const entered = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>();
    w.eligible.mockImplementationOnce(() => { entered.resolve(); return answer.promise; });
    const pending = w.ctx.ctx.requireAdmin().catch(error => error);
    await entered.promise;
    try { roles = false; answer.resolve({ eligible: true, person: w.person(w.admin) }); expect(await pending).toMatchObject({ code: "unavailable" }); }
    finally { answer.resolve({ eligible: true, person: w.person(w.admin) }); await pending; }
  });
  it("rejects a captured presentation after the classification method is replaced", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const classify = () => true; w.core.deps.roleSessionMode = classify;
    const shown = await w.sessions.presentation(w.ctx.token);
    w.core.deps.roleSessionMode = () => true; expect(() => shown!.assertCurrent()).toThrow();
    w.core.deps.roleSessionMode = classify; expect(() => shown!.assertCurrent()).toThrow();
  });
});

describe("S129 administrative session final await", () => {
  it("keeps sign-out classified as revoked after the core proof resolves but before the context returns", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const original = w.core.management.bind(w.core);
    vi.spyOn(w.core, "management").mockImplementationOnce(async (...args) => {
      const permit = await original(...args); w.sessions.signOut(w.ctx.token); return permit;
    });
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "revoked" });
  });
});
