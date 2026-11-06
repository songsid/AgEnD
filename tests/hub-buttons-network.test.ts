import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import * as protocol from "../src/hub/protocol.js";
import type { HubServerFrame } from "../src/hub/types.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });

describe("buttons-v1 mixed-version TLS/WSS negotiation", () => {
  it.each([
    ["new member / new Hub", undefined, undefined, true],
    ["old member / new Hub", [], undefined, false],
    ["new member / old Hub", undefined, [], false],
    ["new member / attachments-only Hub", undefined, ["welcome-caps-v1", "attachments-v1"], false],
  ] as const)("%s keeps text/reconcile working and enables buttons only by intersection", async (_label, clientCapabilities, serverCapabilities, enabled) => {
    const frames: HubServerFrame[] = [];
    const original = protocol.encodeServerFrame;
    vi.spyOn(protocol, "encodeServerFrame").mockImplementation(frame => { frames.push(structuredClone(frame)); return original(frame); });
    // Smaller optional lists stand in for prior protocol implementations; required identity/receipt flags stay intact.
    const r = await hubRig({ clientCapabilities, serverCapabilities }); rigs.push(r);
    const profile = await r.pair(), c = r.client(); await c.value.start();
    expect(c.state.syncs).toBe(1);
    expect(c.state.link!.features.has("buttons-v1")).toBe(enabled);
    expect(r.server.features(profile.fleetId)!.has("buttons-v1")).toBe(enabled);
    const request = { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
    expect((await c.value.authorize(request)).operationId).toBe(request.operationId);
    expect(r.received.map(f => f.type)).toEqual(["reconcile", "authorize.request"]);
    if (clientCapabilities?.length === 0) {
      const welcome = frames.find((f): f is Extract<HubServerFrame, { type: "welcome" }> => f.type === "welcome");
      expect(welcome).toBeDefined();
      expect(Object.hasOwn(welcome!.payload, "capabilities")).toBe(false); // the old strict welcome parser sees no new field
    }
  });
});
