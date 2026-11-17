/** Actual pinned TLS/WSS → HTTP receiver/SQLite; no real Fleet, directory, model or browser. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import { HubProtocolError } from "../src/hub/validation.js";
const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{try{for(const f of close.splice(0).reverse())await f();}finally{vi.restoreAllMocks();}});
const row={instance:"Docs",displayName:"Document helper",description:"Explains documents.",avatar:null,kind:"agent" as const,general:false,shareable:true as const,incarnation:"local-only"};
async function network(capabilities:string[],optIn=true){
  const ports=hubListenerPorts();close.push(()=>ports.close());
  const net=await hubRig({memberPort:await ports.next(),serverCapabilities:capabilities,clientAgentCatalog:optIn});close.push(()=>net.close());await net.pair();return net;
}
it("publishes the actual member catalog after reconciliation and exposes it only to its signed-in owner",async()=>{
  const caps=hubLinkCapabilities({agentCatalogV1:true,features:[HUB_FLEET_UPDATE_CAPABILITY]});
  expect(caps).not.toContain("exposure-request-v1");
  const net=await network(caps),web=await s3bRig({administrator:net.owner,realAudit:true});close.push(()=>web.close());
  web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;web.httpDeps.transport=()=>net.server;await web.restartHttp();
  net.setReceive((frame,link)=>web.http.receive(frame,link));
  let source=row;const errors:string[]=[];
  const create=createHubMemberFactory({home:net.memberHome,components:MEMBER_COMPONENTS,boundHub:()=>net.identity.hubId,
    agents:()=>[{name:"Docs",display:"Document helper"}],catalogAgents:()=>[source],
    representative:{deliver:async()=>false,agentToken:()=>"t".repeat(64),attachReports:()=>{}},
    fleetInfo:{version:"2.4.0-beta.10",runsAsService:true},versionRegistry:async()=>"not-found",
    updates:{idle:()=>true,canInstall:async()=>false,launch:async()=>false,notify:()=>true},
    attachExposures:()=>{},attachAttention:()=>{},pokeAttention:()=>{},report:(_code,detail)=>errors.push(detail),log:()=>{}});
  const service=await create({enabled:true},()=>true);close.push(()=>service.close());await service.start();
  await vi.waitFor(()=>expect(net.received.filter(f=>f.type==="agent.catalog")).toHaveLength(1));
  expect(net.received.findIndex(f=>f.type==="agent.catalog")).toBeGreaterThan(net.received.findIndex(f=>f.type==="reconcile"));
  const owner=await web.signIn("admin"),catalog=await web.call(owner,"GET","/hub/v1/me/agents");
  expect(catalog.status).toBe(200);expect(catalog.json.fleets[0].catalog.agents[0]).toMatchObject({instance:"Docs",displayName:"Document helper"});
  expect(JSON.stringify(catalog.json)).not.toContain("local-only");expect(errors).toEqual([]);
  source={...row,displayName:"Renamed"};
  const stored=net.store.read().fleets[0]!;
  // The owner refresh uses an exact current link epoch, just like future page refreshes.
  const epoch=net.received.find(f=>f.type==="agent.catalog")!.linkEpoch;
  await net.server.send(stored.id,{v:1,type:"agent.catalog-refresh",requestId:randomUUID(),linkEpoch:epoch,payload:{}});
  await vi.waitFor(()=>expect(net.received.filter(f=>f.type==="agent.catalog")).toHaveLength(2));
  await expect(net.server.send(stored.id,{v:1,type:"exposure.request",requestId:randomUUID(),linkEpoch:epoch,
    payload:{by:net.owner,catalogRevision:"a".repeat(64),share:["Docs"],stop:[],createdAt:1,expiresAt:600001}})).rejects.toMatchObject({code:"incompatible"});
  service.fence();source={...row,displayName:"After fence"};
  await service.close();expect(net.received.filter(f=>f.type==="agent.catalog")).toHaveLength(2);
});
it.each([false,true])("keeps hello lengths unchanged and requires a local catalog adapter (opt-in=%s)",async optIn=>{
  const net=await network([...HUB_OPTIONAL_CAPABILITIES,HUB_FLEET_UPDATE_CAPABILITY,"agent-catalog-v1"],optIn);
  const spy=vi.spyOn(net.server as any,"receive");const member=net.client(undefined,undefined,[...HUB_OPTIONAL_CAPABILITIES,HUB_FLEET_UPDATE_CAPABILITY]);await member.value.start();
  const hello=spy.mock.calls.find(args=>(args[0] as any).type==="hello")![0] as any;
  expect(hello.payload.capabilities).not.toContain("agent-catalog-v1");expect(hello.payload.capabilities).toHaveLength(15);
  expect(member.state.link!.features.has("agent-catalog-v1")).toBe(optIn);
  if(!optIn){
    await expect(member.state.link!.send({v:1,type:"agent.catalog",requestId:randomUUID(),linkEpoch:member.state.link!.linkEpoch,payload:{revision:"a".repeat(64),enabled:false,requests:false,agents:[]}})).rejects.toMatchObject({code:"incompatible"});
    await expect(net.server.send(net.store.read().fleets[0]!.id,{v:1,type:"agent.catalog-refresh",requestId:randomUUID(),linkEpoch:member.state.link!.linkEpoch,payload:{}})).rejects.toMatchObject({code:"incompatible"});
  }
});
it("a strict old Hub receives no catalog frame and retries by dropping only fleet-update-v1",async()=>{
  const net=await network([...HUB_OPTIONAL_CAPABILITIES]);const server=net.server as any,receive=server.receive.bind(server),hellos:string[][]=[];
  vi.spyOn(server,"receive").mockImplementation(async(...args:any[])=>{const f=args[0];if(f.type==="hello"){hellos.push(f.payload.capabilities);if(f.payload.capabilities.length>16)throw new HubProtocolError("incompatible");}return receive(...args);});
  const member=net.client(undefined,undefined,[...HUB_OPTIONAL_CAPABILITIES,"room-ask-v1","room-post-v1",HUB_FLEET_UPDATE_CAPABILITY]);await member.value.start();
  expect(hellos.map(v=>v.length)).toEqual([17,16]);expect(hellos[1]).toEqual(hellos[0].filter(v=>v!==HUB_FLEET_UPDATE_CAPABILITY));
  expect(member.state.link!.features.has("agent-catalog-v1")).toBe(false);
  expect(net.received.some(f=>f.type==="agent.catalog")).toBe(false);expect(member.state.link!.current()).toBe(true);
});
it("the mounted switch-off clears inventory without enumerating agents and keeps existing shares untouched",async()=>{
  const net=await network([...HUB_OPTIONAL_CAPABILITIES,HUB_FLEET_UPDATE_CAPABILITY,"agent-catalog-v1"]);
  const agents=vi.fn(()=>[row]);
  const create=createHubMemberFactory({home:net.memberHome,components:MEMBER_COMPONENTS,boundHub:()=>net.identity.hubId,
    agents:()=>[{name:"Docs",display:"Docs"}],catalogAgents:agents,
    representative:{deliver:async()=>false,agentToken:()=>"t".repeat(64),attachReports:()=>{}},
    fleetInfo:{version:"2.4.0-beta.10",runsAsService:true},versionRegistry:async()=>"not-found",
    updates:{idle:()=>true,canInstall:async()=>false,launch:async()=>false,notify:()=>true},
    attachExposures:()=>{},attachAttention:()=>{},pokeAttention:()=>{},report:()=>{},log:()=>{}});
  const service=await create({enabled:true,share_from_hub:false},()=>true);close.push(()=>service.close());await service.start();
  await vi.waitFor(()=>expect(net.received.find(f=>f.type==="agent.catalog")?.payload).toMatchObject({enabled:false,requests:false,agents:[]}));
  expect(agents).not.toHaveBeenCalled();expect(net.received.filter(f=>f.type==="exposure.snapshot")).toHaveLength(1);
});
