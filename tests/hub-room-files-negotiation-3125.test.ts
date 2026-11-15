/**
 * Fable #3925 P1s: room files are negotiated without a name of their own (roomFilesNegotiated: room-answer-buttons-v1 +
 * attachments-v1, as agent reactions ride on room-answer-buttons-v1). The real member factory composed at its fullest — files
 * and agent rooms — sends a hello the encoder accepts (at most 16 names), and against the Hub's own link list
 * (compose/server.ts hubLinkCapabilities) the negotiated link has room files. Never room-ask-v1 + attachments-v1 alone:
 * released alpha Fleets list both, and their strict room.ask schema refuses `attachments`.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { roomFilesNegotiated } from "../src/hub/protocol.js";
import type { HubMountedService } from "../src/hub/mount.js";
import { hubRig } from "./helpers/hub-rig.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [], services: HubMountedService[] = [], dirs: string[] = [];
afterEach(async () => { for (const s of services.splice(0)) { s.fence(); await s.close(); } for (const r of rigs.splice(0)) await r.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("the fullest member (files + agent rooms) is accepted by the encoder, and on the Hub's own list the link has room files", async () => {
  const hubFeatures = ["rooms-v1", "room-ask-v1", "room-post-v1", "person-prefs-v1"];
  const links: { features: ReadonlySet<string> }[] = [];
  const r = await hubRig({ serverCapabilities: hubLinkCapabilities({ memberConnected: () => {}, memberReady: () => {}, features: hubFeatures }), serverConnected: link => { links.push(link); } });
  rigs.push(r);
  const profile = await r.pair();
  r.setReceive(async (frame, link) => {
    if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch, payload: { receipts: [], nextReceiptSequence: 0, more: false } };
  });
  const state = mkdtempSync(join(tmpdir(), "agend-room-files-neg-")); dirs.push(state);
  const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => profile.hub.hubId,
    agents: () => [{ name: "general", display: "General" }],
    representative: { agentToken: () => "token", deliver: async () => true, attachReports: () => {}, readState: () => ({ process: "running", execution: "idle" }),
      files: { stateDir: state, inboxDir: () => join(state, "inbox"), scratchDir: () => join(state, "scratch") } },
    attachAgentRooms: () => {}, roomNotify: async () => true,
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {}, report: () => {}, log: () => {} } as any);
  const service = await create({}, () => true); services.push(service); await service.start();
  // Connected at all = the composed member's own hello passed encodeMemberFrame (over 16 names it throws and never goes out).
  await vi.waitFor(() => expect(links.length).toBeGreaterThan(0), { timeout: 10_000 });
  const link = links.at(-1)!;
  expect(roomFilesNegotiated(link.features)).toBe(true);
  expect(link.features.has("room-ask-v1") && link.features.has("room-post-v1")).toBe(true);
});

it("room files need room-answer-buttons-v1 and attachments-v1 — never room-ask-v1 + attachments-v1 alone (a released alpha lists both)", () => {
  expect(roomFilesNegotiated(new Set(["room-ask-v1", "attachments-v1"]))).toBe(false);
  expect(roomFilesNegotiated(new Set(["room-answer-buttons-v1"]))).toBe(false);
  expect(roomFilesNegotiated(new Set(["room-answer-buttons-v1", "attachments-v1"]))).toBe(true);
  expect(roomFilesNegotiated(undefined)).toBe(false);
});
