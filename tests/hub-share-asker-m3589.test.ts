/** Owned HTTP/SQLite only: a catalog lapse is a refusal, never new consent. */
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { HubRoomPostAdapter, isShareLapsed } from "../src/hub/member/room-post.js";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { HUB_AGENT_CATALOG_LAPSE_CAPABILITY } from "../src/hub/agent-catalog-model.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
async function world() {
  const r = rig = await s3bRig();
  const owner = r.admin, asker = r.addPerson("asker", "Asker"), fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, s => {
    s.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", HUB_AGENT_CATALOG_LAPSE_CAPABILITY]);
  r.http.memberConnected!(link);
  const exposureId = randomUUID();
  const snapshot = async (revision: number) => r.http.receive(r.frame("exposure.snapshot", { revision, exposures: [{ id: exposureId, fleetId, owner,
    displayName: "Notes", revision, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  await snapshot(1);
  const o = await r.signIn("admin"), a = await r.signIn("asker");
  const group = await r.call(o, "POST", "/hub/v1/rooms", { name: "Planning", people: [personKeyString(asker)] });
  expect(group.status).toBe(200); const groupId = group.json.room.id;
  expect((await r.call(o, "POST", `/hub/v1/rooms/${groupId}/members`, { kind: "agent", id: exposureId })).status).toBe(200);
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 });
  expect(grant.status).toBe(200);
  const direct = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.json.grant.id });
  expect(direct.status).toBe(200); const directId = direct.json.room.id;
  let report = 0;
  const catalog = async (lapsed: boolean, revision = 1) => r.http.receive(r.frame("agent.catalog", { enabled: true, requests: true, revision: String(++report).padStart(64, "0"), agents: [{
    instance: "notes", displayName: "Notes", description: "Takes notes", avatar: null, kind: "agent", general: false, shareable: true,
    exposure: { id: exposureId, revision, state: "published", ...(lapsed ? { lapsed: true } : {}) },
  }] }, link) as never, link);
  const ask = async (room: string) => r.call(a, "POST", `/hub/v1/rooms/${room}/messages`, { text: "What is next?", mentions: room === groupId ? [exposureId] : [], idempotencyKey: randomUUID() });
  return { r, o, a, groupId, directId, catalog, ask, snapshot, exposureId, link, grant };
}
it("a known lapse tells the group asker now, rather than leaving a working placeholder", async () => {
  const w = await world(); await w.catalog(true);
  const question = await w.ask(w.groupId); expect(question.status).toBe(200);
  const messages = (await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.groupId}/messages`)).json.messages;
  expect(messages.find((m: any) => m.answerTo === question.json.id)).toMatchObject({ stage: "not-answered", reasonCode: "share-needs-reshare" });
  expect(w.r.sent.filter(s => s.frame.type === "room.ask")).toHaveLength(0);
});
it("a known lapse gives the direct asker a terminal receipt without sending the question", async () => {
  const w = await world(); await w.catalog(true);
  const question = await w.ask(w.directId); expect(question.status).toBe(200);
  expect(question.json.receipt).toMatchObject({ stage: "cancelled", reasonCode: "share-needs-reshare" });
  const messages = (await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.directId}/messages`)).json.messages;
  expect(messages.find((m: any) => m.id === question.json.id)).toMatchObject({ text: "What is next?", stage: "not-answered", reasonCode: "share-needs-reshare" });
  expect(w.r.sent.filter(s => s.frame.type === "question")).toHaveLength(0);
});
it("a lapse report settles an existing group ask and direct question, and a later catalog cannot reopen them", async () => {
  const w = await world(); await w.catalog(false);
  const group = await w.ask(w.groupId), direct = await w.ask(w.directId);
  expect(group.status).toBe(200); expect(direct.status).toBe(200);
  await w.catalog(true);
  const page = (await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.groupId}/messages`)).json.messages;
  expect(page.find((m: any) => m.answerTo === group.json.id)).toMatchObject({ stage: "not-answered", reasonCode: "share-needs-reshare" });
  expect(w.r.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(direct.json.id)).toEqual({ stage: "cancelled", reason_code: "share-needs-reshare" });
  await w.catalog(false);
  expect(w.r.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(direct.json.id)).toEqual({ stage: "cancelled", reason_code: "share-needs-reshare" });
});
it("an unchanged share still works, and explicit Share again restores new questions while old ones remain terminal", async () => {
  const w = await world(); await w.catalog(false);
  const working = await w.ask(w.groupId);
  expect((await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.groupId}/messages`)).json.messages.find((m: any) => m.answerTo === working.json.id)?.reasonCode).toBeUndefined();
  await w.catalog(true);
  const refused = await w.ask(w.directId); expect(refused.json.receipt.reasonCode).toBe("share-needs-reshare");
  // The real snapshot path consumes the lapse and carries existing grants only on an explicit next-revision republish.
  await w.snapshot(2); await w.catalog(false, 2);
  const before = w.r.sent.filter(s => s.frame.type === "room.ask").length;
  expect((await w.ask(w.groupId)).status).toBe(200);
  expect(w.r.db.prepare("SELECT state FROM hub_room_deliveries ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ state: "sent" });
  expect(w.r.sent.filter(s => s.frame.type === "room.ask")).toHaveLength(before + 1);
  expect((await w.ask(w.directId)).json.receipt.stage).toBe("queued");
  expect(w.r.db.prepare("SELECT stage FROM hub_messages WHERE id=?").get(refused.json.id)).toEqual({ stage: "cancelled" });
});
it.each(["generation", "owner", "exposure-revision"] as const)("a stale %s catalog cannot claim the current share lapsed", async mismatch => {
  const w = await world(); await w.catalog(true, mismatch === "exposure-revision" ? 2 : 1);
  if (mismatch === "generation") w.r.db.prepare("UPDATE hub_agent_catalogs SET generation=2").run();
  if (mismatch === "owner") w.r.db.prepare("UPDATE hub_agent_catalogs SET owner=?").run(personKeyString({ realm: "corp", objectId: randomUUID() }));
  const question = await w.ask(w.directId); expect(question.status).toBe(200);
  expect(question.json.receipt.stage).toBe("queued");
});

