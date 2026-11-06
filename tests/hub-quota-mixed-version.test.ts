import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { createQuotaPublisher } from "../src/hub/member/quota.js";
import { HUB_CAPABILITIES } from "../src/hub/protocol.js";
type Rig = Awaited<ReturnType<typeof hubRig>>;
let rig: Rig | null = null;
afterEach(async () => { await rig?.close(); rig = null; vi.restoreAllMocks(); });

// Pre-negotiation peers strictly accept these handshake payloads; unknown optional flags in hello were always legal.
const oldWelcome = z.strictObject({ selectedVersion: z.literal(1), hubId: z.string(), fleetId: z.string(), linkEpoch: z.number(), revocationVersion: z.number() });
const oldHello = z.strictObject({ supportedVersions: z.array(z.number()), capabilities: z.array(z.string()), memberBootId: z.string() });
describe("quota-band-v1 across real TLS/WSS mixed versions", () => {
  it.each(["old-member", "old-hub", "no-quota-hub", "new-peers"] as const)("negotiates %s without sending unrecognised frames", async version => {
    const wire: { type: string; payload: any }[] = [], original = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, ...args: any[]) {
      if (typeof args[0] === "string" && args[0].startsWith("{")) wire.push(JSON.parse(args[0]));
      return Reflect.apply(original, this, args);
    });
    rig = await hubRig({ serverCapabilities: version === "old-hub" ? [] : version === "no-quota-hub" ? ["welcome-caps-v1"] : undefined });
    await rig.pair();
    const c = rig.client(undefined, undefined, version === "old-member" ? [] : undefined); await c.value.start();
    const welcome = wire.find(f => f.type === "welcome")!, hello = wire.find(f => f.type === "hello")!;
    expect(oldHello.safeParse(hello.payload).success).toBe(true);
    expect(HUB_CAPABILITIES.every(flag => hello.payload.capabilities.includes(flag))).toBe(true);
    if (version === "old-member" || version === "old-hub") expect(oldWelcome.safeParse(welcome.payload).success).toBe(true);
    const read = vi.fn(async () => ({ band: "near_limit" as const }));
    const exposureId = randomUUID();
    const p = createQuotaPublisher({ exposures: () => [{ exposureId, agent: "agent" }], read });
    try {
      p.start(c.state.link!); await p.refresh();
      if (version === "new-peers") {
        await vi.waitFor(() => expect(rig!.received.some(f => f.type === "exposure.quota")).toBe(true));
        expect(c.state.link!.features.has("quota-band-v1")).toBe(true); expect(read).toHaveBeenCalledTimes(1);
        expect(wire.find(f => f.type === "exposure.quota")!.payload.quota).toEqual({ band: "near_limit" });
      } else {
        expect(c.state.link!.features.has("quota-band-v1")).toBe(false); expect(read).not.toHaveBeenCalled();
        await expect(c.value.send({ v: 1, type: "exposure.quota", requestId: randomUUID(), linkEpoch: c.state.link!.linkEpoch,
          payload: { exposureId, quota: { band: "near_limit" } } })).rejects.toThrow();
        expect(wire.filter(f => f.type === "exposure.quota")).toEqual([]);
      }
      expect(c.state.holds).toEqual([]);
    } finally { p.stop(); }
  });
});
