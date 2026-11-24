import {afterEach,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {hubRig} from "./helpers/hub-rig.js";
import * as protocol from "../src/hub/protocol.js";
import {HubProtocolError} from "../src/hub/validation.js";
import {hubWelcomeCapabilities} from "../src/hub/server.js";
const cap="direct-posts-v1",links:Awaited<ReturnType<typeof hubRig>>[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const r of links.splice(0))await r.close();});
const legacy=[...protocol.HUB_OPTIONAL_CAPABILITIES,"room-ask-v1","room-post-v1"];
it("negotiates direct posts on both sides, never on an old member or legacy hello retry",async()=>{
 const modern=[...legacy,protocol.HUB_FLEET_UPDATE_CAPABILITY,protocol.HUB_ASKER_NAME_CAPABILITY,cap];
 expect(hubWelcomeCapabilities(modern,legacy)).not.toContain(cap);
 const one=await hubRig({serverCapabilities:modern,clientCapabilities:modern});links.push(one);await one.pair();const c=one.client();await c.value.start();expect(c.state.link!.features.has(cap)).toBe(true);
 const notOffered=await hubRig({serverCapabilities:modern,clientCapabilities:[...legacy,protocol.HUB_FLEET_UPDATE_CAPABILITY]});links.push(notOffered);await notOffered.pair();const old=notOffered.client();await old.value.start();expect(old.state.link!.features.has(cap)).toBe(false);
 const original=protocol.parseMemberFrame,hellos:string[][]=[];vi.spyOn(protocol,"parseMemberFrame").mockImplementation(input=>{const f=original(input);if(f.type==="hello"){hellos.push([...f.payload.capabilities]);if(f.payload.capabilities.length>16)throw new HubProtocolError();}return f;});
 const x=await hubRig({serverCapabilities:legacy,clientCapabilities:modern});links.push(x);await x.pair();const retry=x.client();await retry.value.start();expect(hellos.map(h=>h.length)).toEqual([19,16]);expect(retry.state.link!.features.has(cap)).toBe(false);
});
it("only direct posts may carry files, empty text or answer-sized text, without a human receipt or mention feedback",()=>{
 const body={exposureId:randomUUID(),room:randomUUID(),text:"x".repeat(128*1024),idempotencyKey:randomUUID()};expect(protocol.roomPostSchema.safeParse(body).success).toBe(false);expect(protocol.roomPostSchema.safeParse({...body,direct:true}).success).toBe(true);
 const file={id:randomUUID(),name:"demo.txt",size:1,mime:"text/plain",sha256:"a".repeat(64)};
 expect(protocol.roomPostSchema.safeParse({...body,text:"",direct:true,attachments:[file]}).success).toBe(true);
 for(const extra of [{attachments:[file]},{direct:true,onBehalfOf:{receiptId:`hmsg-${randomUUID()}`}},{direct:true,mentionFeedback:true},{direct:true,text:""}])expect(protocol.roomPostSchema.safeParse({...body,text:"message",...extra}).success).toBe(false);
});
