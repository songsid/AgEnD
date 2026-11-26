import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {RequestContextPublication} from "../src/request-context-installation.js";
import {requestDeliveryContinuation} from "../src/request-context-continuation.js";
import {requestContextDigest} from "../src/request-context-store.js";
const clean:Array<()=>void>=[];afterEach(()=>{for(const f of clean.splice(0).reverse())f();});
it("only the exact B-bound row can continue an old root; claim and owner changes invalidate its lease",()=>{
 const home=mkdtempSync(join(tmpdir(),"continuation-"));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(home,"outbox.db"),"manager",{requestContextDispatchVersion:1});clean.push(()=>box.close());
 const owner={owner:"fleet",current:()=>true},store=box.requestContextInstallation();
 let state=store.activate({epoch:"epoch",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},owner,{current:()=>true,release(){}},()=>true,0);
 const ports={},p=new RequestContextPublication(owner,true);p.publish(state,ports,p.fence(),()=>true,()=>state,()=>true);
 const id="00000000-0000-4000-8000-000000000001";
 const context={ref:{version:1 as const,contextId:id,rootContextId:id},rootEvidenceRef:"accepted",
  initiatingActor:{kind:"person" as const,platform:"discord" as const,userId:"person"},ingress:"restricted-room" as const,
  source:{instance:"source",incarnation:"generation"},sourceAudience:{kind:"room" as const,ref:id}};
 const input={operationId:"operation",sourceKey:"source-key",sourceInstance:"source",sourceDaemonBootId:"source-boot",targetInstance:"target",kind:"fleet_inbound",payload:{type:"fleet_inbound",content:"synthetic"}};
 const admitted=box.admitWithRequestContext(input,context,{version:1,operationId:input.operationId,contextId:id,rootContextId:id,source:context.source,target:{instance:"target",incarnation:"target-generation"},verb:"send_to_instance",payloadSha256:requestContextDigest(input.payload)});
 const before=requestDeliveryContinuation(box,p,admitted.delivery,()=>true)!;
 state=store.beginOff(1,owner);const roots=store.drainRoots();p.publish(state,ports,p.fence(),()=>true,()=>state,()=>true,root=>roots.has(root));
 expect(p.admission.available()).toBe(false);expect(p.admission.available(before)).toBe(true);
 expect(()=>requestDeliveryContinuation(box,p,{...admitted.delivery,payload:{content:"forged"}},()=>true)).toThrow(/changed/);
 const claimed=box.claimNext("manager",()=>"target-boot",new Set())!;expect(claimed).toBeDefined();
 expect(p.admission.available(before)).toBe(false);
 let live=true;const after=requestDeliveryContinuation(box,p,box.get(claimed.deliveryId)!,()=>live)!;
 expect(p.admission.available(after)).toBe(true);live=false;expect(p.admission.available(after)).toBe(false);
 const legacy=box.admit({...input,operationId:"legacy",sourceKey:"legacy"}).delivery;
 expect(requestDeliveryContinuation(box,p,legacy,()=>true)).toBeNull();
});
