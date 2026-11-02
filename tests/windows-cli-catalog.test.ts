import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, createCatalog: any, DiscoveryStatus: any;
const inventory = (version = "Codex 1") => ({ home:"C:\\Test", clis:[{id:"codex",path:"C:\\codex.exe",version,authenticated:true,runnable:true}] });
const response = (data = inventory(), status = 200) => ({ ok:status < 400, status, json:async () => data });
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(done => { resolve=done; });
  return { promise, resolve };
}
beforeAll(async () => {
  p=page({url:"http://localhost/ui",storage:{agend_lang:"en"}});
  ({createWindowsCliCatalog:createCatalog,WindowsCliDiscoveryStatus:DiscoveryStatus}=await import("/ui/js/windows-cli-catalog.js"));
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
});
afterEach(async()=>p.unmount());
afterAll(()=>p.restore());

describe("page-lived Windows CLI inventory",()=>{
  it("reuses recent successful results and lets an explicit refresh bypass them",async()=>{
    let clock=1000;
    const fetcher=vi.fn(async(_path:string,_options:any)=>response());
    const catalog=createCatalog({fetcher,now:()=>clock,ttlMs:1000});
    expect(await catalog.load()).toEqual(inventory());
    expect(catalog.get()).toMatchObject({data:inventory(),checkedAt:1000,loading:false,error:""});
    clock=1500;
    expect(await catalog.load()).toEqual(inventory());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await catalog.load({force:true});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({force:true});
    expect(catalog.get().checkedAt).toBe(1500);
  });

  it("joins the same pending read, including manual refresh, instead of probing twice",async()=>{
    const gate=deferred<any>(), fetcher=vi.fn(()=>gate.promise);
    const catalog=createCatalog({fetcher});
    const first=catalog.load(), second=catalog.load(), forced=catalog.load({force:true});
    expect(first).toBe(second);expect(first).toBe(forced);
    expect(catalog.get()).toMatchObject({data:null,loading:true,error:""});
    gate.resolve(response());await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(catalog.get().loading).toBe(false);
  });

  it("refreshes expired results while preserving the previous inventory for immediate display",async()=>{
    let clock=1000;
    const gate=deferred<any>();
    const fetcher=vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(()=>gate.promise);
    const catalog=createCatalog({fetcher,now:()=>clock,ttlMs:1000});
    await catalog.load();clock=2000;
    const refresh=catalog.load();
    expect(catalog.get()).toMatchObject({data:inventory(),loading:true,checkedAt:1000,startedAt:2000});
    gate.resolve(response(inventory("Codex 2")));await refresh;
    expect(catalog.get()).toMatchObject({data:inventory("Codex 2"),loading:false,checkedAt:2000});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps successful inventory on refresh failure and retries without caching the failure",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(Error("Windows bridge disconnected")).mockResolvedValueOnce(response(inventory("Codex 2")));
    const catalog=createCatalog({fetcher});
    await catalog.load();const checkedAt=catalog.get().checkedAt;
    expect(await catalog.load({force:true})).toBeNull();
    expect(catalog.get()).toMatchObject({data:inventory(),loading:false,checkedAt,error:"Windows bridge disconnected"});
    await catalog.load({force:true});
    expect(catalog.get()).toMatchObject({data:inventory("Codex 2"),loading:false,error:""});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([401,403])("clears private inventory after an HTTP %i refusal",async status=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({error:"Authorization expired"} as any,status));
    const catalog=createCatalog({fetcher});
    await catalog.load();await catalog.load({force:true});
    expect(catalog.get()).toMatchObject({data:null,checkedAt:0,loading:false,error:"Authorization expired"});
  });

  it("treats malformed data as a failed probe and allows a fresh retry",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response({home:"C:\\Test",clis:null} as any)).mockResolvedValueOnce(response());
    const catalog=createCatalog({fetcher});
    expect(await catalog.load()).toBeNull();
    expect(catalog.get()).toMatchObject({data:null,loading:false,error:"Invalid Windows CLI inventory response"});
    await catalog.load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(catalog.get().data).toEqual(inventory());
  });

  it("does not leave retries joined to an already-failed synchronous fetch",async()=>{
    const fetcher=vi.fn().mockImplementationOnce(()=>{throw Error("Network unavailable");}).mockResolvedValueOnce(response());
    const catalog=createCatalog({fetcher});
    expect(await catalog.load()).toBeNull();
    expect(catalog.get()).toMatchObject({data:null,loading:false,error:"Network unavailable"});
    expect(await catalog.load({force:true})).toEqual(inventory());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores a late result after cache reset so it cannot overwrite a new inventory",async()=>{
    const gate=deferred<any>();
    const fetcher=vi.fn().mockImplementationOnce(()=>gate.promise).mockResolvedValueOnce(response(inventory("Codex 2")));
    const catalog=createCatalog({fetcher});
    const old=catalog.load();await Promise.resolve();
    const oldSignal=fetcher.mock.calls[0][1].signal;
    catalog.clear();expect(oldSignal.aborted).toBe(true);
    expect(catalog.get()).toMatchObject({data:null,loading:false,error:""});
    await catalog.load();gate.resolve(response(inventory("stale")));await old;
    expect(catalog.get()).toMatchObject({data:inventory("Codex 2"),loading:false,error:""});
  });

  it("reports an aborted timed-out probe and clears loading so the user can retry",async()=>{
    const fetcher=vi.fn((_path:string,options:any)=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener("abort",()=>reject(Error("AbortError")),{once:true});
    }));
    const catalog=createCatalog({fetcher,timeoutMs:10});
    expect(await catalog.load()).toBeNull();
    expect(catalog.get()).toMatchObject({data:null,loading:false,error:"Windows CLI detection timed out"});
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("keeps explaining progress when a cold probe takes longer than eight seconds",async()=>{
    await p.mount(h(DiscoveryStatus,{state:{loading:true,data:null,error:"",startedAt:Date.now()-12_000,refresh(){}}}));
    await settle(4);
    const status=p.root.querySelector('[role="status"]');
    expect(status.textContent).toContain("Detecting Windows CLIs…");
    expect(status.textContent).toContain("Still checking after");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(p.root.querySelector('[role="alert"]')).toBeNull();
  });
});
