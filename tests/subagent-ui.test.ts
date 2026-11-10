import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const raw=readFileSync(new URL("../src/ui/subagent-row.js",import.meta.url),"utf8");
function observer(fetcher:any) {
 const scope:any={register:()=>{},t:(s:string)=>s,AbortController,Map,Date,Error,Number,Array,Object,fetch:fetcher};
 runInNewContext(raw.replace(/^import .*;$/gm,"").replace(/export /g,"")+"\nglobalThis.observe=observeSubagents",scope);
 const changed=vi.fn(),setTimer=vi.fn(),clearTimer=vi.fn();
 const o=scope.observe("dev /中文",{fetcher,changed,setTimer,clearTimer});return {...o,changed,setTimer,clearTimer};
}
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const row={key:"a",parentTurn:"parent",task:"safe",state:"completed",summary:"done",durationMs:30};
const response=(owner="one",status="ok",runs=[row])=>({ok:true,status:200,json:async()=>({subagents:1,owner,status,runs})});
const drain=async()=>{for(let n=0;n<6;n++)await Promise.resolve();};
describe("read-only progress disclosure polling",()=>{
 it("uses one flight and waits for its completion before rearming",async()=>{const hold=deferred<any>(),fetcher=vi.fn((..._args:any[])=>hold.promise);const o=observer(fetcher);await o.retry();expect(fetcher).toHaveBeenCalledTimes(1);expect(o.setTimer).not.toHaveBeenCalled();expect(fetcher.mock.calls[0][0]).toContain("dev%20%2F%E4%B8%AD%E6%96%87");hold.resolve(response());await drain();expect(o.changed).toHaveBeenLastCalledWith({owner:"one",runs:[row],error:false});expect(o.setTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function),6000);o.stop();});
 it("retires a late response and aborts its owned fetch when unmounted",async()=>{const hold=deferred<any>(),fetcher=vi.fn((..._args:any[])=>hold.promise);const o=observer(fetcher);o.stop();expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);hold.resolve(response());await drain();expect(o.changed).not.toHaveBeenCalled();expect(o.setTimer).not.toHaveBeenCalled();});
 it.each([401,403,404])("permission loss or old server %s clears data without scheduling another poll",async status=>{const o=observer(vi.fn(async()=>({ok:false,status})));await drain();expect(o.changed).toHaveBeenLastCalledWith({owner:null,runs:[],error:false});expect(o.setTimer).not.toHaveBeenCalled();o.stop();});
 it("same-owner missing evidence retains only unknown metadata; a new owner drops it",async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response("one","unavailable",[])).mockResolvedValueOnce(response("two","unavailable",[]));const o=observer(fetcher);await drain();await o.retry();expect(o.changed.mock.calls.at(-1)[0]).toEqual({owner:"one",runs:[{key:"a",parentTurn:"parent",task:"safe",state:"unknown"}],error:true});await o.retry();expect(o.changed.mock.calls.at(-1)[0]).toEqual({owner:"two",runs:[],error:false});o.stop();});
 it("network failure makes prior completion unconfirmed and keeps retry available",async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(Error("offline"));const o=observer(fetcher);await drain();await o.retry();const last=o.changed.mock.calls.at(-1)[0];expect(last.runs[0].state).toBe("unknown");expect(last.runs[0].summary).toBeUndefined();expect(last.runs[0].durationMs).toBeUndefined();expect(last.error).toBe(true);expect(o.setTimer.mock.calls.at(-1)[1]).toBe(6000);o.stop();});
 it("a present but unreadable/over-cap parent with no proved children stays hidden",async()=>{const o=observer(vi.fn(async()=>response("present-parent","unavailable",[])));await drain();expect(o.changed.mock.calls.at(-1)[0]).toEqual({owner:"present-parent",runs:[],error:false});await o.retry();expect(o.changed.mock.calls.at(-1)[0].error).toBe(false);o.stop();});
 it("no current child source offers no empty error disclosure",async()=>{const o=observer(vi.fn(async()=>response(null as any,"unavailable",[])));await drain();expect(o.changed.mock.calls.at(-1)[0]).toEqual({owner:null,runs:[],error:false});o.stop();});
 it("an incompatible version never projects its rows",async()=>{const o=observer(vi.fn(async()=>({ok:true,status:200,json:async()=>({subagents:2,owner:"one",runs:[row]})})));await drain();expect(o.changed.mock.calls.at(-1)[0]).toEqual({owner:null,runs:[],error:true});o.stop();});
});

describe("cached child component visibility defence",()=>{
 const panel=readFileSync(new URL("../src/ui/panel-chat.js",import.meta.url),"utf8");
 const wrapper=panel.slice(panel.indexOf("function SubagentProgress("),panel.indexOf("/** Everything under the thread"));
 it.each(["guest","publicLink","unoffered","admin"])("respects %s even with an already loaded component",kind=>{
  const dataset={subagents:kind==="unoffered"?"0":"1",guest:kind==="guest"?"1":"",publicLink:kind==="publicLink"?"1":""};
  const scope:any={document:{body:{dataset}},useState:()=>[()=>null,()=>{}],useEffect:()=>{},html:()=>({rendered:true}),guestPage:()=>!!dataset.guest,publicLinkPage:()=>!!dataset.publicLink};
  runInNewContext(wrapper+"\nglobalThis.result=SubagentProgress({name:'dev'})",scope);expect(scope.result).toEqual(kind==="admin"?{rendered:true}:null);
 });
});

describe("progress retirement uses evidence deadlines, including old-server and error states",()=>{
 function render(runs:any[],at:number,error=false) {
  class Clock extends Date { static now() { return at; } }
  const scope:any={register:()=>{},t:(s:string)=>s,Date:Clock,Map,Number,Array,Object,useRef:()=>({current:null}),useEffect:()=>{},useState:(initial:any)=>typeof initial==="object"?[{owner:"same-owner",runs,error},()=>{}]:[at,()=>{}],html:()=>({shown:true})};
  runInNewContext(raw.replace(/^import .*;$/gm,"").replace(/export /g,"")+"\nglobalThis.result=SubagentRow({name:'dev'})",scope);return scope.result;
 }
 it.each(["completed","unknown","running"])("%s hides on the deadline even before another HTTP poll",state=>{
  const r={...row,state,startedAt:1000,expiresAt:15000};
  expect(render([r],14999)).toEqual({shown:true});expect(render([r],15000)).toBeNull();
  expect(render([r],15000,true)).toBeNull();expect(render(structuredClone([r]),16000,true)).toBeNull();
 });
 it("new work can appear after old work expires; an error alone cannot resurrect it",()=>{
  expect(render([{...row,startedAt:1000,expiresAt:15000}],20000,true)).toBeNull();
  expect(render([{...row,key:"new",startedAt:19000,expiresAt:139000}],20000)).toEqual({shown:true});
 });
 it("cached old servers without deadlines use original launch time, never page-open time",()=>{
  expect(render([{...row,startedAt:1000}],120999)).toEqual({shown:true});
  expect(render([{...row,startedAt:1000}],121000)).toBeNull();
  expect(render([{...row,startedAt:1000}],181000)).toBeNull();expect(render([row],181000)).toBeNull();
 });
});
