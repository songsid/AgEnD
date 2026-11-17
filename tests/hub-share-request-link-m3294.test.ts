/** One isolated actual pinned WSS/member factory → Hub HTTP/SQLite journey, with no vendor or live Fleet. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import { WebNotices } from "../src/web-notices.js";
import { join } from "node:path";
import type { HubSharingController } from "../src/hub-sharing-notice.js";
import type { HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
it("applies an owner share once, recovers a lost result ACK, and keeps durable Undo available after a member restart", async () => {
  const ports = hubListenerPorts(); cleanup.push(() => ports.close());
  const capabilities = hubLinkCapabilities({ agentCatalogV1: true, exposureRequestsV1: true, features: [HUB_FLEET_UPDATE_CAPABILITY] });
  const net = await hubRig({ memberPort: await ports.next(), serverCapabilities: capabilities }); cleanup.push(() => net.close()); await net.pair();
  const web = await s3bRig({ administrator: net.owner, realAudit: true }); cleanup.push(() => web.close());
  web.httpDeps.store = net.store; web.httpDeps.pairing = net.pairing; web.httpDeps.transport = () => net.server; await web.restartHttp();
  let loseAck = true, results = 0;
  net.setReceive(async (frame, link) => {
    const result = await web.http.receive(frame, link);
    if (frame.type === "exposure.request-result") { results++; if (loseAck) { loseAck = false; return; } }
    return result;
  });
  const notices = new WebNotices(join(net.memberHome, "sharing-notices.json"), { warn() {} });
  let controller: HubSharingController | null = null, api: HubMemberExposureApi | null = null;
  const token = "c".repeat(64);
  const create = createHubMemberFactory({ home: net.memberHome, components: MEMBER_COMPONENTS, boundHub: () => net.identity.hubId,
    agents: () => [{ name: "Docs", display: "Documents" }], catalogAgents: () => [{ instance: "Docs", displayName: "Documents", description: "A helper", avatar: null,
      kind: "agent", general: false, shareable: true, incarnation: token }],
    sharingNotice: async notice => !!notices.upsertSharing(notice, "Sharing notice"), attachSharing: value => { controller = value; },
    representative: { deliver: async () => false, agentToken: () => token, attachReports() {} },
    fleetInfo: { version: "2.4.0-beta.10", runsAsService: true }, versionRegistry: async () => "not-found",
    updates: { idle: () => true, canInstall: async () => false, launch: async () => false, notify: () => true },
    attachExposures: value => { api = value; }, attachAttention() {}, pokeAttention() {}, report() {}, log() {} });
  let service = await create({ enabled: true }, () => true); cleanup.push(() => service.close()); await service.start();
  const owner = await web.signIn("admin");
  await vi.waitFor(async () => expect((await web.call(owner, "GET", "/hub/v1/me/agents")).json.fleets[0]?.catalog?.requests).toBe(true));
  const fleet = (await web.call(owner, "GET", "/hub/v1/me/agents")).json.fleets[0];
  const requestId = randomUUID(), input = { idempotencyKey: requestId, fleetId: fleet.id, catalogRevision: fleet.catalog.revision, share: ["Docs"], stop: [] };
  expect((await web.call(owner, "POST", "/hub/v1/me/agent-sharing", input)).status).toBe(200);
  await vi.waitFor(() => expect(api!.list()[0].state).toBe("published"));
  const first = api!.list()[0];
  await vi.waitFor(() => expect(results).toBe(1));
  // A Hub retry can cross our result while its ACK is missing: the same operation id is not an RPC-type violation.
  const frozen = web.db.prepare("SELECT body FROM hub_sharing_requests WHERE id=?").get(requestId) as { body: string };
  const epoch = net.received.find(frame => frame.type === "exposure.request-result")!.linkEpoch;
  await net.server.send(fleet.id, { v: 1, type: "exposure.request", requestId, linkEpoch: epoch, payload: JSON.parse(frozen.body) });
  const catalogCount = net.received.filter(frame => frame.type === "agent.catalog").length;
  await net.server.send(fleet.id, { v: 1, type: "agent.catalog-refresh", requestId: randomUUID(), linkEpoch: epoch, payload: {} });
  await vi.waitFor(() => expect(net.received.filter(frame => frame.type === "agent.catalog").length).toBeGreaterThan(catalogCount));
  expect(api!.list()[0].revision).toBe(first.revision);
  const saved = notices.view().items[0]; expect(saved.hubSharing?.state).toBe("complete"); expect(saved.hubSharing?.rows[0].state).toBe("shared");
  service.fence(); await service.close();
  service = await create({ enabled: true }, () => true); await service.start();
  await vi.waitFor(() => expect(results).toBe(2));
  expect(api!.list()[0]).toMatchObject({ exposureId: first.exposureId, revision: first.revision, state: "published" });
  const reopened = new WebNotices(join(net.memberHome, "sharing-notices.json"), { warn() {} });
  expect(reopened.view().items[0].id).toBe(saved.id);
  await expect(controller!.undo(saved.hubSharing!.key, "administrator", () => false)).rejects.toMatchObject({ code: "denied" });
  const undo = await controller!.undo(saved.hubSharing!.key, "administrator", () => true);
  expect(undo.rows[0].state).toBe("undone"); expect(api!.list()[0].state).toBe("withdrawn");
  await vi.waitFor(async () => expect((await web.call(owner, "GET", `/hub/v1/me/agent-sharing/${requestId}`)).json.undo?.results[0].ok).toBe(true));
  expect(notices.view().items).toHaveLength(1);
  await expect(controller!.undo(saved.hubSharing!.key, "administrator", () => true)).resolves.toMatchObject({ state: "undone" });
  expect(api!.list()[0].revision).toBe(first.revision + 1);
}, 20_000);
