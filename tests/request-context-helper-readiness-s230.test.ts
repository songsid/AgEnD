import {expect,it} from "vitest";
import {captureRequestContextHelpers} from "../src/request-context-helper-readiness.js";
function rig(){let bound=true,helper:any={version:1,generation:"launch-one",ready:true};const daemon:any={bootId:"daemon-one",requestContextHelperReadiness:()=>helper},row={name:"worker",daemon,prepared:{bound:()=>bound}};let current=daemon;
 return {capture:()=>captureRequestContextHelpers([row],()=>current),bound:(v:boolean)=>bound=v,helper:(v:any)=>helper=v,replace:()=>current={},daemon};}
it.each([null,{version:0,generation:"old",ready:true},{version:1,generation:"new",ready:false},{version:1,generation:"",ready:true}])("missing or unnegotiated helper %j is never replaced by a prepared policy",helper=>{
 const r=rig();r.helper(helper);const proof=r.capture();expect(proof.ready).toBe(false);expect(proof.current()).toBe(false);expect(proof.unready).toEqual(["worker"]);
});
it.each(["launch","daemon","binding"])("a later %s change invalidates the connection proof",kind=>{
 const r=rig(),proof=r.capture();expect(proof.current()).toBe(true);
 if(kind==="launch")r.helper({version:1,generation:"launch-two",ready:true});if(kind==="daemon")r.replace();if(kind==="binding")r.bound(false);
 expect(proof.current()).toBe(false);
});
it("a failed observation cannot turn into a proof when a later helper connects",()=>{const r=rig();r.helper(null);const failed=r.capture();r.helper({version:1,generation:"new",ready:true});expect(failed.current()).toBe(false);expect(r.capture().current()).toBe(true);});
