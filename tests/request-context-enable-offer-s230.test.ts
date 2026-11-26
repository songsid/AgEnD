import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {captureRequestContextEnableOffer} from "../src/request-context-enable-offer.js";
import {retainedPath} from "../src/update-retained.js";
import type {GoBackOffer} from "../src/update-goback.js";
const homes:string[]=[];afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function home(){const h=mkdtempSync(join(tmpdir(),"enable-offer-"));homes.push(h);return h;}
function value():GoBackOffer{return {eligible:[{attemptId:"20261126T120000Z-aabbccdd",committedAt:1,expiresAt:100,from:"2.4.0",version:"2.5.0"}],latestDeadline:100,unavailable:[]};}
it("the actual absent retained history means no window, and the read creates no state",()=>{
 const h=home(),before=readdirSync(h),offer=captureRequestContextEnableOffer(h);expect(offer.invalidates).toEqual([]);expect(offer.latestDeadline).toBeNull();expect(offer.current()).toBe(true);expect(readdirSync(h)).toEqual(before);
});
it("the actual malformed retained history refuses instead of silently omitting the disclosure",()=>{
 const h=home(),path=retainedPath(h);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,"not JSON");expect(()=>captureRequestContextEnableOffer(h)).toThrow(/unavailable/);
});
it.each(["id","deadline","commit","from","version","expired","unknown"])("a changed %s offer invalidates the exact confirmation",kind=>{
 let current=value();const offer=captureRequestContextEnableOffer(home(),()=>2,()=>current);
 expect(offer.invalidates).toEqual([current.eligible[0]!.attemptId]);expect(offer.current()).toBe(true);
 current=structuredClone(current);const row=current.eligible[0]!;
 if(kind==="id")row.attemptId="20261126T120001Z-eeff0011";
 if(kind==="deadline"){row.expiresAt=200;current.latestDeadline=200;}
 if(kind==="commit")row.committedAt=2;
 if(kind==="from")row.from="2.3.0";
 if(kind==="version")row.version="2.6.0";
 if(kind==="expired")current={eligible:[],latestDeadline:null,unavailable:[{attemptId:row.attemptId,reason:"expired"}]};
 if(kind==="unknown")current={eligible:[],latestDeadline:null,unavailable:[{attemptId:"",reason:"unreadable history"}]};
 expect(offer.current()).toBe(false);
});
it("known unavailable entries neither invalidate nor grant Go back; a bad deadline refuses",()=>{
 const known={...value(),unavailable:[{attemptId:"20261125T120000Z-0011aabb",reason:"already used"}]};
 expect(captureRequestContextEnableOffer(home(),()=>2,()=>known).invalidates).toHaveLength(1);
 expect(()=>captureRequestContextEnableOffer(home(),()=>2,()=>({...known,latestDeadline:999}))).toThrow(/unavailable/);
});
