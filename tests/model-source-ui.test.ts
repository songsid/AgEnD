import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

let p:AppPage, ModelSelect:any, catalogs:any, setLang:any;
const realFetch=globalThis.fetch;
let answer:any;
const requests:string[]=[];
const note=()=>p.root.querySelector(".model-catalog-status [role=status]")?.textContent;
const options=()=>p.root.querySelectorAll(".model-pick option").map((item:any)=>item.value);

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/agents",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(path:string)=>{requests.push(path);return {ok:true,status:200,json:async()=>answer};}) as any;
  setLang=(await import("/assets/app-i18n.js")).setLang;
  ModelSelect=(await import("/ui/js/settings-dialogs.js")).ModelSelect;
  catalogs=await import("/ui/js/settings-catalog.js");
});
beforeEach(()=>{requests.length=0;catalogs.forgetCatalogs();answer={models:[{id:"listed-model",label:"Listed model"}]};setLang("en",{store:false});});
afterEach(async()=>{await p.unmount();});
afterAll(()=>{p.restore();globalThis.fetch=realFetch;});

describe("model catalog source provenance",()=>{
  it.each([
    ["en","cli-list","Source: CLI model listing."],
    ["en","cli-cache","Source: local CLI model cache."],
    ["en","official-catalog","Source: official candidate list. Availability depends on your account and provider."],
    ["en",undefined,"Source: AgEnD's cached CLI/account model list."],
    ["zh-TW","cli-list","來源：CLI 列舉結果。"],
    ["zh-TW","cli-cache","來源：本機 CLI 模型快取。"],
    ["zh-TW","official-catalog","來源：官方候選清單，實際可用性依帳戶與服務設定。"],
    ["zh-TW",undefined,"來源：AgEnD 已快取的 CLI／帳號模型清單。"],
  ])("labels %s %s catalogs without changing the selected model",async(lang,source,expected)=>{
    setLang(lang,{store:false});answer={...answer,...(source?{source}:{})};const onChange=vi.fn();
    await p.mount(h(ModelSelect,{backend:"claude-code",runtime:source?"windows":"wsl",value:"saved-custom-model",onChange,inherit:"CLI default"}));await settle(8);
    expect(note()).toBe(expected);
    expect(options()).toEqual(["","saved-custom-model","listed-model","\u0000other"]);
    expect(p.root.querySelector(".model-pick select").value).toBe("saved-custom-model");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates the displayed source after refresh without claiming the old cache was a live listing",async()=>{
    answer={...answer,source:"cli-cache"};const onChange=vi.fn();
    await p.mount(h(ModelSelect,{backend:"codex",runtime:"windows",value:"saved-custom-model",onChange,inherit:"CLI default"}));await settle(8);
    expect(note()).toBe("Source: local CLI model cache.");
    answer={models:[{id:"new-list-model",label:"New listing"}],source:"cli-list"};
    p.root.querySelector(".model-catalog-status button").click();await settle(8);
    expect(requests).toContain("/ui/models?backend=codex&runtime=windows&refresh=1");
    expect(note()).toBe("Source: CLI model listing.");expect(options()).toContain("new-list-model");expect(options()).not.toContain("listed-model");
    expect(p.root.querySelector(".model-pick select").value).toBe("saved-custom-model");expect(onChange).not.toHaveBeenCalled();
  });
});
