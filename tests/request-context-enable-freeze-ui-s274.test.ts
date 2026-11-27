import {afterEach,expect,it,vi} from "vitest";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
const pages:AppPage[]=[];
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.unstubAllGlobals();});
it.each(["en","zh-TW"])("S-274: the real Settings switch refuses On and explains why (%s)",async language=>{
 const p=page();pages.push(p);
 const words=await import("/assets/app-i18n.js") as any;words.setLang(language,{store:false});
 const view={revision:1,enabled:false,everActivated:false,attempted:false,phase:"off",canChange:true,blockers:[],enableUnavailable:true};
 const fetch=vi.fn(async()=>({ok:true,status:200,json:async()=>view}));vi.stubGlobal("fetch",fetch);
 const ui=await import("/ui/js/request-context-control.js") as any;
 await p.mount(h(ui.RequestContextSettings,{}));await settle(8);
 const toggle=p.root.querySelector('input[type="checkbox"]');expect(toggle).toBeTruthy();expect(toggle.disabled).toBe(true);expect(toggle.checked).toBe(false);
 const reason=language==="en"?"Request-based approvals can't be turned on in this version yet.":"這一版還不能開啟依請求核准聯絡。";
 expect(p.root.textContent).toContain(reason);expect(fetch).toHaveBeenCalledTimes(1);
 if(process.env.CAPTURE_REQUEST_CONTEXT_FREEZE){const out=process.env.CAPTURE_REQUEST_CONTEXT_FREEZE;mkdirSync(out,{recursive:true});writeFileSync(join(out,language+".txt"),`Real Settings component, synthetic never-activated status\nLanguage: ${language}\nSwitch: off, disabled\n${[...p.root.querySelectorAll("h2,p")].map(node=>node.textContent).join("\n")}\n`);}
});
it("S-274: the release freeze leaves an already-On owner's Off switch usable",async()=>{
 const p=page();pages.push(p);
 vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,status:200,json:async()=>({revision:2,enabled:true,everActivated:true,attempted:true,phase:"on",canChange:true,blockers:[],enableUnavailable:true})})));
 const ui=await import("/ui/js/request-context-control.js") as any;
 await p.mount(h(ui.RequestContextSettings,{}));await settle(8);
 const toggle=p.root.querySelector('input[type="checkbox"]');expect(toggle.disabled).toBe(false);expect(toggle.checked).toBe(true);
});