it("backend switch: real incarnation rotation exposes the owner notice, room-tool cause and asker refusal; consent never follows", async () => {
  const w = await world(), home = mkdtempSync(join(tmpdir(), "agend-share-lapse-")), fm = new FleetManager(home);
  const db = new Database(":memory:");
  try {
    const manager = fm as any;
    manager.fleetConfig = { instances: { notes: { backend: "claude-code", working_directory: home }, unchanged: { backend: "codex", working_directory: home } } };
    const consent = { agent: "notes", token: manager.hubAgentToken("notes") }, unchanged = manager.hubAgentToken("unchanged");
    const committed = { consentId: "synthetic-consent", exposure: { state: "published" } };
    const lapsed = () => isShareLapsed("notes", committed, consent, manager.hubAgentToken("notes"));
    expect(lapsed()).toBe(false);
    manager.fleetConfig.instances.notes.backend = "codex"; manager.observeHubAgentIncarnations();
    expect(lapsed()).toBe(true); expect(manager.hubAgentToken("unchanged")).toBe(unchanged);
    const needs = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined,
      hubShareLapses: [{ agent: "notes", key: manager.hubAgentToken("notes"), since: 1000 }] });
    expect(needs).toMatchObject([{ instance: "notes", reason: "hub_share_lapsed" }]);
    const tools = new HubRoomPostAdapter({ db, binding: "synthetic", encryptionKey: Buffer.alloc(32, 7), current: () => true,
      local: () => null, lapsed });
    const caller = { agent: "notes", current: () => true };
    for (const result of [await tools.rooms(caller), await tools.members(caller, "Planning"), await tools.people(caller, "Owner"),
      await tools.post(caller, { room: "Planning", text: "Hello", operationId: randomUUID() })]) {
      expect(result).toMatchObject({ ok: false, code: "share_needs_reshare", message: expect.stringContaining("backend") });
    }
    await w.catalog(lapsed()); expect((await w.ask(w.directId)).json.receipt.reasonCode).toBe("share-needs-reshare");
    manager.fleetConfig.instances.notes.backend = "claude-code"; manager.observeHubAgentIncarnations();
    expect(lapsed()).toBe(true); // A→B→A is a third incarnation; an old consent never revives.
  } finally { db.close(); fm.stormWindow.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
