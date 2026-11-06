/** Failed-update guidance through the ordinary Needs-you derivation and real scratch FleetManager. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { deriveNeedsYou, renderSignature } from "../src/needs-you.js";
import { runtimeUpdateAttention } from "../src/runtime-update-attention.js";
import { setLocale, t } from "../src/locale.js";
import type { RuntimeMachine } from "../src/runtime-protocol.js";
const target = { version: "2.3.5-alpha.12", bundleSha256: "a".repeat(64) }, base = { prompts: [], instances: [], deliveries: [], ownerOf: () => undefined };
const machine = (): RuntimeMachine => ({ id: "12345678-1234-4321-abcd-123456789012", name: "Fake desktop", platform: "win32", status: "online", generation: 3, createdAt: 1,
  updateReport: { bootId: "22345678-1234-4321-abcd-123456789012", generation: 3, reportedAt: 5, status: { state: "failed", target } } });
const fleets: any[] = [], roots: string[] = [];
afterEach(async () => { for (const fm of fleets.splice(0)) { await fm.stopNeedsYou(); fm.runtimeHub?.close?.(); } for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();setLocale("en"); });
function fleet() {
  const root=mkdtempSync(join(tmpdir(),"agend-update-needs-"));roots.push(root);
  const fm=new FleetManager(root) as any;fleets.push(fm);fm.fleetConfig={defaults:{},instances:{}};return fm;
}
it.each(["en","zh-TW"] as const)("a failed target is one stable, display-only owner notice (%s)",locale=>{
  setLocale(locale);const m=machine(), inputs=runtimeUpdateAttention([m],t,"world"), items=deriveNeedsYou({...base,runtimeUpdates:inputs});
  expect(items).toHaveLength(1);expect(items[0]).toMatchObject({type:"runtime",instance:"",owner:"world",reason:"dialog",runtimeUpdate:true,since:5});
  expect(items[0].detail).toContain("Fake desktop");expect(items[0].detail).toContain(target.version);expect(items[0].detail).toContain("aaaaaaaa");
  expect(items[0].detail).not.toContain("runtime.update.");expect(items[0].actions).toBeUndefined();expect(items[0].nonce).toBeUndefined();
  const changed=machine();changed.updateReport!.reportedAt=50;
  expect(deriveNeedsYou({...base,runtimeUpdates:runtimeUpdateAttention([changed],t,"world")})[0].id).toBe(items[0].id);
  expect(renderSignature([{...items[0],runtimeUpdate:undefined}],100)).not.toBe(renderSignature(items,100));
  for(const status of [{state:"current"},{state:"pending",target},{state:"manual",reason:"shared"}] as const){m.updateReport!.status=status;expect(runtimeUpdateAttention([m],t)).toEqual([]);}
  m.updateReport!.status={state:"failed",target};m.status="revoked";expect(runtimeUpdateAttention([m],t)).toEqual([]);
});
it("the real FleetManager exposes and clears the current failed report without a polling read",async()=>{
  vi.stubEnv("AGEND_REMOTE_RUNTIME","1");setLocale("en");const fm=fleet();let machines=[machine()];
  const list=vi.fn(()=>machines);fm.runtimeHub={listMachines:list};fm.startNeedsYou();
  const item=fm.needsYouItems().find((i:any)=>i.runtimeUpdate);expect(item?.detail).toContain(target.version);expect(item?.detail).toContain("Previous code kept");
  machines=[];fm.needsYou.poke();await vi.waitFor(()=>expect(fm.needsYouItems().filter((i:any)=>i.runtimeUpdate)).toEqual([]));
  expect(list).toHaveBeenCalled();
});
it("a new online report wakes the existing Needs-you hub, including during shutdown",()=>{
  vi.stubEnv("AGEND_REMOTE_RUNTIME","1");const fm=fleet(), coordinator=fm.runtimeCoordinator(), poke=vi.fn();
  fm.shuttingDown=true;fm.needsYou={poke};
  try {(coordinator as any).options.changed({type:"machine",machineId:"fake"});expect(poke).toHaveBeenCalledOnce();}
  finally {fm.needsYou=null;}
});
