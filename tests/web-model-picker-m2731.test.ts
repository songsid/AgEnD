import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });
describe("the shared model field's explicit refresh", () => {
  it("keeps the selection/list while refreshing and after failure; Retry makes another POST", async () => {
    p = page(); (await import("/ui/js/model-picker.js")).forgetModelPickerCatalogs();
    const calls: any[] = []; let finish: (v: any) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url, opts: any = {}) => {
      calls.push({ url, opts });
      const value = opts.method === "POST" ? await new Promise(r => { finish = r; }) : { models: [{ id: "sonnet", label: "Sonnet" }] };
      return { ok: true, json: async () => value };
    }));
    const { ModelSelect } = await import("/ui/js/settings-dialogs.js"); const change = vi.fn();
    await p.mount(h(ModelSelect, { backend: "claude-code", instance: "w", value: "sonnet", onChange: change })); await settle(8);
    const refresh = () => p.root.querySelector(".model-refresh button")!;
    expect(refresh()).not.toBeNull(); fire(refresh(), "click"); await settle();
    expect(refresh().disabled).toBe(true); expect(p.root.querySelector("select")!.value).toBe("sonnet");
    expect(p.root.textContent).toContain("Sonnet"); expect(change).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({ url: "/ui/models/refresh", opts: { method: "POST", body: JSON.stringify({ backend: "claude-code", instance: "w" }) } });
    finish({ refreshed: false, models: [] }); await settle(8);
    expect(p.root.querySelector(".error-state")).not.toBeNull(); expect(p.root.textContent).toContain("Sonnet");
    fire(p.root.querySelector(".error-state button")!, "click"); await settle();
    expect(calls.filter(x => x.opts.method === "POST")).toHaveLength(2);
    finish({ refreshed: true, models: [{ id: "opus", label: "Opus" }] }); await settle(8);
    expect(p.root.textContent).toContain("Opus"); expect(p.root.querySelector("select")!.value).toBe("sonnet"); expect(change).not.toHaveBeenCalled();
  });
  it("a late refresh for a different backend cannot replace the new backend's catalog", async () => {
    p = page(); (await import("/ui/js/model-picker.js")).forgetModelPickerCatalogs(); let finish: (v: any) => void = () => {};
    vi.stubGlobal("fetch", async (url: string, opts: any = {}) => ({ ok: true, json: async () => opts.method === "POST" ? await new Promise(r => { finish = r; }) : { models: [{ id: url.includes("codex") ? "gpt" : "sonnet", label: "Model" }] } }));
    const { ModelSelect } = await import("/ui/js/settings-dialogs.js");
    const render = (backend: string) => p.mount(h(ModelSelect, { backend, instance: "w", value: "", onChange() {} }));
    await render("claude-code"); await settle(8); fire(p.root.querySelector(".model-refresh button")!, "click"); await settle();
    await render("codex"); await settle(8); finish({ refreshed: true, models: [{ id: "private-old", label: "Old" }] }); await settle(8);
    expect(p.root.querySelectorAll("option").map((x: any) => x.value)).toContain("gpt"); expect(p.root.querySelectorAll("option").map((x: any) => x.value)).not.toContain("private-old");
  });
});

it("alpha: switching account or computer changes both read/refresh keys and discards a held prior response",async()=>{
 p=page();(await import("/ui/js/model-picker.js")).forgetModelPickerCatalogs();const calls:any[]=[];let finish!:(v:any)=>void;
 vi.stubGlobal("fetch",async(url:string,opts:any={})=>{calls.push({url,opts});return {ok:true,json:async()=>opts.method==="POST"?new Promise(r=>{finish=r;}):{models:[{id:new URL(url,"http://local").searchParams.get("profile"),label:"Chosen"}]}};});
 const {ModelSelect}=await import("/ui/js/settings-dialogs.js");const render=(machineId:string,profile:string)=>p.mount(h(ModelSelect,{backend:"claude-code",runtime:"windows",machineId,profile,value:"",onChange(){}}));
 await render("first","work");await settle(8);fire(p.root.querySelector(".model-refresh button")!,"click");await settle();
 expect(JSON.parse(calls.at(-1).opts.body)).toMatchObject({runtime:"windows",machineId:"first",profile:"work"});
 await render("second","personal");await settle(8);finish({refreshed:true,models:[{id:"old-private",label:"Old"}]});await settle(8);
 expect(calls.some(c=>c.url.includes("machineId=second")&&c.url.includes("profile=personal"))).toBe(true);
 expect(p.root.querySelectorAll("option").map((o:any)=>o.value)).toContain("personal");expect(p.root.textContent).not.toContain("Old");
});
