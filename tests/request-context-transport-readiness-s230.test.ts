import {expect,it} from "vitest";
import {RuntimeCoordinator} from "../src/runtime-coordinator.js";
import {RuntimeNativePaneLifecycle} from "../src/native-pane-lifecycle.js";
it("coordinator readiness uses the actual admitting connection and negotiated bit, never the peer advertisement",()=>{
 const id="a".repeat(64),connection:any={generation:1,requestContextProtocol:false,hello:{paneProtocol:1,runtimeInfo:{capabilities:["request-context-call-v1"]}}};let current=true;
 const coordinator:any=Object.assign(Object.create(RuntimeCoordinator.prototype),{closed:false,connections:new Map([[id,connection]]),paneEpoch:"owned-coordinator-epoch",admitting:()=>current});
 const old=coordinator.requestContextReadiness(id);expect(old).toMatchObject({id,connected:true,requestContextVersion:0});
 connection.requestContextProtocol=true;expect(coordinator.requestContextReadiness(id).requestContextVersion).toBe(1);
 connection.generation++;expect(coordinator.requestContextReadiness(id).generation).not.toBe(old.generation);
 current=false;expect(coordinator.requestContextReadiness(id)).toBeNull();current=true;coordinator.closed=true;expect(coordinator.requestContextReadiness(id)).toBeNull();coordinator.closed=false;
 delete connection.hello.paneProtocol;expect(coordinator.requestContextReadiness(id)).toBeNull();coordinator.connections.clear();expect(coordinator.requestContextReadiness(id)).toBeNull();
});
it.each([[false,true,true,false],[true,false,true,false],[true,true,false,false],[true,true,true,true]])("native readiness requires proof registry=%s, owner=%s and actual port=%s",(registry,current,port,want)=>{
 const owner:any={options:{requestContexts:registry?{}:undefined},current:()=>current,port:{requestContextSupported:()=>port}};
 expect(RuntimeNativePaneLifecycle.prototype.requestContextTransportCurrent.call(owner)).toBe(want);
});
