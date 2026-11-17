import {afterEach,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {hubRig} from "./helpers/hub-rig.js";
import {hubListenerPorts} from "./helpers/hub-listener-ports.js";
import {hubLinkCapabilities} from "../src/hub/compose/server.js";
import {hubWelcomeCapabilities} from "../src/hub/server.js";
import {HUB_OPTIONAL_CAPABILITIES,HUB_FLEET_UPDATE_CAPABILITY} from "../src/hub/protocol.js";
let rig:Awaited<ReturnType<typeof hubRig>>|undefined,ports:ReturnType<typeof hubListenerPorts>|undefined;
afterEach(async()=>{await rig?.close();await ports?.close();rig=undefined;ports=undefined;});
it("negotiates introductions without adding a hello slot, exchanges over TLS, and keeps old peers silent",async()=>{
 const caps=hubLinkCapabilities({agentIntroV1:true,features:[HUB_FLEET_UPDATE_CAPABILITY]});
 expect(caps).toContain("agent-intro-v1");expect(HUB_OPTIONAL_CAPABILITIES).not.toContain("agent-intro-v1");
 expect(hubWelcomeCapabilities(caps,HUB_OPTIONAL_CAPABILITIES)).not.toContain("agent-intro-v1");
 expect(hubLinkCapabilities({features:[]})).not.toContain("agent-intro-v1");
 ports=hubListenerPorts();const net=rig=await hubRig({memberPort:await ports.next(),serverCapabilities:caps,clientAgentIntro:true});await net.pair();
 net.setReceive(async(frame,link)=>{const common={v:1 as const,requestId:frame.requestId,linkEpoch:link.linkEpoch};
  if(frame.type==="reconcile")return {...common,type:"reconcile",payload:{receipts:[],nextReceiptSequence:0,more:false}};
  if(frame.type==="agent.intro"){expect(link.features.has("agent-intro-v1")).toBe(true);return {...common,type:"agent.intro-result",payload:{ok:true,intro:frame.payload.text,introBy:frame.payload.source,introAt:1,changed:true}};}
 });
 const member=net.client(undefined,undefined,[...HUB_OPTIONAL_CAPABILITIES,HUB_FLEET_UPDATE_CAPABILITY]);await member.value.start();
 const link=member.state.link!;expect(link.features.has("agent-intro-v1")).toBe(true);
 const result=await link.exchange({v:1,type:"agent.intro",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload:{exposureId:randomUUID(),revision:1,source:"agent",text:"I handle notes."}},"agent.intro-result");
 expect(result).toMatchObject({type:"agent.intro-result",payload:{ok:true,intro:"I handle notes."}});
 const old=net.client(undefined,undefined,[]);await old.value.start();expect(old.state.link!.features.has("agent-intro-v1")).toBe(false);
 await expect(old.state.link!.send({v:1,type:"agent.intro",requestId:randomUUID(),linkEpoch:old.state.link!.linkEpoch,payload:{exposureId:randomUUID(),revision:1,source:"agent",text:"Not sent"}})).rejects.toMatchObject({code:"incompatible"});
});
