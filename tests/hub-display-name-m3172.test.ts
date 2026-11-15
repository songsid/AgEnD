import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:https";
import type { ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";
import { readHubDisplayName, saveHubDisplayName } from "../src/hub/display-name.js";
import { refreshHubDisplayName } from "../src/hub/member/display-name.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { createHubMemberPairingApi } from "../src/hub/member/pairing-api.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import { HUB_FLEET_INFO_CAPABILITY } from "../src/hub/fleet-info.js";
import { HUB_RECOMMENDATION_CAPABILITY } from "../src/hub/recommendation-model.js";
import type { HubMemberUpdates, MemberUpdateNotice } from "../src/hub/member/updates.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const f of close.splice(0).reverse()) await f(); } finally { vi.restoreAllMocks(); } });
async function world(name?: string) {
  const ports = hubListenerPorts(); close.push(() => ports.close());
  const rig = await hubRig({ memberPort: await ports.next(), serverDisplayName: name,
    serverCapabilities: [...HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_UPDATE_CAPABILITY, HUB_FLEET_INFO_CAPABILITY, HUB_RECOMMENDATION_CAPABILITY] });
  close.push(() => rig.close());
  const profile = await rig.pair(), before = new HubMemberProfileStore(rig.memberHome, rig.identity.hubId).profileDigest();
  const controller = new AbortController(); close.push(async () => controller.abort());
  const input = { home: rig.memberHome, profile, endpoint: rig.memberOrigin, current: () => true, signal: controller.signal };
  const server = (rig.server as unknown as { server: Server }).server;
  return { rig, profile, before, input, controller, server };
}

it("learns a code-only pairing's Unicode name over its pinned member origin without changing the profile", async () => {
  const w = await world("研一 Rig Hub");
  expect(existsSync(join(w.rig.memberHome, "hub-member/company-display"))).toBe(false);
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBeNull();
  expect(await refreshHubDisplayName(w.input)).toBe(true);
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBe("研一 Rig Hub");
  writeFileSync(join(w.rig.memberHome, "hub-member/state.json"), JSON.stringify({ hubId: w.profile.hub.hubId }), { mode: 0o600 });
  expect(createHubMemberPairingApi({ home: w.rig.memberHome }).view()).toMatchObject({ state: "paired", hub: { name: "研一 Rig Hub" } });
  expect(new HubMemberProfileStore(w.rig.memberHome, w.profile.hub.hubId).profileDigest()).toBe(w.before);
  expect(readHubDisplayName(w.rig.memberHome, { ...w.profile, fleetId: randomUUID() })).toBeNull();
  expect(readHubDisplayName(w.rig.memberHome, { ...w.profile, issuerKeyId: "e".repeat(64) })).toBeNull();
});

it("keeps a missing provider and blank name cosmetic, with the existing unknown-name fallback", async () => {
  const w = await world();
  expect(await refreshHubDisplayName(w.input)).toBe(false); // An older Hub serves 404.
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBeNull();
  saveHubDisplayName(w.rig.memberHome, w.profile, { name: "" }, () => true);
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBeNull();
  expect(new HubMemberProfileStore(w.rig.memberHome, w.profile.hub.hubId).profileDigest()).toBe(w.before);
});

it("refuses a held response after the current binding changes, and physically aborts a stopped lookup", async () => {
  const w = await world("Rig Hub");
  saveHubDisplayName(w.rig.memberHome, w.profile, { name: "Known Hub" }, () => true);
  const held: ServerResponse[] = [];
  w.server.removeAllListeners("request"); w.server.on("request", (_req, res) => held.push(res));
  let current = true;
  const pending = refreshHubDisplayName({ ...w.input, current: () => current });
  await vi.waitFor(() => expect(held).toHaveLength(1));
  current = false; held[0]!.end(JSON.stringify({ name: "Late Hub" }));
  expect(await pending).toBe(false);
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBe("Known Hub");
  const aborted = refreshHubDisplayName(w.input);
  await vi.waitFor(() => expect(held).toHaveLength(2));
  w.controller.abort(); expect(await aborted).toBe(false);
  await vi.waitFor(() => expect(held[1]!.destroyed).toBe(true));
});

it("bounds optional responses and does not follow redirects or send a bearer credential", async () => {
  const w = await world("Rig Hub");
  w.server.removeAllListeners("request");
  let requests = 0, status = 200, body = "not-json";
  w.server.on("request", (req, res) => { requests++; expect(req.headers.authorization).toBeUndefined(); res.writeHead(status, { Location: "/somewhere-else" }); res.end(body); });
  const cases = [{ status: 200, body: "not-json" }, { status: 200, body: JSON.stringify({ name: "x".repeat(201) }) },
    { status: 200, body: "x".repeat(4097) }, { status: 302, body: JSON.stringify({ name: "Redirect Hub" }) }];
  for (const value of cases) { status = value.status; body = value.body; expect(await refreshHubDisplayName(w.input)).toBe(false); }
  expect(requests).toBe(cases.length);
  expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBeNull();
});

it("does not gate member startup or update eligibility on a held display read, then names update notices and advice", async () => {
  const w = await world("Rig Hub");
  const handlers = w.server.listeners("request"), pending: (() => void)[] = [];
  w.server.removeAllListeners("request"); w.server.on("request", (req, res) => {
    pending.push(() => { for (const handler of handlers) Reflect.apply(handler, w.server, [req, res]); });
  });
  const host: { updates: HubMemberUpdates | null; advice: (() => { hubName: string } | null) | null } = { updates: null, advice: null };
  const notices: MemberUpdateNotice[] = [], states: string[] = [], reports: string[] = [];
  const create = createHubMemberFactory({ home: w.rig.memberHome, boundHub: () => w.profile.hub.hubId, components: MEMBER_COMPONENTS,
    agents: () => [], representative: { deliver: async () => false, agentToken: () => null, attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {}, log: () => {}, report: code => reports.push(code),
    fleetInfo: { version: "2.4.0-beta.3", runsAsService: true }, versionRegistry: async () => "found",
    updates: { idle: () => false, canInstall: async () => true, launch: async () => false, notify: n => { notices.push(n); return true; } },
    attachUpdates: value => { host.updates = value; }, attachRecommendations: read => { host.advice = read; }, linkState: state => states.push(state) });
  const service = await create({ enabled: true }, () => true); close.push(() => service.close());
  await service.start();
  expect(states.at(-1)).toBe("online"); expect(reports).toEqual([]);
  expect(host.updates!.consent()).toMatchObject({ available: true });
  await vi.waitFor(() => expect(pending).toHaveLength(1)); // Name is still unavailable; ready and eligibility already hold.
  pending[0]!();
  await vi.waitFor(() => expect(readHubDisplayName(w.rig.memberHome, w.profile)).toBe("Rig Hub"));
  host.updates!.setConsent(true);
  const linkEpoch = w.rig.received.find(f => f.type === "reconcile")!.linkEpoch, at = Date.now();
  await w.rig.server.send(w.profile.fleetId, { v: 1, type: "fleet.update", requestId: randomUUID(), linkEpoch,
    payload: { id: randomUUID(), version: "2.4.0-beta.4", requestedAt: at, expiresAt: at + 86_400_000, requestedBy: { name: "Alice" } } });
  await w.rig.server.send(w.profile.fleetId, { v: 1, type: "fleet.recommendation", requestId: randomUUID(), linkEpoch,
    payload: { revision: 1, version: "2.4.0-beta.4", setAt: at } });
  await vi.waitFor(() => { expect(notices[0]?.hubName).toBe("Rig Hub"); expect(host.advice?.()?.hubName).toBe("Rig Hub"); });
  if (process.env.AGEND_M3172_EVIDENCE_DIR) {
    writeFileSync(join(w.rig.memberHome, "hub-member/state.json"), JSON.stringify({ hubId: w.profile.hub.hubId }), { mode: 0o600 });
    const pairing = createHubMemberPairingApi({ home: w.rig.memberHome }).view();
    expect(pairing).toMatchObject({ state: "paired", hub: { name: "Rig Hub" } });
    if (pairing.state !== "paired") throw Error("The capture needs a paired view");
    const hostname = new URL(w.profile.hub.webOrigin).hostname;
    const candidate = { pairing, notice: notices[0], advice: host.advice?.() };
    const baseline = { pairing: { ...pairing, hub: { ...pairing.hub, name: null } }, notice: { ...notices[0], hubName: hostname }, advice: { ...host.advice?.(), hubName: hostname } };
    mkdirSync(process.env.AGEND_M3172_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.AGEND_M3172_EVIDENCE_DIR, "ui-data.json"), JSON.stringify({ candidate, baseline }, null, 2));
  }
});
