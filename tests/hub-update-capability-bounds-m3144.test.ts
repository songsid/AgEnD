import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeMemberFrame, encodeServerFrame, parseMemberFrame, parseServerFrame } from "../src/hub/protocol.js";
const hello = (count: number) => ({ v: 1 as const, type: "hello" as const, requestId: randomUUID(), linkEpoch: 0,
  payload: { supportedVersions: [1], memberBootId: randomUUID(), capabilities: Array.from({length:count},(_,i)=>i===0?"fleet-update-v1":`feature-${i}`) } });
const welcome = (count: number, modern: boolean) => ({v:1 as const,type:"welcome" as const,requestId:randomUUID(),linkEpoch:1,
  payload:{selectedVersion:1 as const,hubId:randomUUID(),fleetId:randomUUID(),linkEpoch:1,revocationVersion:0,
    capabilities:Array.from({length:count},(_,i)=>modern&&i===0?"fleet-update-v1":`feature-${i}`)}});
it("permits32 hello names for the phase3 offer, refuses33",()=>{
  for(const count of[16,17,32]) { const f=hello(count); expect(parseMemberFrame(encodeMemberFrame(f))).toEqual(f); }
  expect(()=>encodeMemberFrame(hello(33))).toThrow();
});
it("keeps legacy welcomes at16 and allows32 only on the explicit phase3 welcome",()=>{
  for(const count of[16,17,32]) { const f=welcome(count,true);expect(parseServerFrame(encodeServerFrame(f))).toEqual(f); }
  expect(()=>encodeServerFrame(welcome(17,false))).toThrow(); expect(()=>encodeServerFrame(welcome(33,true))).toThrow();
});
