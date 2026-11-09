/** Mounted production shared form; public replies are scripted here. Real HTTPS/LDAP belongs to the browser acceptance. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto, X509Certificate } from "node:crypto";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
let mod:any, host:any, i18n:any;
const pages:AppPage[]=[];
const ref="a".repeat(32),probeRef="b".repeat(32),leaf="A1".repeat(32),challenge="public-confirmation";
const directory={realm:"fictional",profile:"ad",url:"ldaps://old.example.test:636",baseDn:"DC=example,DC=test",bindDn:"CN=Reader,DC=example,DC=test",timeoutMs:5000};
const initial=()=>({ok:true,epoch:0,directory:{...directory},bindPasswordSet:true,reauthentication:"host"});
const prepared=(trust:any=null)=>({ok:true,ref,expiresAt:Date.now()+300_000,trust});
const trust=(extra:any={})=>({challenge,server:"ldaps://new.example.test:636",leafFingerprint:leaf,caFingerprints:[],systemRoots:true,...extra});
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {resolve,promise};};
beforeAll(async()=>{const p=page();mod=await import("/ui/js/hub-directory-editor.js");host=await import("/ui/js/settings-hub-directory.js");i18n=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();vi.unstubAllGlobals();});
function client(view=initial()){
  let ended!:()=>void;
  const c:any={directoryEditorV1:true,directorySettings:vi.fn(async()=>view),prepareDirectorySettings:vi.fn(async()=>prepared()),
    testDirectorySettings:vi.fn(async()=>({ok:true})),saveDirectorySettings:vi.fn(async()=>{view={...view,epoch:view.epoch+1};return {ok:true,state:"ready",directoryEpoch:view.epoch};}),
    cancelDirectorySettings:vi.fn(async()=>({ok:true})),inspectDirectoryCa:vi.fn(async()=>({ok:true,ref:probeRef,server:"ldaps://new.example.test:636",certificate:{fingerprint256:leaf}})),
    fetchDirectoryCa:vi.fn(),onSignedOut:(fn:()=>void)=>{ended=fn;return ()=>{};},end:()=>ended?.()};return c;
}
async function mount(c=client(),props:any={},language="en"){
  const p=page({url:"https://hub.example.test/ui/hub/admin?view=directory",storage:{agend_lang:language}});pages.push(p);i18n.setLang(language);vi.stubGlobal("crypto",webcrypto);
  await p.mount(h(mod.HubDirectoryEditor,{client:c,offered:true,host:true,...props}));await settle(15);return {p,c};
}
function button(p:AppPage,label:string){return [...p.root.querySelectorAll("button")].find((b:any)=>b.textContent===label);}
async function click(p:AppPage,label:string){const b=button(p,label);expect(b,label).toBeTruthy();fire(b,"click");await settle(20);}
async function fill(p:AppPage,name:string,value:string){const e=p.root.querySelector("#hubDirectory-"+name);expect(e,name).toBeTruthy();e.value=value;fire(e,e.tagName==="SELECT"?"change":"input");await settle(4);}
async function submit(p:AppPage){fire(p.root.querySelector("form"),"submit");await settle(24);}
async function changedTarget(p:AppPage){await fill(p,"url","ldaps://new.example.test:636");await fill(p,"bindPassword","Dummy-service-only");}
async function authField(p:AppPage,type:string,value:string){const e=p.root.querySelector(`input[autocomplete="${type}"]`);expect(e).toBeTruthy();e.value=value;fire(e,"input");await settle(4);}
describe("AD editor's mounted presentation",()=>{
  it.each([{offered:false},{oldClient:true}])("withholds reads and controls without both capabilities %j",async mode=>{
    const c=client();if(mode.oldClient)c.directoryEditorV1=false;const {p}=await mount(c,{offered:mode.offered!==false});expect(c.directorySettings).not.toHaveBeenCalled();expect(p.root.querySelector("form")).toBeNull();
  });
  it.each([{ok:true}, {...initial(),epoch:undefined},{...initial(),epoch:-1},{...initial(),reauthentication:"unknown"}])("refuses an incompatible read DTO",async view=>{
    const {p}=await mount(client(view as any));expect(p.root.querySelector("form")).toBeNull();expect(p.root.textContent).toContain("same AD editor");
  });
  it("shows current values and immutable realm/profile with no returned secret reference",async()=>{
    const {p}=await mount();expect(p.root.querySelector("#hubDirectory-url").value).toBe(directory.url);expect(p.root.querySelector("#hubDirectory-bindPassword").value).toBe("");
    expect(p.root.textContent).toContain("fictional");expect(p.root.querySelector("#hubDirectory-realm")).toBeNull();expect(p.root.textContent).not.toContain("bindPasswordRef");
  });
  it("uses clear zh-TW directory, stored-password and SHA-256 trust labels with whole fingerprint groups",async()=>{
    const c=client();c.prepareDirectorySettings.mockResolvedValue(prepared(trust()));const {p}=await mount(c,{},"zh-TW");
    expect(p.root.textContent).toContain("Active Directory（AD）");expect(p.root.textContent).toContain("信任的憑證來源");
    expect(p.root.querySelector("#hubDirectory-bindPassword").getAttribute("placeholder")).toBe("已設定（留空則不變更）");
    expect(button(p,"擷取 CA 並儲存…")).toBeTruthy();await changedTarget(p);await submit(p);
    const dialog=p.root.querySelector("dialog");expect(dialog.textContent).toContain("要信任的伺服器");expect(dialog.textContent).toContain("SHA-256");expect(button(p,"取消")).toBeTruthy();
    const groups=[...dialog.querySelectorAll(".hub-directory-fingerprint span")];expect(groups).toHaveLength(8);expect(groups.every((g:any)=>/^[A-F0-9]{8}$/.test(g.textContent))).toBe(true);
    expect(c.saveDirectorySettings).not.toHaveBeenCalled();
  });
  it("one Save prepares, rechecks the displayed source, saves once, refreshes session before reading the result",async()=>{
    const c=client(),order:string[]=[];const read=c.directorySettings.getMockImplementation();c.directorySettings.mockImplementation(async()=>{order.push("read");return read();});
    const {p}=await mount(c,{afterSave:async()=>{order.push("session");return true;}});await fill(p,"baseDn","OU=People,DC=example,DC=test");await submit(p);
    expect(c.saveDirectorySettings).toHaveBeenCalledOnce();expect(c.saveDirectorySettings.mock.calls[0][0]).toEqual({ref});expect(c.testDirectorySettings).not.toHaveBeenCalled();
    expect(order).toEqual(["read","read","session","read"]);expect(p.root.textContent).toContain("AD connection saved.");
  });
  it("Test never saves or sends personal credentials",async()=>{
    const {p,c}=await mount();await fill(p,"baseDn","OU=People,DC=example,DC=test");await click(p,"Test connection");expect(c.testDirectorySettings.mock.calls[0][0]).toEqual({ref});
    expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(c.cancelDirectorySettings).toHaveBeenCalledWith({ref});expect(p.root.textContent).toContain("Nothing was saved");
  });
  it("requires an explicit new service password for a different target and preserves opaque secret bytes",async()=>{
    const {p,c}=await mount();await fill(p,"url","ldaps://new.example.test:636");await submit(p);expect(c.prepareDirectorySettings).not.toHaveBeenCalled();
    const secret=" \ufeff密碼\n ";await fill(p,"bindPassword",secret);await submit(p);expect(c.prepareDirectorySettings.mock.calls[0][0].bindPassword).toBe(secret);
  });
  it("a changed host gets one trust dialog and no Save until the exact displayed fingerprints are confirmed",async()=>{
    const c=client();c.prepareDirectorySettings.mockResolvedValue(prepared(trust()));const {p}=await mount(c);await changedTarget(p);await submit(p);
    expect(p.root.querySelectorAll("dialog")).toHaveLength(1);expect(p.root.textContent).toContain("A1A1A1A1");expect(c.saveDirectorySettings).not.toHaveBeenCalled();
    await click(p,"Confirm fingerprints and save");expect(c.saveDirectorySettings.mock.calls[0][0]).toEqual({ref,confirmation:challenge});expect(p.root.querySelector("dialog")).toBeNull();
  });
  it("Stop on a mismatch cancels the draft, clears secrets and never saves",async()=>{
    const c=client();c.prepareDirectorySettings.mockResolvedValue(prepared(trust()));const {p}=await mount(c);await changedTarget(p);await submit(p);await click(p,"Cancel");
    expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(c.cancelDirectorySettings).toHaveBeenCalledWith({ref});expect(p.root.querySelector("dialog")).toBeNull();expect(p.root.querySelector("#hubDirectory-bindPassword").value).toBe("");
  });
  it.each(["epoch","directory"])("a changed displayed %s after preparation refuses before any effect",async fault=>{
    const c=client();c.directorySettings.mockResolvedValueOnce(initial()).mockResolvedValue({...initial(),...(fault==="epoch"?{epoch:1}:{directory:{...directory,baseDn:"OU=Other"}})});
    const {p}=await mount(c);await fill(p,"baseDn","OU=People");await submit(p);expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(c.testDirectorySettings).not.toHaveBeenCalled();expect(c.cancelDirectorySettings).toHaveBeenCalledWith({ref});expect(p.root.textContent).toContain("changed while");
  });
  it.each([{server:"ldaps://other.example.test:636"},{leafFingerprint:"invalid"},{caFingerprints:["invalid"]}])("refuses an incompatible trust reply %j",async bad=>{
    const c=client();c.prepareDirectorySettings.mockResolvedValue(prepared(trust(bad)));const {p}=await mount(c);await changedTarget(p);await submit(p);expect(p.root.querySelector("dialog")).toBeNull();expect(c.saveDirectorySettings).not.toHaveBeenCalled();
  });
  it.each(["unmount","signout"])("a held prepare after %s cannot display a draft or save",async mode=>{
    const held=deferred(),c=client();c.prepareDirectorySettings.mockReturnValue(held.promise);const {p}=await mount(c);await changedTarget(p);await submit(p);
    const signal=c.prepareDirectorySettings.mock.calls[0][1];if(mode==="unmount")await p.unmount();else c.end();held.resolve(prepared(trust()));await settle(20);
    expect(signal.aborted).toBe(true);expect(c.cancelDirectorySettings).toHaveBeenCalledWith({ref});expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(p.root.querySelector("dialog")).toBeNull();
  });
  it("duplicate Save clicks do not escape one in-flight operation",async()=>{
    const held=deferred(),c=client();c.prepareDirectorySettings.mockReturnValue(held.promise);const {p}=await mount(c);fire(p.root.querySelector("form"),"submit");fire(p.root.querySelector("form"),"submit");await settle(10);
    expect(c.prepareDirectorySettings).toHaveBeenCalledOnce();held.resolve(prepared());await settle(20);expect(c.saveDirectorySettings).toHaveBeenCalledOnce();
  });
  it.each(["network","revoked","post-save-read"])("an ambiguous %s Save requires a fresh read and never retries automatically",async fault=>{
    const c=client();if(fault==="network")c.saveDirectorySettings.mockRejectedValue(Error("private detail"));else if(fault==="revoked")c.saveDirectorySettings.mockResolvedValue({ok:false,code:"revoked"});
    else c.directorySettings.mockResolvedValueOnce(initial()).mockResolvedValueOnce(initial()).mockRejectedValue(Error("private detail"));
    const {p}=await mount(c);await fill(p,"baseDn","OU=People");await submit(p);expect(c.saveDirectorySettings).toHaveBeenCalledOnce();expect(p.root.querySelector("form")).toBeNull();expect(p.root.textContent).toContain("Save could not be confirmed");expect(p.root.textContent).not.toContain("private detail");
  });
  it("Stop while Save is held aborts the request and requires reload even if the late reply says ready",async()=>{
    const c=client(),held=deferred();c.prepareDirectorySettings.mockResolvedValue(prepared(trust()));c.saveDirectorySettings.mockReturnValue(held.promise);
    const {p}=await mount(c);await changedTarget(p);await submit(p);await click(p,"Confirm fingerprints and save");await click(p,"Cancel");
    held.resolve({ok:true,state:"ready",directoryEpoch:1});await settle(20);expect(c.saveDirectorySettings.mock.calls[0][1].aborted).toBe(true);expect(p.root.querySelector("form")).toBeNull();expect(p.root.textContent).toContain("Save could not be confirmed");
  });
  it("admin reauthentication is inline and sent only with Save, never the candidate test",async()=>{
    const c=client({...initial(),reauthentication:"required"});const {p}=await mount(c,{host:false,login:"avery"});await authField(p,"current-password","Dummy-person-only");await fill(p,"baseDn","OU=People");await click(p,"Test connection");
    expect(c.testDirectorySettings.mock.calls[0][0]).toEqual({ref});await submit(p);expect(c.saveDirectorySettings.mock.calls[0][0]).toEqual({ref,credentials:{login:"avery",password:"Dummy-person-only"}});
    expect(p.root.querySelector('input[autocomplete="current-password"]').value).toBe("");
  });
  it("a genuine backpressure refusal uses plain busy wording",async()=>{
    const c=client();c.directorySettings.mockResolvedValue({ok:false,code:"backpressure"});const {p}=await mount(c);expect(p.root.textContent).toContain("Hub is busy");expect(p.root.textContent).not.toContain("could not be checked");
  });
  it("CA bootstrap sends no credentials before the leaf click and stays in one dialog through derived CA confirmation and Save",async()=>{
    const certs=directoryCertificates();try{
      const ca=new X509Certificate(certs.ca).fingerprint256.replace(/:/g,""),c=client();c.fetchDirectoryCa.mockResolvedValue({ok:true,server:"ldaps://new.example.test:636",leafFingerprint:leaf,caPem:certs.ca});
      c.prepareDirectorySettings.mockResolvedValue(prepared(trust({systemRoots:false,caFingerprints:[ca]})));const {p}=await mount(c);await changedTarget(p);await click(p,"Fetch CA and save…");
      const dialog=p.root.querySelector("dialog");expect(c.fetchDirectoryCa).not.toHaveBeenCalled();await click(p,"Fingerprint matches — fetch CA");
      expect(c.fetchDirectoryCa.mock.calls[0][0]).toEqual({ref:probeRef,fingerprint:leaf});expect(p.root.querySelector("dialog")).toBe(dialog);expect(p.root.textContent).toContain("CA fingerprint");expect(c.saveDirectorySettings).not.toHaveBeenCalled();
      await click(p,"Confirm fingerprints and save");expect(c.saveDirectorySettings.mock.calls[0][0]).toEqual({ref,confirmation:challenge});
    }finally{certs.cleanup();}
  });
  it("Stop while CA preparation is held permanently fences the late draft",async()=>{
    const certs=directoryCertificates();try{
      const ca=new X509Certificate(certs.ca).fingerprint256.replace(/:/g,""),c=client(),held=deferred();
      c.fetchDirectoryCa.mockResolvedValue({ok:true,server:"ldaps://new.example.test:636",leafFingerprint:leaf,caPem:certs.ca});c.prepareDirectorySettings.mockReturnValue(held.promise);
      const {p}=await mount(c);await changedTarget(p);await click(p,"Fetch CA and save…");await click(p,"Fingerprint matches — fetch CA");
      expect(c.prepareDirectorySettings).toHaveBeenCalledOnce();await click(p,"Cancel");held.resolve(prepared(trust({systemRoots:false,caFingerprints:[ca]})));await settle(25);
      expect(c.cancelDirectorySettings).toHaveBeenCalledWith({ref});expect(p.root.querySelector("dialog")).toBeNull();expect(c.saveDirectorySettings).not.toHaveBeenCalled();
    }finally{certs.cleanup();}
  });
  it("a changed leaf before credentialed CA retry visibly stops before any service password is sent",async()=>{
    const c=client();c.fetchDirectoryCa.mockResolvedValue({ok:false,code:"ca-auth-required"});const {p}=await mount(c);await changedTarget(p);await click(p,"Fetch CA and save…");await click(p,"Fingerprint matches — fetch CA");
    c.inspectDirectoryCa.mockResolvedValue({ok:true,ref:probeRef,server:"ldaps://new.example.test:636",certificate:{fingerprint256:"B2".repeat(32)}});await click(p,"Use service account and fetch CA");
    expect(c.fetchDirectoryCa).toHaveBeenCalledOnce();expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(p.root.textContent).toContain("certificate changed");
  });
  it.each(["bundle-leaf", "prepared-leaf", "prepared-ca"])("CA bootstrap refuses a mismatched %s before Save",async fault=>{
    const certs=directoryCertificates();try{
      const ca=new X509Certificate(certs.ca).fingerprint256.replace(/:/g,""),c=client();
      c.fetchDirectoryCa.mockResolvedValue({ok:true,server:"ldaps://new.example.test:636",leafFingerprint:fault==="bundle-leaf"?"B2".repeat(32):leaf,caPem:certs.ca});
      c.prepareDirectorySettings.mockResolvedValue(prepared(trust({systemRoots:false,leafFingerprint:fault==="prepared-leaf"?"B2".repeat(32):leaf,caFingerprints:[fault==="prepared-ca"?"C3".repeat(32):ca]})));
      const {p}=await mount(c);await changedTarget(p);await click(p,"Fetch CA and save…");await click(p,"Fingerprint matches — fetch CA");
      expect(c.saveDirectorySettings).not.toHaveBeenCalled();expect(p.root.querySelector("dialog")).toBeNull();expect(p.root.textContent).toContain("certificate changed");
    }finally{certs.cleanup();}
  });
  it("host adapter is absent on a retained, public or Hub shell",()=>{
    for(const dataset of [{},{hubDirectorySettings:"1",publicLink:"1"},{hubDirectorySettings:"1",hub:"hub"}])expect(host.hubDirectoryMarked({body:{dataset}})).toBe(false);
    expect(host.hubDirectoryMarked({body:{dataset:{hubDirectorySettings:"1"}}})).toBe(true);
  });

});
