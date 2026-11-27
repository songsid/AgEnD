import {afterEach,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
const pages:AppPage[]=[];
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}});
it.each(["en","zh-TW"])("retains the existing failure/recheck explanation after a server refresh (%s)",async lang=>{
 const p=page();pages.push(p);
 const words=await import("/assets/app-i18n.js") as any;words.setLang(lang,{store:false});
 const ui=await import("/ui/js/request-context-control.js") as any,onCheck=vi.fn();
 await p.mount(h(ui.RequestContextBlocked,{state:{enabled:false,everActivated:false,attempted:true,phase:"blocked",canChange:true,blockers:[],enableFailed:true},onCheck}));await settle(5);
 expect(p.root.querySelector('[role="alert"]')?.textContent).toContain(lang==="en"?"Couldn't confirm whether anything changed. Press Check again.":"無法確認是否已變更，請按「重新檢查」。");
 const button=[...p.root.querySelectorAll("button")].find(x=>x.textContent===(lang==="en"?"Check again":"重新檢查"));expect(button).toBeTruthy();fire(button!,"click");expect(onCheck).toHaveBeenCalledOnce();
});
