/**
 * #3226 seams §1: optional link features. A member offers HUB_OPTIONAL_CAPABILITIES beside the required set; the Hub
 * keeps the intersection on the link (`HubLinkContext.features`) and answers with its own list in `welcome.capabilities`
 * only when the hello offered welcome-caps-v1, so an older member's strict welcome schema never meets the field. Either
 * side may be older: the link still works, with no optional feature enabled. Real local TLS/WSS rig.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hubRig } from "./helpers/hub-rig.js";
import { HubSocket } from "../src/hub/socket.js";
import { HUB_CAPABILITIES, HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) await r.close(); });
async function rig(serverCapabilities?: readonly string[]) { const r = await hubRig(serverCapabilities ? { serverCapabilities } : {}); rigs.push(r); return r; }
/** The welcome every build before this one parses (strict: an unknown field drops the link). */
const OLD_WELCOME = z.strictObject({ selectedVersion: z.literal(1), hubId: z.string(), fleetId: z.string(), linkEpoch: z.number(), revocationVersion: z.number() });
function frames() {
  const sent: any[] = [], original = HubSocket.prototype.send;
  vi.spyOn(HubSocket.prototype, "send").mockImplementation(function (this: HubSocket<any, any>, frame: any) { sent.push(frame); return original.call(this, frame); });
  return sent;
}
const lease = async (c: { value: { authorize(r: unknown): Promise<{ operationId: string }> } }) => {
  const request = { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
  expect((await c.value.authorize(request)).operationId).toBe(request.operationId);
};

describe("optional link features (welcome-caps-v1)", () => {
  it("new member, new Hub: both keep the same enabled set; the welcome lists the Hub's features", async () => {
    const sent = frames(), r = await rig(), profile = await r.pair(), c = r.client(); await c.value.start();
    const hello = sent.find(f => f.type === "hello"), welcome = sent.find(f => f.type === "welcome");
    expect(hello.payload.capabilities).toEqual([...HUB_CAPABILITIES, ...HUB_OPTIONAL_CAPABILITIES]);
    expect(welcome.payload.capabilities).toEqual([...HUB_OPTIONAL_CAPABILITIES]);
    expect([...c.state.link!.features]).toEqual([...HUB_OPTIONAL_CAPABILITIES]);
    expect([...r.server.features(profile.fleetId)!]).toEqual([...HUB_OPTIONAL_CAPABILITIES]);
    await lease(c);
  });

  it("an older member (no optional features) with a new Hub: the welcome has no capabilities field, the link works, nothing is enabled", async () => {
    const sent = frames(), r = await rig(), profile = await r.pair(), c = r.client(undefined, undefined, []); await c.value.start();
    expect(sent.find(f => f.type === "hello").payload.capabilities).toEqual([...HUB_CAPABILITIES]);
    const welcome = sent.find(f => f.type === "welcome");
    expect(welcome.payload).not.toHaveProperty("capabilities");
    expect(OLD_WELCOME.safeParse(welcome.payload).success).toBe(true);
    expect(r.server.features(profile.fleetId)!.size).toBe(0);
    expect(c.state.link!.features.size).toBe(0);
    await lease(c);
  });

  it("a new member with an older Hub (it offers nothing and sends no list): the link works, nothing is enabled", async () => {
    const sent = frames(), r = await rig([]), profile = await r.pair(), c = r.client(); await c.value.start();
    expect(sent.find(f => f.type === "welcome").payload).not.toHaveProperty("capabilities");
    expect(c.state.link!.features.size).toBe(0);
    expect(r.server.features(profile.fleetId)!.size).toBe(0);
    await lease(c);
  });

  it("a feature only one side offers stays off on both; an unknown flag is ignored, never echoed", async () => {
    const sent = frames(), r = await rig(["welcome-caps-v1", "hub-only-v9"]), profile = await r.pair(), c = r.client(undefined, undefined, ["welcome-caps-v1", "member-only-v9"]); await c.value.start();
    expect(sent.find(f => f.type === "welcome").payload.capabilities).toEqual(["welcome-caps-v1", "hub-only-v9"]);
    expect([...c.state.link!.features]).toEqual(["welcome-caps-v1"]);
    expect([...r.server.features(profile.fleetId)!]).toEqual(["welcome-caps-v1"]);
  });

  it("features are per link: none before the link is ready, gone once it is replaced", async () => {
    const r = await rig(), profile = await r.pair(); expect(r.server.features(profile.fleetId)).toBeNull();
    const a = r.client(); await a.value.start(); expect(r.server.features(profile.fleetId)).not.toBeNull();
    const b = r.client(undefined, undefined, []); await b.value.start(); await vi.waitFor(() => expect(a.state.holds).toContain("replaced"));
    expect(r.server.features(profile.fleetId)!.size).toBe(0);
  });
});
