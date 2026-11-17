import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
let intro:any,notice:any,words:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();intro=await import("/ui/js/hub-agent-intro.js");notice=await import("/ui/js/hub-intro-notice.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const button=(p:AppPage,text:string)=>[...p.root.querySelectorAll("button")].find((el:any)=>el.textContent===text);
it.each(["en","zh-TW"])("previews a default before granting; an explicit edit saves without submitting the grant form (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});const grant=vi.fn((e:any)=>e.preventDefault()),save=vi.fn(async(_id:string,_revision:number,text:string)=>({ok:true,intro:text,introBy:"owner",introAt:1}));
 await p.mount(h("form",{onSubmit:grant},h(intro.AgentIntroSharingPreview,{exposure:{id:"guide",revision:2,intro:"",introDefault:"I handle notes."},client:{saveAgentIntro:save}})));
 expect(p.root.textContent).toContain("I handle notes.");expect(save).not.toHaveBeenCalled();fire(button(p,lang==="en"?"Edit":"編輯"),"click");await settle();
 expect(p.root.querySelectorAll("form")).toHaveLength(1);const input=p.root.querySelector("input");input.value="Reviewed line";fire(input,"input");await settle();
 fire(button(p,lang==="en"?"Save introduction":"儲存自我介紹"),"click");await settle();expect(save).toHaveBeenCalledWith("guide",2,"Reviewed line");expect(grant).not.toHaveBeenCalled();expect(p.root.textContent).toContain("Reviewed line");
});
it.each(["en","zh-TW"])("lists existing-share defaults for the owner until acknowledgement (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});const ack=vi.fn(async()=>({ok:true})),read=vi.fn(async()=>({ok:true,notice:{id:"agent-introductions",batches:[{fleetId:"fleet",fleet:"Example Fleet",more:false,agents:[{id:"guide",name:"Guide"}]}]}}));
 await p.mount(h(notice.IntroNotice,{client:{introNotice:read,acknowledgeIntroNotice:ack}}));await settle();expect(p.root.textContent).toContain(lang==="en"?"Introductions now show for 1":"你的 1 個 Agent");expect(p.root.querySelector("a")?.getAttribute("href")).toBe("/ui/hub/exposures?agent=guide");
 fire(button(p,lang==="en"?"Done":"完成"),"click");await settle();expect(ack).toHaveBeenCalledTimes(1);expect(p.root.querySelector("section")).toBeNull();
});
it.each(["en","zh-TW"])("names the later Fleet and only its newly filled agents on reopening (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});
 await p.mount(h(notice.IntroNotice,{client:{introNotice:async()=>({ok:true,notice:{id:"agent-introductions",batches:[{fleetId:"second",fleet:"Another Fleet",more:true,agents:[{id:"second-guide",name:"Later guide"}]}]}}),acknowledgeIntroNotice:async()=>({ok:true})}}));await settle();
 expect(p.root.textContent).toContain(lang==="en"?"1 more of your agents, from Another Fleet":"你在 Another Fleet 的 1 個 Agent");expect(p.root.textContent).toContain("Later guide");expect(p.root.querySelector("a")?.getAttribute("href")).toContain("second-guide");
});
