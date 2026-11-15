/** One owned TLS/WSS packet, no live Hub, directory, npm or vendor calls. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { HUB_CAPABILITIES, HUB_OPTIONAL_CAPABILITIES, encodeMemberFrame, encodeServerFrame, parseMemberFrame, parseServerFrame } from "../src/hub/protocol.js";
import { HubMemberRecommendations, HUB_MEMBER_RECOMMENDATION_MIGRATION } from "../src/hub/member/recommendations.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
it.each([[true,true], [true,false], [false,true]])("opts in by authenticated info value, without a seventeenth member hello (Hub=%s, receiver=%s)", async (hub, receiver) => {
  let resolve!: () => void; const delivered = new Promise<void>(r => { resolve = r; });
  const caps = [...HUB_OPTIONAL_CAPABILITIES, "fleet-info-v1", ...(hub ? ["fleet-recommend-v1"] : []), "room-ask-v1", "room-post-v1"];
  let r!: Awaited<ReturnType<typeof hubRig>>;
  r = await hubRig({ serverCapabilities: caps, clientInfo: { version: "2.4.0-beta.3", runsAsService: true }, clientRecommendations: receiver,
    clientCapabilities: [...HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1"],
    serverReady: link => { if (link.features.has("fleet-recommend-v1")) void r.server.send(link.fleetId, { v: 1, type: "fleet.recommendation", requestId: randomUUID(), linkEpoch: link.linkEpoch,
      payload: { version: "2.4.0-beta.4", revision: 1, setAt: Date.now() } }); else resolve(); } });
  rigs.push(r); HUB_MEMBER_RECOMMENDATION_MIGRATION.up(r.db); await r.pair();
  const lookup = vi.fn(async () => "found" as const);
  const received = new HubMemberRecommendations({ db: r.db, hubId: r.identity.hubId, hubName: "hub.test", version: "2.4.0-beta.3", current: () => true, now: Date.now, lookup });
  r.setReceive(async (frame, link) => {
    if (frame.type === "fleet.recommendation-ack") { resolve(); return; }
    if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch, payload: { receipts: [], nextReceiptSequence: 0, more: false } };
  });
  const c = r.client(async (frame, link) => { if (frame.type === "fleet.recommendation") received.receive(frame.payload, link); });
  await c.value.start(); await delivered;
  const info = r.received.find(f => f.type === "fleet.info")!;
  expect(info.payload).toEqual({ version: "2.4.0-beta.3", runsAsService: true, ...(hub && receiver ? { recommendations: true } : {}) });
  expect(c.state.link!.features.has("fleet-recommend-v1")).toBe(hub && receiver);
  expect(received.view()?.version ?? null).toBe(hub && receiver ? "2.4.0-beta.4" : null);
  expect(lookup).toHaveBeenCalledTimes(hub && receiver ? 1 : 0);
  expect(c.state.link!.current()).toBe(true);
  if (!(hub && receiver)) await expect(c.state.link!.send({ v: 1, type: "fleet.recommendation-ack", requestId: randomUUID(), linkEpoch: c.state.link!.linkEpoch,
    payload: { revision: 1, version: null, status: "cleared" } })).rejects.toMatchObject({ code: "incompatible" });
  expect([...HUB_CAPABILITIES, ...HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1"]).toHaveLength(16);
  expect(caps.length).toBeLessThanOrEqual(16); received.close();
});
it("accepts only fixed bounded version advice/ACKs, never text, origins, commands, tags or ranges", () => {
  const common = { v: 1 as const, requestId: randomUUID(), linkEpoch: 1 };
  const good = { ...common, type: "fleet.recommendation" as const, payload: { version: "2.4.0-beta.4", revision: 1, setAt: Date.now() } };
  expect(parseServerFrame(encodeServerFrame(good))).toEqual(good);
  for (const version of ["latest", "^2.4.0", "--help", "https://evil.test", "2.4.0\n", "x".repeat(129)]) expect(() => parseServerFrame(JSON.stringify({ ...good, payload: { ...good.payload, version } }))).toThrow();
  for (const extra of [{ text: "install now" }, { url: "https://evil.test" }, { command: "npm i" }]) expect(() => parseServerFrame(JSON.stringify({ ...good, payload: { ...good.payload, ...extra } }))).toThrow();
  const ack = { ...common, type: "fleet.recommendation-ack" as const, payload: { version: null, revision: 1, status: "cleared" as const } };
  expect(parseMemberFrame(encodeMemberFrame(ack))).toEqual(ack);
  expect(() => parseMemberFrame(JSON.stringify({ ...ack, payload: { ...ack.payload, status: "install" } }))).toThrow();
});
