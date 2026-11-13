/** Actual roles/session/SQL + loopback HTTP and sealed rename writer; inert directory/config save. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubCatalogService } from "../src/hub/catalog.js";
import { createHubHttp } from "../src/hub/http/compose.js";
import { HubCore } from "../src/hub/http/core.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { personKeyString } from "../src/hub/identity.js";
import { HubSessions, hubCookieName } from "../src/hub/sessions.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { createHubSettingsWriter, SETTINGS_JOURNAL, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import type { HubTx } from "../src/hub/types.js";

type World = Awaited<ReturnType<typeof roleAuthorityWorld>>;
const homes: string[] = [];
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function http(w: World, work: (call: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; body: Record<string, any> }>) => Promise<void>) {
  const handler = createHubHttp(w.core.deps, hubTxDatabase), server = createServer((req, res) => {
    if (!handler.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await work(async (method, path, body, token = w.ctx.token) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { method,
        headers: { Origin: w.core.deps.config.webOrigin, Cookie: `${hubCookieName(w.hubId)}=${token}`,
          "X-AgEnD-Hub-CSRF": w.sessions.session(token)!.csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    });
  } finally { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function exposure(w: World) {
  const id = randomUUID();
  w.db.prepare(`INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at)
    VALUES(?,?,?,?,1,'published','agent','[]',?,100)`).run(id, randomUUID(), personKeyString(w.other), "Synthetic", "b".repeat(64));
  return { id, read: () => w.db.prepare("SELECT frozen_through,sharing_epoch FROM hub_exposures WHERE id=?").get(id) };
}

describe("S129 administrative operation proofs", () => {
  it.each(["signed-out", "stale-double"] as const)("keeps the named read's %s result after its held eligibility read", async mode => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const actor = await w.ctx.ctx.current(), context = HubSessions.prototype.context;
    if (mode === "stale-double") vi.spyOn(HubSessions.prototype, "context").mockImplementation(function (this: HubSessions, request) {
      const ctx = context.call(this, request);
      return { ...ctx, current: () => ctx.isCurrent!() ? ctx.current() : Promise.resolve(actor) };
    });
    const entered = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>(); let reads = 0;
    w.eligible.mockImplementation(async who => {
      if (++reads === 1) { entered.resolve(); return answer.promise; }
      return { eligible: true, person: w.person(who) };
    });
    await http(w, async call => {
      const pending = call("GET", "/hub/v1/admin/overview"); await entered.promise;
      try {
        w.sessions.signOut(w.ctx.token); answer.resolve({ eligible: true, person: w.person(w.admin) });
        const r = await pending;
        expect(r.status).toBe(mode === "signed-out" ? 401 : 503); expect(r.body).not.toHaveProperty("fleets");
      } finally { answer.resolve({ eligible: true, person: w.person(w.admin) }); await pending; }
    });
  });
  it("keeps the ordinary overview available to a current auxiliary admin", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    await http(w, async call => {
      const r = await call("GET", "/hub/v1/admin/overview"); expect(r.status).toBe(200);
      expect(r.body).toEqual({ fleets: [], pairings: [] });
    });
  });
  it("does not disclose overview after a reentrant projection retires its auxiliary role", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const read = w.store.read.bind(w.store);
    vi.spyOn(w.store, "read").mockImplementation(() => {
      const state = read();
      return { ...state, get fleets() { w.save({ ...w.policy, rolesActive: false }); return state.fleets; } };
    });
    await http(w, async call => {
      const r = await call("GET", "/hub/v1/admin/overview");
      expect(r.status).toBe(503); expect(r.body).toEqual({ code: "unavailable" }); expect(r.body).not.toHaveProperty("fleets");
    });
  });
  it("does not disclose overview when the SQL unit returns after the proof's deadline", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const atomic = w.core.deps.uow.atomic.bind(w.core.deps.uow);
    w.core.deps.uow.atomic = <T>(work: (tx: HubTx) => T): T => {
      const out = atomic(work);
      if (out && typeof out === "object" && "fleets" in out && "pairings" in out) w.time(5_000);
      return out;
    };
    await http(w, async call => {
      const r = await call("GET", "/hub/v1/admin/overview"); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("fleets");
    });
  });
  it.each(["role-loss", "expiry"] as const)("rolls back exposure freeze and its required audit on %s during audit", async mode => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    if (mode === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); }
    const e = exposure(w), before = e.read(), append = w.audit.append.bind(w.audit);
    vi.spyOn(w.audit, "append").mockImplementation((tx, record) => {
      append(tx, record);
      if (record.action === "exposure.frozen") {
        if (mode === "expiry") w.time(100); else w.save({ ...w.policy, rolesActive: false });
      }
    });
    await expect(new HubCatalogService(w.core).freeze(w.ctx.ctx, e.id, 1, true)).rejects.toMatchObject({ code: "unavailable" });
    expect(e.read()).toEqual(before);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='exposure.frozen'").get()).toEqual({ n: 0 });
  });
  it("commits a current auxiliary admin's freeze, with its own actor and no root self-use grant", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const e = exposure(w); await new HubCatalogService(w.core).freeze(w.ctx.ctx, e.id, 1, true);
    expect(e.read()).toEqual({ frozen_through: 1, sharing_epoch: 1 });
    const event = w.db.prepare("SELECT actor FROM hub_audit WHERE action='exposure.frozen'").get() as { actor: string };
    expect(JSON.parse(event.actor)).toEqual({ kind: "person", person: w.admin });
    expect(w.policy.assignments.every(a => a.subject.kind !== "person" || a.subject.person.objectId !== w.root.objectId)).toBe(true);
  });
  it("keeps the owner's narrowing-only freeze independent of administrative assignment", async () => {
    const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
    const e = exposure(w), owner = await w.browser(w.other);
    await new HubCatalogService(w.core).freeze(owner.ctx, e.id, 1, false);
    expect(e.read()).toEqual({ frozen_through: 1, sharing_epoch: 1 });
  });
});

async function sealed(step?: HubSettingsWriterDeps["step"]) {
  const home = mkdtempSync(join(tmpdir(), "roles-admin-")); homes.push(home);
  const memberOrigin = "https://member.example.test", identity = await provisionHubIdentity({ home, memberOrigin });
  const w = await roleAuthorityWorld({ hubId: identity.hubId }); w.core.deps.management = w.authority;
  const hub: Record<string, unknown> = { enabled: true, name: "Before", hubId: identity.hubId, memberOrigin,
    webOrigin: w.core.deps.config.webOrigin, administrator: w.root };
  const committedAt = "2026-11-13T00:00:00.000Z", confirmationId = "c".repeat(32), planDigest = hubPlanDigest(hub);
  const signature = sealHubInitialization({ home, planDigest, confirmationId, committedAt });
  writeFileSync(join(home, "hub/init-manifest.json"), JSON.stringify({ v: 1, hubId: identity.hubId, planDigest, committedAt, confirmationId, signature }), { mode: 0o600 });
  const manifest = readFileSync(join(home, "hub/init-manifest.json"), "utf8");
  const writer = createHubSettingsWriter({ home, readHub: () => structuredClone(hub), now: () => w.core.now(), step,
    saveHub(patches) { for (const patch of patches) { if (patch.remove) delete hub[patch.path[1]!]; else hub[patch.path[1]!] = patch.value; } } });
  w.core.deps.hubSettings = { info: { hubId: identity.hubId, memberSpkiSha256: identity.spkiSha256, issuerKeyId: identity.issuerKeyId, version: null }, writer };
  return { ...w, hub, home, writer, manifest, verifies: () => verifyHubInitialization({ home, hubId: identity.hubId, memberOrigin, planDigest: hubPlanDigest(hub) }) };
}

describe("S129 current authority at sealed rename", () => {
  it("does not disclose This Hub metadata if its projection retires authority", async () => {
    const w = await sealed(), info = w.core.deps.hubSettings!.info;
    w.core.deps.hubSettings = { ...w.core.deps.hubSettings!, info: { ...info,
      get version() { w.save({ ...w.policy, rolesActive: false }); return null; } } };
    await http(w, async call => {
      const r = await call("GET", "/hub/v1/admin/hub");
      expect(r.status).toBe(503); expect(r.body).toEqual({ code: "unavailable" }); expect(r.body).not.toHaveProperty("hubId");
    });
  });
  it.each(["read", "prepare", "commit"] as const)("rechecks %s permission before work after the inner asynchronous admin proof returns", async mode => {
    const w = await sealed(), management = HubCore.prototype.management;
    const prepare = vi.spyOn(w.writer, "prepare"), commit = vi.spyOn(w.writer, "commit"), audit = vi.spyOn(w.audit, "append");
    vi.spyOn(HubCore.prototype, "management").mockImplementation(async function (this: HubCore, ctx, permission) {
      const permit = await management.call(this, ctx, permission);
      let queued = false;
      return { ...permit, assertCurrent() { permit.assertCurrent(); if (!queued) { queued = true; queueMicrotask(() => w.save({ ...w.policy, rolesActive: false })); } } };
    });
    await http(w, async call => {
      const r = mode === "read" ? await call("GET", "/hub/v1/admin/hub") : mode === "prepare"
        ? await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" })
        : await call("POST", "/hub/v1/admin/hub/name/commit", { ref: "never-authorized" });
      expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("hubId"); expect(r.body).not.toHaveProperty("ref");
      expect(prepare).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    });
  });
  it("does not disclose a prepared reference if the writer's prepare retires authority", async () => {
    const w = await sealed(), prepare = w.writer.prepare.bind(w.writer);
    vi.spyOn(w.writer, "prepare").mockImplementation((...args) => {
      const result = prepare(...args); w.save({ ...w.policy, rolesActive: false }); return result;
    });
    await http(w, async call => {
      const r = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" });
      expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("ref"); expect(w.hub.name).toBe("Before");
    });
  });
  it("refuses rename before the writer after the held audit retires its auxiliary permission", async () => {
    const w = await sealed(), append = w.audit.append.bind(w.audit);
    const commit = vi.spyOn(w.writer, "commit");
    vi.spyOn(w.audit, "append").mockImplementation((tx, record) => {
      append(tx, record);
      if (record.action === "hub.settings.rename" && record.result === "held") w.save({ ...w.policy, rolesActive: false });
    });
    await http(w, async call => {
      const p = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" }); expect(p.status).toBe(200);
      const r = await call("POST", "/hub/v1/admin/hub/name/commit", { ref: p.body.ref });
      expect(r.status).toBe(503); expect(w.hub.name).toBe("Before");
      expect(readFileSync(join(w.home, "hub/init-manifest.json"), "utf8")).toBe(w.manifest);
      expect(existsSync(join(w.home, SETTINGS_JOURNAL))).toBe(false); expect(commit).not.toHaveBeenCalled(); w.verifies();
    });
  });
  it("passes current permission through the real writer's last precommit check", async () => {
    let retire = () => {};
    const w = await sealed(at => { if (at === "staged") retire(); });
    retire = () => w.save({ ...w.policy, rolesActive: false });
    await http(w, async call => {
      const p = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" }); expect(p.status).toBe(200);
      const r = await call("POST", "/hub/v1/admin/hub/name/commit", { ref: p.body.ref });
      expect(r.status).toBe(409); expect(w.hub.name).toBe("Before");
      expect(readFileSync(join(w.home, "hub/init-manifest.json"), "utf8")).toBe(w.manifest);
      expect(existsSync(join(w.home, SETTINGS_JOURNAL))).toBe(false); w.verifies();
    });
  });
  it("renames through the same writer with the auxiliary actor when current", async () => {
    const w = await sealed();
    await http(w, async call => {
      expect((await call("GET", "/hub/v1/admin/hub")).status).toBe(200);
      const p = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" }); expect(p.status).toBe(200);
      expect((await call("POST", "/hub/v1/admin/hub/name/commit", { ref: p.body.ref })).status).toBe(200);
      expect(w.hub.name).toBe("After"); w.verifies();
      const event = w.db.prepare("SELECT actor FROM hub_audit WHERE action='hub.settings.rename' AND result='held'").get() as { actor: string };
      expect(JSON.parse(event.actor)).toEqual({ kind: "person", person: w.admin });
    });
  });
  it("keeps an already-committed rename forward-only when the completed audit retires authority", async () => {
    const w = await sealed(), append = w.audit.append.bind(w.audit);
    vi.spyOn(w.audit, "append").mockImplementation((tx, record) => {
      append(tx, record);
      if (record.action === "hub.settings.rename" && record.result === "completed") w.save({ ...w.policy, rolesActive: false });
    });
    await http(w, async call => {
      const p = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" }); expect(p.status).toBe(200);
      const r = await call("POST", "/hub/v1/admin/hub/name/commit", { ref: p.body.ref });
      expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("summary");
      expect(w.hub.name).toBe("After"); expect(existsSync(join(w.home, SETTINGS_JOURNAL))).toBe(false); w.verifies();
      w.writer.recover(); expect(w.hub.name).toBe("After"); w.verifies();
    });
  });
  it.each(["join.manage", "fleets.manage", "roles.assign", "audit.view"] as const)("refuses all administrative entries for a split %s holder", async permission => {
    const w = await sealed();
    w.policy.roles.push({ id: "split", name: "Split", kind: "custom", permissions: [permission], defaultMaxFleets: 0 });
    w.policy.assignments[0]!.roleId = "split"; w.save(w.policy); const e = exposure(w);
    await http(w, async call => {
      expect((await call("GET", "/hub/v1/admin/overview")).status).toBe(403);
      expect((await call("GET", "/hub/v1/admin/hub")).status).toBe(403);
      expect((await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" })).status).toBe(403);
      expect((await call("POST", `/hub/v1/admin/exposures/${e.id}/freeze`, { revision: 1 })).status).toBe(403);
      expect(e.read()).toEqual({ frozen_through: -1, sharing_epoch: 0 }); expect(w.hub.name).toBe("Before");
    });
  });
  it("retains configured-root administration with roles off and no self-use assignment", async () => {
    const w = await sealed(), root = await w.browser(w.root); w.save({ ...w.policy, rolesActive: false });
    await http(w, async call => {
      expect((await call("GET", "/hub/v1/admin/overview", undefined, root.token)).status).toBe(200);
      const p = await call("POST", "/hub/v1/admin/hub/name/prepare", { name: "After" }, root.token); expect(p.status).toBe(200);
      expect((await call("POST", "/hub/v1/admin/hub/name/commit", { ref: p.body.ref }, root.token)).status).toBe(200);
      expect(w.hub.name).toBe("After"); w.verifies();
    });
  });
});
