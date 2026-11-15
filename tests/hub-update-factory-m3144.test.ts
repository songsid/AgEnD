/** One owned TLS/WSS factory journey. The Hub peer, registry, directory and launch are inert. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_CAPABILITIES, HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import type { HubLinkContext } from "../src/hub/server.js";
import { HUB_FLEET_INFO_CAPABILITY } from "../src/hub/fleet-info.js";
import type { HubMemberUpdates } from "../src/hub/member/updates.js";
import { hubRig } from "./helpers/hub-rig.js";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });
it.skipIf(process.platform === "win32")("offers remote updates only with its host hooks, reports consent and returns durable request status through the pinned link", async () => {
  let link: HubLinkContext | null = null;
  const rig = await hubRig({ serverCapabilities: [...HUB_CAPABILITIES, ...HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_INFO_CAPABILITY, HUB_FLEET_UPDATE_CAPABILITY], serverReady: l => { link = l; } });
  let service: Awaited<ReturnType<ReturnType<typeof createHubMemberFactory>>> | undefined;
  close = async () => { await service?.close(); await rig.close(); };
  await rig.pair();
  let updates: HubMemberUpdates | null = null, idle = false;
  const notices: unknown[] = [];
  const launch = vi.fn(async (_row, control) => control.claim());
  const create = createHubMemberFactory({ home: rig.memberHome, boundHub: () => rig.identity.hubId, components: MEMBER_COMPONENTS,
    agents: () => [{ name: "general", display: "General" }], representative: { deliver: async () => false, agentToken: () => "t".repeat(64), attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {}, linkState: () => {}, notice: () => {}, report: () => {}, log: () => {},
    fleetInfo: { version: "2.3.5", runsAsService: true }, versionRegistry: async () => "found",
    updates: { idle: () => idle, canInstall: async () => true, launch, notify: n => { notices.push(n); return true; } }, attachUpdates: v => { updates = v; } });
  service = await create({ enabled: true }, () => true); await service.start();
  await vi.waitFor(() => expect(link?.features.has(HUB_FLEET_UPDATE_CAPABILITY)).toBe(true));
  expect(updates!.consent().on).toBe(false); updates!.setConsent(true);
  await vi.waitFor(() => expect(rig.received.some(f => f.type === "fleet.info" && f.payload.updatesAllowed === true)).toBe(true));
  const request = { id: randomUUID(), version: "2.4.0", requestedAt: Date.now(), expiresAt: Date.now() + 7 * 86_400_000, requestedBy: { name: "Alex" } };
  await rig.server.send(link!.fleetId, { v: 1, type: "fleet.update", requestId: randomUUID(), linkEpoch: link!.linkEpoch, payload: request });
  await vi.waitFor(() => expect(notices).toHaveLength(1)); expect(launch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(rig.received.some(f => f.type === "fleet.update-status" && f.payload.state === "waiting")).toBe(true));
  idle = true; await updates!.tick(); expect(launch).toHaveBeenCalledTimes(1);
  updates!.complete(request.id, "done", request.version); await updates!.tick();
  await vi.waitFor(() => expect(rig.received.some(f => f.type === "fleet.update-status" && f.payload.state === "done")).toBe(true));
  const status = rig.received.filter(f => f.type === "fleet.update-status").at(-1)!;
  if (status.type !== "fleet.update-status") throw Error("missing status");
  await rig.server.send(link!.fleetId, { v: 1, type: "fleet.update-status-ack", requestId: randomUUID(), linkEpoch: link!.linkEpoch,
    payload: { id: request.id, version: request.version, sequence: status.payload.sequence } });
  service.fence(); expect(updates).toBeNull(); expect(launch).toHaveBeenCalledTimes(1);
});
