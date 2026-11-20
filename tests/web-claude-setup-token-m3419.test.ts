import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p:AppPage,ui:any,i18n:any,requests:any[]=[],answer:(request:any)=>any;
beforeAll(async()=>{p=page({url:"http://127.0.0.1:19281/settings/accounts"});i18n=await import("/assets/app-i18n.js");ui=await import("/ui/js/claude-setup-token.js");(globalThis as any).fetch=async(url:any,init:any)=>{const r={url,body:JSON.parse(init.body)};requests.push(r);const body=await answer(r);return {ok:!body.error,json:async()=>body};};});
afterAll(()=>{p.restore();delete (globalThis as any).fetch;});
beforeEach(async()=>{await p.unmount();requests=[];answer=()=>({login:{id:"a".repeat(32),revision:2,phase:"code",mine:true,canAct:true,url:"https://claude.ai/oauth/authorize?fixture=1"}});i18n.setLang("en",{store:false});});
const button=(label:string)=>p.root.querySelectorAll("button").find((b:any)=>b.textContent.trim()===label);
it.each(["en","zh-TW"])("%s renders the private flow with paste retained and no secret or terminal access",async language=>{
 i18n.setLang(language,{store:false});const saved:any[]=[],busy:any[]=[];
 await p.mount(h(ui.ClaudeTokenFetch,{profile:"sample",read:{ok:true,local:true,credential:{revision:1},consumers:{users:[]}},onBusy:(v:any)=>busy.push(v),onSaved:(v:any)=>saved.push(v)}));await settle(4);
 fire(button(language==="en"?"Get a token for me":"幫我取得 Token"),"click");await settle(8);
 expect(requests[0]).toMatchObject({url:"/ui/claude-credentials/setup-token",body:{operation:"start",profile:"sample",revision:1}});
 expect(p.root.textContent).toContain(language==="en"?"Or paste a setup-token below":"或在下方貼上 setup-token");
 const link=p.root.querySelector("a");expect(link.getAttribute("target")).toBe("_blank");expect(link.getAttribute("href")).toContain("https://claude.ai/");
 const input=p.root.querySelector("input");input.value="fixture-code";
 answer=()=>({login:{id:"a".repeat(32),revision:3,phase:"done",mine:true},credential:{revision:2,kind:"setup-token"},pending:[]});
 fire(button(language==="en"?"Submit authorization code":"送出授權碼"),"click");await settle(8);
 expect(requests[1].body).toMatchObject({operation:"input",revision:2,action:{kind:"code",value:"fixture-code"}});expect(input.value).toBe("");expect(saved).toHaveLength(1);expect(busy.at(-1)).toBe(false);
 expect(p.root.textContent).not.toContain("fixture-code");expect(p.root.textContent).not.toContain("sk-ant-");
});
it("unmount cancels only the owned start and local-unverified state cannot start",async()=>{
 await p.mount(h(ui.ClaudeTokenFetch,{read:{ok:true,local:false}}));await settle(4);expect(button("Get a token for me").disabled).toBe(true);expect(requests).toEqual([]);
 await p.unmount();await p.mount(h(ui.ClaudeTokenFetch,{read:{ok:true,local:true,credential:{revision:0}}}));
 answer=()=>({started:"a".repeat(32),login:{id:"a".repeat(32),revision:1,phase:"authorization",mine:true,url:"https://claude.ai/oauth/authorize?fixture=1"}});
 fire(button("Get a token for me"),"click");await settle(6);await p.unmount();await settle(4);expect(requests.at(-1).body).toEqual({operation:"cancel",id:"a".repeat(32)});
});
