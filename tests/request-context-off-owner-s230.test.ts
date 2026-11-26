/** Private SQLite and actual publication/drain only; no Fleet or CLI process. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {RequestContextPublication} from "../src/request-context-installation.js";
import {RequestContextOffOwner} from "../src/request-context-off.js";
import {REQUEST_CONTEXT_DRAIN_FAMILIES} from "../src/request-context-drain.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const home=mkdtempSync(join(tmpdir(),"off-owner-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(home,"outbox.db"),"fixture",{requestContextDispatchVersion:1,requestContextRecoveryFence:()=>true});cleanup.push(()=>box.close());
 let live=true,portsLive=true;const owner={owner:"fleet",current:()=>live},installation=box.requestContextInstallation(),publication=new RequestContextPublication<object>(owner,false),ports={};
 const state=installation.activate({epoch:"first",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},owner,{current:()=>true,release(){}},()=>true,0);
 const fence=publication.fence();publication.publish(state,ports,fence,()=>portsLive,()=>installation.read(),()=>portsLive);
 const drain=box.requestContextDrain(()=>live?"fleet":null),maps=new Map<string,RequestContextReferenceMap<string,string>>();
 for(const family of REQUEST_CONTEXT_DRAIN_FAMILIES){const registration=drain.registration(),map=new RequestContextReferenceMap<string,string>(root=>root,(_root,id)=>id);map.installRegistration(registration);maps.set(family,map);drain.register(family,family,{registration,revision:()=>map.revision,inspect:root=>map.view(root)});}
 const root=randomUUID();box.requestContextRecovery.retain({ref:{version:1,contextId:root,rootContextId:root},rootEvidenceRef:"fixture",initiatingActor:{kind:"unknown",reason:"unidentified"},ingress:"restricted-room",source:{instance:"source",incarnation:"current"},sourceAudience:{kind:"instance",ref:root}});
 const control=new RequestContextOffOwner(installation,drain,publication,owner);
 return {box,installation,publication,maps,root,control,live:(value:boolean)=>live=value,portsLive:(value:boolean)=>portsLive=value};
}
it("Draining admits proven old-root continuation; an unfinished call does not cut that path or invalidate its execution",()=>{
 const r=rig(),old=r.publication.captureExecution(),proof=r.publication.continuation(r.root,()=>true);
 r.maps.get("daemon-calls")!.set("in-flight",r.root);expect(r.control.begin(1,()=>true).mode).toBe("draining");
 expect(r.publication.admission.available()).toBe(false);expect(r.publication.admission.available(proof)).toBe(true);expect(old.executionCurrent()).toBe(true);
 const blocked=r.control.advance(2);expect(blocked.state.mode).toBe("draining");expect(blocked.blockers.join()).toContain("in-flight");
 expect(old.executionCurrent()).toBe(true);expect(r.publication.admission.available(proof)).toBe(true);
 r.maps.get("daemon-calls")!.delete("in-flight");expect(r.control.advance(2).state.mode).toBe("off");
 expect(r.publication.installedMode()).toBe("off");expect(r.publication.admission.available()).toBe(true);expect(old.executionCurrent()).toBe(false);
 expect(r.publication.captureExecution().portsCurrent()).toBe(true);expect(r.publication.capture()).not.toBeNull();
});
it("a revoked decision rolls back its mode change and resumes the original execution without legacy fallback",()=>{
 const r=rig(),old=r.publication.captureExecution();let checks=0;
 expect(()=>r.control.begin(1,()=>++checks<3)).toThrow(/owner changed/);
 expect(r.installation.read()?.mode).toBe("active");expect(r.publication.capture()).toBe(old);expect(old.executionCurrent()).toBe(true);
});
it("a new independent root during Draining remains queued but is not part of the old-root drain",async()=>{
 const r=rig();r.control.begin(1,()=>true);let delivered=false;
 const pending=r.publication.admission.wait(()=>true).then(ok=>{delivered=ok;});await Promise.resolve();expect(delivered).toBe(false);
 expect(r.control.advance(2).state.mode).toBe("off");await pending;expect(delivered).toBe(true);
});
it("readiness or process-port loss never reports a successful legacy rollback",()=>{
 const r=rig();r.control.begin(1,()=>true);r.portsLive(false);
 expect(()=>r.control.advance(2)).toThrow(/unavailable/);expect(r.installation.read()?.mode).toBe("draining");expect(()=>r.publication.capture()).toThrow();
});
it("an empty durable drain does not let an unregistered family disappear",()=>{
 const r=rig();r.control.begin(1,()=>true);r.maps.get("registered-work")!.set("wake",r.root);
 const result=r.control.advance(2);expect(result.state.mode).toBe("draining");expect(result.blockers.join()).toContain("wake");
});
