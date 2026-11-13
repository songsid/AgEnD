/** Actual role/session/audit SQL and owned loopback HTTP; fictional directory, no production cutover. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createHubHttp } from "../src/hub/http/compose.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { hubCookieName } from "../src/hub/sessions.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import * as roleAudit from "../src/hub/roles/audit.js";

type World = Awaited<ReturnType<typeof roleAuthorityWorld>>;
async function http(w: World, work: (get: (path: string, token?: string) => Promise<{ status: number; body: Record<string, any> }>) => Promise<void>) {
  const handler = createHubHttp(w.core.deps, hubTxDatabase), server = createServer((req, res) => {
    if (!handler.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await work(async (path, token = w.ctx.token) => {
      const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`,
        { headers: { Origin: w.core.deps.config.webOrigin, Cookie: `${hubCookieName(w.hubId)}=${token}` } });
      return { status: r.status, body: await r.json() as Record<string, any> };
    });
  } finally { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function world() {
  const w = await roleAuthorityWorld(); w.core.deps.management = w.authority;
  w.core.deps.roleSessionMode = () => w.pool.canonical!().kind === "roles";
  w.policy.roles.push({ id: "audit-only", name: "Audit metadata", kind: "custom", permissions: ["audit.view"], defaultMaxFleets: 0 });
  w.policy.assignments[0]!.roleId = "audit-only"; w.save(w.policy);
  const exposureId = randomUUID(), fleetId = randomUUID();
  w.core.atomic((_db, tx) => {
    const contentRef = w.audit.content.put(tx, { question: "synthetic private question", answer: "synthetic private answer" });
    w.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person: w.other }, action: "message.answered", result: "completed",
      messageId: randomUUID(), roomId: randomUUID(), fleetId, exposureId, ownerAtEvent: w.other, grantId: randomUUID(), grantRevision: 1,
      contentRef, reasonCode: "synthetic private diagnostic", codeId: randomUUID() });
  });
  const row = w.db.prepare("SELECT id FROM hub_audit WHERE action='message.answered'").get() as { id: string };
  return { ...w, recordId: row.id, exposureId, fleetId };
}

describe("S129 explicit audit metadata", () => {
  it("advertises the metadata selector only for a current role image; old clients keep their old audit read", async () => {
    const w = await world(), root = await w.browser(w.root);
    await http(w, async get => {
      expect((await get("/hub/v1/session")).body.features ?? []).toContain("role-audit-metadata-v1");
      expect((await get("/hub/v1/audit")).body.records.some((record: { id: string }) => record.id === w.recordId)).toBe(false);
      w.db.prepare("UPDATE hub_group_policy SET body=?").run(w.legacyRaw);
      expect((await get("/hub/v1/session", root.token)).body.features ?? []).not.toContain("role-audit-metadata-v1");
    });
  });
  it("lets a current audit.view-only holder read Hub-wide allowlisted metadata, without content references", async () => {
    const w = await world();
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(200);
      const record = r.body.records.find((record: { id: string }) => record.id === w.recordId);
      expect(record).toMatchObject({ id: w.recordId, actor: { kind: "person", person: w.other }, action: "message.answered", result: "completed", exposureId: w.exposureId, fleetId: w.fleetId });
      expect(Object.keys(record).sort()).toEqual(["id", "sequence", "at", "actor", "action", "result", "policyVersion", "exposureId", "fleetId", "ownerAtEvent"].sort());
      expect(JSON.stringify(r.body)).not.toContain("synthetic private"); expect(record).not.toHaveProperty("contentRef");
    });
    await expect(w.audit.readContent(w.ctx.ctx, w.recordId)).rejects.toThrow();
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_auditors").get()).toEqual({ n: 0 });
  });
  it("leaves the existing owner/auditor read and foreign-content refusal unchanged", async () => {
    const w = await world(), owner = await w.browser(w.other);
    await http(w, async get => {
      expect((await get("/hub/v1/audit")).body.records.some((record: { id: string }) => record.id === w.recordId)).toBe(false);
      expect((await get("/hub/v1/audit", owner.token)).body.records.some((record: { id: string }) => record.id === w.recordId)).toBe(true);
    });
    await expect(w.audit.readContent(owner.ctx, w.recordId)).resolves.toMatchObject({ question: "synthetic private question", answer: "synthetic private answer" });
    await expect(w.audit.readContent(w.ctx.ctx, w.recordId)).rejects.toThrow();
  });
  it("does not expose role metadata on a legacy group-policy image", async () => {
    const w = await world(), root = await w.browser(w.root);
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(w.legacyRaw);
    await http(w, async get => {
      expect((await get("/hub/v1/audit?view=metadata", root.token)).status).toBe(404);
      expect((await get("/hub/v1/audit", root.token)).status).toBe(200);
    });
  });
  it.each(["join.manage", "fleets.manage", "roles.assign"] as const)("does not treat %s as a metadata read right", async permission => {
    const w = await world(); w.policy.roles.find(r => r.id === "audit-only")!.permissions = [permission]; w.save(w.policy);
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(403); expect(r.body).not.toHaveProperty("records");
    });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='audit.metadata-read'").get()).toEqual({ n: 0 });
  });
  it("with roles off, retains configured-root metadata only and no content auditor assignment", async () => {
    const w = await world(), root = await w.browser(w.root); w.save({ ...w.policy, rolesActive: false });
    await http(w, async get => {
      expect((await get("/hub/v1/audit?view=metadata")).status).toBe(403);
      const r = await get("/hub/v1/audit?view=metadata", root.token); expect(r.status).toBe(200);
      expect(r.body.records.some((record: { id: string }) => record.id === w.recordId)).toBe(true);
    });
    await expect(w.audit.readContent(root.ctx, w.recordId)).rejects.toThrow();
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_auditors").get()).toEqual({ n: 0 });
  });
  it.each(["role-loss", "expiry"] as const)("rolls back the required read audit without disclosure on %s during append", async mode => {
    const w = await world();
    if (mode === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); }
    const append = w.audit.append.bind(w.audit);
    vi.spyOn(w.audit, "append").mockImplementation((tx, event) => {
      append(tx, event);
      if (event.action === "audit.metadata-read") {
        if (mode === "expiry") w.time(100); else w.save({ ...w.policy, rolesActive: false });
      }
    });
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("records");
    });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='audit.metadata-read'").get()).toEqual({ n: 0 });
  });
  it("withholds a completed snapshot if permission changes in the final HTTP await gap", async () => {
    const w = await world(), read = roleAudit.readHubRoleAudit;
    vi.spyOn(roleAudit, "readHubRoleAudit").mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args); w.save({ ...w.policy, rolesActive: false }); return snapshot;
    });
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("records");
    });
  });
  it("refuses unknown actor eligibility without writing the metadata read record", async () => {
    const w = await world(); w.eligible.mockResolvedValue({ eligible: false, reason: "unavailable" });
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("records");
    });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='audit.metadata-read'").get()).toEqual({ n: 0 });
  });
  it("does not disclose metadata when the required read audit cannot be written", async () => {
    const w = await world(); vi.spyOn(w.audit, "append").mockImplementation(() => { throw Error("synthetic audit failure"); });
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(500); expect(r.body).toEqual({ code: "unavailable" });
    });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='audit.metadata-read'").get()).toEqual({ n: 0 });
  });
  it("fails closed on an unrecognized actor image rather than projecting extra private fields", async () => {
    const w = await world();
    w.db.prepare("UPDATE hub_audit SET actor=? WHERE id=?").run(JSON.stringify({ kind: "person", person: w.other, question: "synthetic private field" }), w.recordId);
    await http(w, async get => {
      const r = await get("/hub/v1/audit?view=metadata"); expect(r.status).toBe(503); expect(r.body).not.toHaveProperty("records");
    });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action='audit.metadata-read'").get()).toEqual({ n: 0 });
  });
  it("bounds pages, selects only the exact exposure and advances the sequence cursor", async () => {
    const w = await world();
    w.core.atomic((_db, tx) => {
      for (let i = 0; i < 505; i++) w.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person: w.other },
        action: "synthetic.metadata", result: "completed", exposureId: i % 2 ? w.exposureId : randomUUID() });
    });
    await http(w, async get => {
      const page = await get("/hub/v1/audit?view=metadata"); expect(page.status).toBe(200); expect(page.body.records).toHaveLength(500);
      const after = page.body.records[100].sequence as number;
      const selected = await get(`/hub/v1/audit?view=metadata&exposureId=${w.exposureId}&after=${after}`);
      expect(selected.status).toBe(200); expect(selected.body.records.length).toBeGreaterThan(0); expect(selected.body.records.length).toBeLessThanOrEqual(500);
      expect(selected.body.records.every((record: { sequence: number; exposureId?: string }) => record.sequence > after && record.exposureId === w.exposureId)).toBe(true);
      const sequences = selected.body.records.map((record: { sequence: number }) => record.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b)); expect(new Set(sequences).size).toBe(sequences.length);
    });
  });
  it("rejects unknown views and invalid metadata cursors", async () => {
    const w = await world();
    await http(w, async get => {
      for (const path of ["/hub/v1/audit?view=content", "/hub/v1/audit?view=metadata&after=-1", "/hub/v1/audit?view=metadata&exposureId=invalid"]) {
        const r = await get(path); expect(r.status).toBe(400); expect(r.body).not.toHaveProperty("records");
      }
    });
  });
});
