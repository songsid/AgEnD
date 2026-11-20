import { afterAll,beforeAll,beforeEach,expect,it } from "vitest";
import { page,settle,h,type AppPage } from "./helpers/app-harness.js";
let p:AppPage,A:any,C:any,S:any,i18n:any,view:any,requests:any[]=[];
beforeAll(async()=>{p=page({url:"http://127.0.0.1:19281/settings/accounts"});A=await import("/ui/js/accounts-view.js");C=await import("/ui/js/claude-credentials.js");S=await import("/ui/js/backend-signin.js");i18n=await import("/assets/app-i18n.js");(globalThis as any).fetch=async(url:any,options:any={})=>{requests.push({url,method:options.method||"GET"});return {ok:true,json:async()=>String(url).startsWith("/ui/accounts")?view:{selected:[],pending:[],login:null,targets:[]}};};});
afterAll(()=>{p.restore();delete (globalThis as any).fetch;});beforeEach(async()=>{await p.unmount();requests=[];S.signInStore.set({loaded:true,targets:[],login:null});});
async function render(language:string,state:string,verifiedAt:string|null="2026-11-20T12:00:00.000Z"){
 i18n.setLang(language,{store:false});const row={scope:{kind:"host"},backend:"claude-code",profile:"sample",state:"not_signed_in",signIn:true,credential:{source:"managed",kind:"api-key",revision:1,state,verifiedAt},identity:{maskedEmail:"prior@example.com",plan:"max"},usageGroups:[{windows:[{kind:"weekly",percent:42}]}],keepAlive:{enabled:true},usedBy:{agents:[],classic:[],fleetDefault:false}};
 view={clis:[{backend:"claude-code",profiles:true,installed:true,agents:[],rows:[row]}]};A.accountsStore.set({loaded:true,failed:false,view});await p.mount(h(A.AccountsView,{instances:{}}));await settle(8);
}
it.each(["en","zh-TW"])("%s renders a verified timestamp while preserving managed-source privacy and no extra model call",async language=>{
 await render(language,"verified");expect(p.root.textContent).toContain(language==="en"?"Verified":"已驗證");expect(p.root.querySelector("[data-credential-verified-at]").textContent).toContain("2026");expect(p.root.querySelector(".s-auth-state").className).toContain("is-usable");
 expect(p.root.textContent).not.toContain("prior@example.com");expect(p.root.textContent).not.toContain("42%");expect(requests.every(r=>r.method==="GET")).toBe(true);
});
it.each(["en","zh-TW"])("%s offers the 401/403 replace hint, while network unknown does not label the credential invalid",async language=>{
 await render(language,"needs-replacement",null);expect(p.root.querySelector("[data-credential-request-hint]").textContent).toContain("401/403");expect(p.root.querySelector(".s-auth-state").textContent).toBe(language==="en"?"Needs replacement":"需要替換憑證");
 expect(p.root.querySelectorAll("button").some((b:any)=>b.textContent===(language==="en"?"Replace credential":"替換憑證"))).toBe(true);
 await render(language,"unknown",null);expect(p.root.querySelector(".s-auth-state").textContent).toContain(language==="en"?"Unknown":"未知");expect(p.root.querySelector("[data-credential-request-hint]").textContent).toContain(language==="en"?"does not mean":"不代表");expect(p.root.querySelector("[data-credential-verified-at]")).toBe(null);expect(requests.every(r=>r.method==="GET")).toBe(true);
});
it("missing timestamp cannot show Verified, and older metadata stays saved-unverified",()=>{
 expect(C.credentialRequestState({kind:"api-key",state:"verified",verifiedAt:null})).toBe("unknown");expect(C.credentialRequestState({kind:"api-key",state:"verified",verifiedAt:"not-a-date"})).toBe("unknown");expect(C.credentialRequestState({kind:"api-key"})).toBe("saved-unverified");expect(C.credentialVerificationTime({kind:"api-key"})).toBe(null);
});
