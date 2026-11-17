import { afterEach, expect, it, vi } from "vitest";
import { HubMemberAgentCatalog, hubPageSharingEnabled, memberAgentCatalog, type MemberCatalogAgent } from "../src/hub/member/agent-catalog.js";
import type { HubMemberLink } from "../src/hub/client.js";
const agent=():MemberCatalogAgent=>({instance:"Docs",displayName:"Documents",description:"one\ntwo",avatar:null,kind:"agent",general:false,shareable:true,incarnation:"local-token"});
afterEach(()=>vi.useRealTimers());
it("defaults on, accepts an explicit off and refuses malformed switch values",()=>{
  expect(hubPageSharingEnabled({})).toBe(true);expect(hubPageSharingEnabled({share_from_hub:false})).toBe(false);
  for(const value of [null,0,"false",{}])expect(()=>hubPageSharingEnabled({share_from_hub:value})).toThrow();
});
it("projects cosmetics only, hashes incarnation changes and sends an empty catalog while off",()=>{
  const first=memberAgentCatalog(true,[agent()]);expect(first.agents[0].description).toBe("one two");
  expect(JSON.stringify(first)).not.toContain("local-token");expect(first.requests).toBe(false);
  expect(memberAgentCatalog(true,[{...agent(),incarnation:"replacement"}]).revision).not.toBe(first.revision);
  expect(memberAgentCatalog(false,[agent()]).agents).toEqual([]);
  expect(memberAgentCatalog(true,[{...agent(),description:"文".repeat(300)}]).agents[0].description.length).toBe(170);
});
it("coalesces current-link changes, refreshes once on request and stops all sends on hold or close",async()=>{
  vi.useFakeTimers();let current=true,source=agent();const sent:unknown[]=[];
  const link={linkEpoch:1,features:new Set(["agent-catalog-v1"]),current:()=>current,send:async (value:unknown)=>{sent.push(value);}} as unknown as HubMemberLink;
  const catalog=new HubMemberAgentCatalog({current:()=>current,enabled:true,agents:()=>[source]});
  catalog.connected(link);await catalog.refresh();expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(6_000);expect(sent).toHaveLength(1);
  source={...source,displayName:"Changed"};await vi.advanceTimersByTimeAsync(3_000);expect(sent).toHaveLength(2);
  await catalog.refresh(true);expect(sent).toHaveLength(3);
  catalog.disconnected();source={...source,displayName:"Held"};await vi.advanceTimersByTimeAsync(6_000);expect(sent).toHaveLength(3);
  catalog.connected({...link,linkEpoch:2});await catalog.refresh();expect(sent).toHaveLength(4);
  current=false;await catalog.refresh(true);expect(sent).toHaveLength(4);catalog.close();
});
it("does not inspect inventory while off and cannot send without negotiation",async()=>{
  let current=true;const send=vi.fn(async(_value:unknown)=>{}),agents=vi.fn(()=>[agent()]);
  const link={linkEpoch:1,features:new Set<string>(),current:()=>current,send} as unknown as HubMemberLink;
  const catalog=new HubMemberAgentCatalog({current:()=>current,enabled:false,agents});catalog.connected(link);await catalog.refresh();
  expect(send).not.toHaveBeenCalled();expect(agents).not.toHaveBeenCalled();
  catalog.connected({...link,features:new Set(["agent-catalog-v1"])});await catalog.refresh();expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toMatchObject({payload:{enabled:false,requests:false,agents:[]}});expect(agents).not.toHaveBeenCalled();
  current=false;catalog.close();
});
it("does not mark a replaced link's uncertain send as delivered on the new link",async()=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const frames:unknown[]=[];
  const a={linkEpoch:1,features:new Set(["agent-catalog-v1"]),current:()=>true,send:async()=>held} as unknown as HubMemberLink;
  const b={...a,linkEpoch:2,send:async frame=>{frames.push(frame);}} as HubMemberLink;
  const catalog=new HubMemberAgentCatalog({current:()=>true,enabled:true,agents:()=>[agent()]});catalog.connected(a);catalog.connected(b);release();
  await catalog.refresh();expect(frames).toHaveLength(1);expect(frames[0]).toMatchObject({linkEpoch:2});catalog.close();
});
