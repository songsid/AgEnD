/**
 * M-3543, the Hub side (the user's choice A, 2026-11-23): "Share again" of a LAPSED agent republishes it at the next
 * revision and keeps the people who may ask it — only active, unexpired grants, their original expiry. A published agent
 * that did not lapse still cannot be shared again, and the carry is one switchable step. The real Hub HTTP rig.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { agentCatalogSchema, HUB_AGENT_CATALOG_LAPSE_CAPABILITY, HUB_EXPOSURE_REQUEST_CAPABILITY, type HubAgentCatalog } from "../src/hub/agent-catalog-model.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";
import { carryLapsePermissions, HUB_LAPSE_CARRY } from "../src/hub/lapse-carry.js";
import { memberAgentCatalog } from "../src/hub/member/agent-catalog.js";
import type { HubFleetExposure, HubMemberFrame } from "../src/hub/types.js";
import { personKeyString } from "../src/hub/identity.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

async function world() {
  let now = 1_800_000_000_000;
  const r = rig = await s3bRig({ now: () => now });
  const owner = r.addPerson("owner", "Owner"), reader = r.addPerson("reader", "Reader"), fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: now, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", HUB_AGENT_CATALOG_LAPSE_CAPABILITY]);
  r.http.memberConnected!(link);
  const exposureId = randomUUID();
  const exposure = (revision: number): HubFleetExposure => ({ id: exposureId, owner, fleetId, displayName: "Document helper", revision,
    state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure(1)] }, link), link);
  let n = 0;
  const catalog = async (lapsed: boolean) => {
    const body: HubAgentCatalog = { enabled: true, requests: true, revision: String(++n).padStart(64, "0"), agents: [{ instance: "Docs", displayName: "Document helper",
      description: "A helper", avatar: null, kind: "agent", general: false, shareable: true,
      exposure: { id: exposureId, revision: 1, state: "published", ...(lapsed ? { lapsed: true as const } : {}) } }] };
    await r.http.receive(r.frame("agent.catalog", body, link), link); return body;
  };
  const browser = await r.signIn("owner");
  const shareAgain = async (revision: string) => r.call(browser, "POST", "/hub/v1/me/agent-sharing", { idempotencyKey: randomUUID(), fleetId, catalogRevision: revision, share: ["Docs"], stop: [] });
  const result = async (id: string, results: unknown[]) => r.http.receive({ ...r.frame("exposure.request-result", { noticeAt: now, undoUntil: now + 86_400_000, results }, link), requestId: id } as Exclude<HubMemberFrame, { type: "hello" }>, link);
  const grant = (state: "active" | "revoked", expiresAt: number) => {
    const id = randomUUID();
    r.db.prepare(`INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state)
      VALUES(?,1,?,?,1,?,?,?,'["ask"]',?,?,?)`).run(id, personKeyString(owner), exposureId, "x", now, "reader", now - 1, expiresAt, state);
    return id;
  };
  const read = (id: string) => r.db.prepare("SELECT exposure_revision, expires_at, state FROM hub_grants WHERE id=?").get(id) as { exposure_revision: number; expires_at: number; state: string };
  return { r, now: () => now, owner, reader, fleetId, link, exposureId, catalog, shareAgain, result, grant, read };
}

describe("negotiation: only with exposure requests, and only to a member that can read a 32-name welcome", () => {
  it("the Hub offers agent-catalog-lapse-v1 with exposure requests; an old member's welcome never carries it", () => {
    expect(hubLinkCapabilities({ agentCatalogV1: true, exposureRequestsV1: true })).toContain(HUB_AGENT_CATALOG_LAPSE_CAPABILITY);
    expect(hubLinkCapabilities({ agentCatalogV1: true })).not.toContain(HUB_AGENT_CATALOG_LAPSE_CAPABILITY);
    expect(hubWelcomeCapabilities([HUB_EXPOSURE_REQUEST_CAPABILITY, HUB_AGENT_CATALOG_LAPSE_CAPABILITY], ["welcome-caps-v1"])).toEqual([]);
  });
  it("the member's catalog says lapsed only when asked to, and its revision changes with it", () => {
    const row = { instance: "Docs", displayName: "D", description: "", avatar: null, kind: "agent" as const, general: false, shareable: true as const,
      exposure: { id: randomUUID(), revision: 1, state: "published" as const }, incarnation: "i" };
    const plain = memberAgentCatalog(true, [row], true), lapsed = memberAgentCatalog(true, [row], true, () => true);
    expect(plain.agents[0]!.exposure).not.toHaveProperty("lapsed");
    expect(lapsed.agents[0]!.exposure).toMatchObject({ lapsed: true });
    expect(lapsed.revision).not.toBe(plain.revision);
    expect(agentCatalogSchema.safeParse(lapsed).success).toBe(true);
    expect(memberAgentCatalog(true, [row], false, () => true).agents[0]).not.toHaveProperty("exposure");
  });
});

describe("Share again on the Hub", () => {
  it("a lapsed agent: accepted; on the Fleet's republish its active, unexpired grants move to the new revision with their expiry", async () => {
    const w = await world();
    const live = w.grant("active", w.now() + 86_400_000), expired = w.grant("active", w.now() - 1), revoked = w.grant("revoked", w.now() + 86_400_000);
    const report = await w.catalog(true);
    const accepted = await w.shareAgain(report.revision);
    expect(accepted.status).toBe(200);
    await w.result(accepted.json.id, [{ instance: "Docs", ok: true, before: { id: w.exposureId, revision: 1, state: "published" }, after: { id: w.exposureId, revision: 2, state: "published" } }]);
    expect(w.read(live)).toEqual({ exposure_revision: 2, expires_at: w.now() + 86_400_000, state: "active" });
    expect(w.read(expired)).toMatchObject({ exposure_revision: 1 });
    expect(w.read(revoked)).toMatchObject({ exposure_revision: 1, state: "revoked" });
  });
  it("a published agent that did not lapse: still refused (no Share again of a working share)", async () => {
    const w = await world();
    const report = await w.catalog(false);
    expect((await w.shareAgain(report.revision)).status).not.toBe(200);
  });
});

describe("carryLapsePermissions: one switchable step", () => {
  it("only the next revision, only active unexpired grants; the switch exists and is on", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE hub_grants(id TEXT, revision INTEGER, exposure_id TEXT, exposure_revision INTEGER, state TEXT, expires_at INTEGER);
      CREATE TABLE hub_room_agent_discovery(exposure_id TEXT, exposure_revision INTEGER, revision INTEGER, updated_at INTEGER)`);
    db.prepare("INSERT INTO hub_grants VALUES('a',1,'e',4,'active',2000),('b',1,'e',4,'active',500),('c',1,'e',4,'revoked',2000),('d',1,'e',3,'active',2000)").run();
    db.prepare("INSERT INTO hub_room_agent_discovery VALUES('e',4,1,0)").run();
    expect(carryLapsePermissions(db, "e", 4, 6, 1000)).toEqual({ grants: 0, discovery: 0 });          // not the next revision
    expect(carryLapsePermissions(db, "e", 4, 5, 1000)).toEqual({ grants: 1, discovery: 1 });
    expect(db.prepare("SELECT id, exposure_revision, expires_at FROM hub_grants ORDER BY id").all()).toEqual([
      { id: "a", exposure_revision: 5, expires_at: 2000 }, { id: "b", exposure_revision: 4, expires_at: 500 },
      { id: "c", exposure_revision: 4, expires_at: 2000 }, { id: "d", exposure_revision: 3, expires_at: 2000 }]);
    expect(HUB_LAPSE_CARRY).toBe(true);
    db.close();
  });
});
