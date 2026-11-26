/** Version reads the authoritative live marker; private databases only, no update or restore. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {requestContextGoBackUnavailable} from "../src/request-context-go-back-view.js";
const clean:Array<()=>void>=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
function rig(){const home=mkdtempSync(join(tmpdir(),"go-back-view-"));clean.push(()=>rmSync(home,{recursive:true,force:true}));return home;}
it("a never-activated missing database creates no artifacts or invented unavailability",()=>{const home=rig(),before=readdirSync(home);expect(requestContextGoBackUnavailable(home,"20261127T010203Z-deadbeef")).toBe(false);expect(readdirSync(home)).toEqual(before);});
it("the committed activation immediately ends its exact offered Go back without a separate cache write",()=>{
 const home=rig(),box=new DeliveryOutbox(join(home,"delivery-outbox.db"),"fixture",{requestContextDispatchVersion:1});clean.push(()=>box.close());const id="20261127T010203Z-deadbeef";
 expect(requestContextGoBackUnavailable(home,id)).toBe(false);
 box.requestContextInstallation().activate({epoch:"fixture",owner:"fleet",activatedAt:1,invalidates:[id],offeredLatestDeadline:2},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>true,0);
 expect(requestContextGoBackUnavailable(home,id)).toBe(true);expect(requestContextGoBackUnavailable(home,"20261127T010204Z-deadbeef")).toBe(false);
 const state=box.requestContextInstallation().read()!;box.requestContextInstallation().beginOff(state.revision,{owner:"fleet",current:()=>true});
 expect(requestContextGoBackUnavailable(home,id)).toBe(true);
});
it("malformed activation history refuses the Version projection instead of offering a restore",()=>{
 const home=rig(),box=new DeliveryOutbox(join(home,"delivery-outbox.db"),"fixture",{requestContextDispatchVersion:1});clean.push(()=>box.close());
 box.requestContextInstallation().activate({epoch:"fixture",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>true,0);
 (box as any).db.exec("DROP TRIGGER request_context_activation_no_update; UPDATE request_context_activations_v1 SET invalidates_json='{}'");expect(()=>requestContextGoBackUnavailable(home,"20261127T010203Z-deadbeef")).toThrow();
});
