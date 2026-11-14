import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";
import { HubProtocolError } from "../src/hub/validation.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
it("keeps hello and later work usable when both diagnostics hooks throw, with sanitized warnings", async () => {
  const warnings: unknown[][] = [];
  const r = await hubRig({ serverCapabilities: [...HUB_OPTIONAL_CAPABILITIES, "fleet-info-v1"],
    clientInfo: { version: "2.4.0", runsAsService: false },
    serverConnected: () => { throw Error("SQLITE_BUSY private-diagnostic-data"); },
    serverLog: (...args) => { warnings.push(args); } });
  rigs.push(r); await r.pair();
  r.setReceive(async (frame, link) => {
    if (frame.type === "fleet.info") throw new HubProtocolError("revoked");
    if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch,
      payload: { receipts: [], nextReceiptSequence: 0, more: false } };
  });
  const c = r.client(); await c.value.start();
  const link = c.state.link!;
  expect(link.current()).toBe(true);
  const reply = await link.exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: link.linkEpoch,
    payload: { messages: [], afterReceiptSequence: 0 } }, "reconcile");
  expect(reply.type).toBe("reconcile");
  expect(warnings).toEqual([
    ["warn", "Hub Fleet diagnostics were not recorded", { fleetId: link.profile.fleetId, phase: "connect" }],
    ["warn", "Hub Fleet diagnostics were not recorded", { fleetId: link.profile.fleetId, phase: "report" }],
  ]);
  expect(JSON.stringify(warnings)).not.toContain("private-diagnostic-data");
});
