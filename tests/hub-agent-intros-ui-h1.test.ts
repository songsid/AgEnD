import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page,h,settle,type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui:any,words:any,clients:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();ui=await import("/ui/js/hub-agent-intro.js");words=await import("/assets/app-i18n.js");clients=await import("/ui/js/hub-client.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
it.each(["en","zh-TW"])("keeps an unsaved introduction, counts graphemes, and saves explicitly (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});const save=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true}),saved=vi.fn();
 await p.mount(h(ui.AgentIntroEditor,{exposure:{id:"guide",revision:7,intro:"",introBy:"owner",introAt:1000},client:{saveAgentIntro:save},onSaved:saved}));
 const field=p.root.querySelector("input");field.value="👨‍👩‍👧‍👦".repeat(51);fire(field,"input");await settle();expect(p.root.querySelector("button")?.disabled).toBe(true);
 field.value="我負責文件";fire(field,"input");await settle();expect(save).not.toHaveBeenCalled();fire(p.root.querySelector("form"),"submit");await settle();
 expect(save).toHaveBeenCalledWith("guide",7,"我負責文件");expect(saved).not.toHaveBeenCalled();expect(field.value).toBe("我負責文件");
 fire(p.root.querySelector("form"),"submit");await settle();expect(saved).toHaveBeenCalledTimes(1);expect(p.root.textContent).not.toContain("hubIntro.");
});
it("uses PUT with the existing client CSRF and encoded exposure id",async()=>{
 const calls:any[]=[];const client=clients.createHubWebClient({fetchImpl:async(path:string,opts:any)=>{calls.push({path,opts});return new Response(JSON.stringify(path.endsWith("/session")?{signedIn:true,csrf:"fixture-csrf"}:{}),{status:200});}});
 await client.session();await client.saveAgentIntro("guide/one",3,"I handle notes.");
 expect(calls.at(-1)).toMatchObject({path:"/hub/v1/exposures/guide%2Fone/intro",opts:{method:"PUT",body:JSON.stringify({revision:3,text:"I handle notes."})}});
 expect(calls.at(-1).opts.headers["X-AgEnD-Hub-CSRF"]).toBe("fixture-csrf");
});
