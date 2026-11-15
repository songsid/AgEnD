/** One owned TLS/WSS packet with a beta.3-shaped16-cap codec; no real Fleet or updater. */
import { afterEach, expect, it, vi } from "vitest";
import * as protocol from "../src/hub/protocol.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { hubRig } from "./helpers/hub-rig.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });
const oldMember = [...protocol.HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1"];
const oldHub = [...protocol.HUB_OPTIONAL_CAPABILITIES, "fleet-info-v1", "fleet-recommend-v1", "room-ask-v1", "room-post-v1", "fixture-extra-v1"];
const next = protocol.HUB_FLEET_UPDATE_CAPABILITY;
it("retries one17-name hello as the exact16-name legacy offer on the same authenticated pairing", async () => {
  const original = protocol.parseMemberFrame, hellos: string[][] = [], logs: unknown[][] = [];
  vi.spyOn(protocol, "parseMemberFrame").mockImplementation(input => {
    const f = original(input);
    if (f.type === "hello") { hellos.push([...f.payload.capabilities]); if (f.payload.capabilities.length > 16) throw new HubProtocolError(); }
    return f;
  });
  const r = await hubRig({ serverCapabilities: oldHub, clientCapabilities: [...oldMember, next], clientLog: (...args) => { logs.push(args); } }); rigs.push(r);
  const paired = await r.pair(), c = r.client(); await c.value.start();
  expect(hellos.map(h => h.length)).toEqual([17,16]); expect(hellos[1]).toEqual(hellos[0]!.filter(c => c !== next));
  expect(c.state.link!.profile.fleetId).toBe(paired.fleetId); expect(c.state.link!.profile.owner).toEqual(paired.owner);
  expect(c.state.link!.profile.hub.hubId).toBe(paired.hub.hubId); expect(c.state.link!.features.has(next)).toBe(false);
  expect(c.state.link!.current()).toBe(true); expect(logs).toEqual([["info", "Retrying Hub connection with a legacy capability offer", {phase:"legacy-hello"}]]);
});
it.each([false,true])("exceeds16 in welcome only after the exact modern hello offer (modern=%s)", async modern => {
  const parse = protocol.parseServerFrame, welcomeSizes: number[] = [];
  vi.spyOn(protocol, "parseServerFrame").mockImplementation(input => {
    const f = parse(input);
    if (f.type === "welcome") { const n = f.payload.capabilities?.length ?? 0; welcomeSizes.push(n); if (!modern && n > 16) throw new HubProtocolError(); }
    return f;
  });
  const r = await hubRig({ serverCapabilities: [...oldHub,next], clientCapabilities: [...oldMember,...(modern?[next]:[])] }); rigs.push(r);
  await r.pair(); const c = r.client(); await c.value.start();
  expect(welcomeSizes).toEqual([modern?17:16]); expect(c.state.link!.features.has(next)).toBe(modern); expect(c.state.link!.current()).toBe(true);
});
it("does not loop the legacy retry when even the legacy hello is refused", async () => {
  const original = protocol.parseMemberFrame, lengths: number[] = [], logs: unknown[][] = [];
  vi.spyOn(protocol, "parseMemberFrame").mockImplementation(input => {
    const f=original(input); if(f.type==="hello") { lengths.push(f.payload.capabilities.length); throw new HubProtocolError(); } return f;
  });
  const r=await hubRig({serverCapabilities:oldHub,clientCapabilities:[...oldMember,next],clientLog:(...args)=>{logs.push(args);}}); rigs.push(r);
  await r.pair(); const c=r.client(); await expect(c.value.start()).rejects.toThrow(); await c.value.close();
  expect(lengths).toEqual([17,16]); expect(logs).toHaveLength(1);
});
it("does not use the legacy retry for an authentication refusal", async () => {
  const logs: unknown[][]=[]; const r=await hubRig({serverCapabilities:oldHub,clientCapabilities:[...oldMember,next],clientLog:(...args)=>{logs.push(args);}}); rigs.push(r);
  await r.pair(); r.disableOwner(); const c=r.client(); await expect(c.value.start()).rejects.toThrow(); expect(logs).toHaveLength(0); expect(c.state.holds).toContain("rejected");
});
it("does not use the legacy retry after welcome when reconciliation fails", async () => {
  const logs: unknown[][]=[]; const r=await hubRig({serverCapabilities:[...oldHub,next],clientCapabilities:[...oldMember,next],clientLog:(...args)=>{logs.push(args);}}); rigs.push(r);
  await r.pair(); r.setReceive(async()=>{throw new HubProtocolError("unavailable");}); const c=r.client();
  await expect(c.value.start()).rejects.toThrow(); await c.value.close(); expect(logs).toHaveLength(0);
});
