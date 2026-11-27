import {expect,it} from "vitest";
import {projectRequestContextWork} from "../src/request-context-drain-projection.js";
it("an owned pending root fence keeps the saved-work Stop action after its runtime is gone",()=>{
 expect(projectRequestContextWork(["pending-root-fence"])).toEqual({families:["registered-work"],unknownEnd:false,stoppable:true});
});
it("names the actual F family and retains unknown-end evidence",()=>{
 expect(projectRequestContextWork(['["turns","fleet"]:worker:unknown-end:worker:interrupt','["fleet-calls","fleet"]:call:a','human-input:hmsg-a','recovery-pointer']))
 .toEqual({families:["turns","fleet-calls","human-input"],unknownEnd:true,stoppable:true});
});
it.each(["missing:turns","unknown:producer","unavailable:producer","unregistered-producer","context-unavailable","drain-owner-unavailable",'["invented","fleet"]:row'])
 ("%s stays named and never acquires a destructive action",reference=>{
 expect(projectRequestContextWork([reference])).toEqual({families:["unknown"],unknownEnd:false,stoppable:false});
});
it("other unresolved effects keep their own actions and prevent abandonment",()=>{
 expect(projectRequestContextWork(['["turns","fleet"]:turn:a','delivery:a','return:b','held:R1'])).toEqual({families:["turns"],unknownEnd:false,stoppable:false});
 expect(projectRequestContextWork(["recovery-pointer"])).toEqual({families:[],unknownEnd:false,stoppable:false});
});
