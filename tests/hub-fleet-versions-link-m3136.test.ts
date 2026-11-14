/** One owned local TLS/WSS compatibility packet; no live Fleet, directory or vendor calls. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
it.each([false, true])("sends version values only to a reporting Hub (offer=%s), before reconciliation", async supported => {
  const r = await hubRig({ serverCapabilities: [...HUB_OPTIONAL_CAPABILITIES, ...(supported ? ["fleet-info-v1"] : [])],
    clientCapabilities: [...HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1"],
    clientInfo: { version: "2.4.0-beta.4", runsAsService: true } });
  rigs.push(r); await r.pair(); const c = r.client(); await c.value.start();
  const reports = r.received.filter(f => f.type === "fleet.info");
  expect(reports).toHaveLength(supported ? 1 : 0);
  if (supported) {
    expect(reports[0]!.payload).toEqual({ version: "2.4.0-beta.4", runsAsService: true });
    expect(r.received[0]!.type).toBe("fleet.info");
  } else {
    await expect(c.state.link!.send({ v: 1, type: "fleet.info", requestId: randomUUID(), linkEpoch: c.state.link!.linkEpoch,
      payload: { version: "2.4.0", runsAsService: false } })).rejects.toMatchObject({ code: "incompatible" });
  }
  expect(c.state.link!.current()).toBe(true);
});
