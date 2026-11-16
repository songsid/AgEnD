import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
import {builtinRoles,ROLE_PERMISSIONS,MANAGEMENT_PERMISSIONS} from "../src/hub/roles/model.js";
const actor={realm:"corp",objectId:"00000000-0000-4000-8000-000000000000"};
let ui:any,words:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();ui=await import("/ui/js/hub-roles.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const button=(root:any,text:string)=>[...root.querySelectorAll("button")].find((b:any)=>b.textContent===text);
const view=()=>({policy:{realm:"corp",generation:"g1",revision:1,rolesActive:true,state:"enabled",everEnabled:true,roles:builtinRoles(),assignments:[],denies:[]},permissions:ROLE_PERMISSIONS,root:actor,actor,management:MANAGEMENT_PERMISSIONS,rootSelfUsed:false});
async function mount(lang="en",overrides:any={}){
 const p=page({url:"http://127.0.0.1/ui/hub/admin?view=roles",storage:{agend_lang:lang}});pages.push(p);words.setLang(lang,{store:false});const ends=new Set<()=>void>();
 const client={roles:vi.fn(async()=>({ok:true,view:view()})),roleAudit:vi.fn(async()=>({ok:true,rows:[],nextCursor:null})),rolePreview:vi.fn(async()=>({ok:true,previewDigest:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",impact:{losingActions:[],suspendedOnSave:[],held:[]}})),roleApply:vi.fn(async()=>({ok:true})),roleRootPreview:vi.fn(async()=>({ok:true,previewDigest:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",impact:{}})),roleRootApply:vi.fn(async()=>({ok:true})),roleSearch:vi.fn(async()=>({ok:true,candidates:[]})),roleNotices:vi.fn(async()=>({ok:true,notices:[]})),onSignedOut:(fn:()=>void)=>{ends.add(fn);return()=>ends.delete(fn);},...overrides};
 await p.mount(h(ui.HubRoles,{client}));await settle(15);const link=p.document.querySelector('[data-hub-roles-css="1"]');expect(link).toBeTruthy();expect(p.root.querySelector("select")).toBeNull();fire(link!,"load");await settle(15);return{p,client,end:()=>{for(const fn of ends)fn();}};
}
it.each(["en","zh-TW"])("shows three built-ins and all twelve permissions with approval bits unavailable (%s)",async lang=>{
 const {p}=await mount(lang);const list=p.root.querySelector(".hub-role-list");expect(list.querySelectorAll("li")).toHaveLength(3);
 fire(button(list,lang==="en"?"Edit":"編輯"),"click");await settle(10);
 expect(p.root.querySelectorAll('fieldset input[type="checkbox"]')).toHaveLength(12);
 expect([...p.root.querySelectorAll('fieldset input[type="checkbox"]')].every((el:any)=>el.disabled)).toBe(true);
 expect(p.root.textContent).toContain(lang==="en"?"Coming later":"之後推出");
 expect(p.root.textContent).toContain(lang==="en"?"First administrator":"第一位管理員");
});
it("keeps custom-role edits local until preview and saves only its checked policy/digest",async()=>{
 const {p,client}=await mount();fire(button(p.root,"New role"),"click");await settle(10);
 const form=p.root.querySelector(".hub-role-editor"),input=form.querySelector('input[maxlength="100"]');input.value="Helpers";fire(input,"input");await settle(5);
 fire(form,"submit");await settle(15);expect(client.roleApply).not.toHaveBeenCalled();expect(client.rolePreview).toHaveBeenCalledTimes(1);
 const proposed=client.rolePreview.mock.calls[0][0];expect(proposed.roles).toHaveLength(4);expect(proposed.roles[3].name).toBe("Helpers");
 fire(button(p.root,"Save checked changes"),"click");await settle(15);expect(client.roleApply).toHaveBeenCalledWith(proposed,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});
it("empty quota text cannot silently become zero",async()=>{
 const {p,client}=await mount();fire(button(p.root,"New role"),"click");await settle(10);const form=p.root.querySelector(".hub-role-editor"),name=form.querySelector('input[maxlength="100"]');name.value="Name";fire(name,"input");const quota=form.querySelector('input[type="number"]');quota.value="";fire(quota,"input");await settle(10);expect(button(form,"Check changes").disabled).toBe(true);fire(form,"submit");await settle(5);expect(client.rolePreview).not.toHaveBeenCalled();
});
it("management roles cannot select an AD group, and a root-default check cannot call ordinary apply",async()=>{
 const {p,client}=await mount();fire(button(p.root,"Assign role"),"click");await settle(10);const form=p.root.querySelector(".hub-role-assignment");expect(form.querySelectorAll("select")[1].querySelectorAll("option")[1].disabled).toBe(true);expect(p.root.textContent).toContain("people only");
 fire(button(p.root,"Apply new defaults for myself"),"click");await settle(10);fire(button(p.root,"Save checked changes"),"click");await settle(10);expect(client.roleRootApply).toHaveBeenCalledWith("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");expect(client.roleApply).not.toHaveBeenCalled();
});
it("drops a held preview after sign-out and never offers its Save",async()=>{
 let release!:(value:any)=>void;const {p,client,end}=await mount("en",{rolePreview:vi.fn(()=>new Promise(resolve=>release=resolve))});fire(button(p.root,"Turn roles off"),"click");await settle(10);end();release({ok:true,previewDigest:"x",impact:{}});await settle(15);expect(button(p.root,"Save checked changes")).toBeUndefined();expect(client.roleApply).not.toHaveBeenCalled();
});

it("edits an existing assignment atomically while preserving its identity and server stamps",async()=>{
 const current=view(),target={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"};
 current.policy.assignments=[{id:"existing",roleId:current.policy.roles[2].id,subject:{kind:"person",person:target},scope:{kind:"hub"},maxFleets:2,startsAt:0,expiresAt:null,assignedBy:actor,assignedAt:42}] as any;
 const {p,client}=await mount("en",{roles:vi.fn(async()=>({ok:true,view:current}))});
 const section=[...p.root.querySelectorAll("section")].find((el:any)=>el.querySelector("h3")?.textContent==="Assignments");fire(button(section,"Edit"),"click");await settle(10);
 const form=p.root.querySelector(".hub-role-assignment"),expiry=form.querySelectorAll('input[type="datetime-local"]')[1];expiry.value="2027-01-02T10:30";fire(expiry,"input");await settle(5);fire(form,"submit");await settle(10);
 expect(client.rolePreview).toHaveBeenCalledTimes(1);const proposed=client.rolePreview.mock.calls[0][0];expect(proposed.assignments).toHaveLength(1);expect(proposed.assignments[0]).toMatchObject({id:"existing",assignedBy:actor,assignedAt:42,maxFleets:2});expect(proposed.assignments[0].expiresAt).toBe(new Date("2027-01-02T10:30").getTime());expect(client.roleApply).not.toHaveBeenCalled();
});

it.each(["en","zh-TW"])("groups custom permissions without changing locked and forthcoming controls (%s)",async lang=>{
 const {p}=await mount(lang);fire(button(p.root,lang==="en"?"New role":"新增角色"),"click");await settle(10);
 const form=p.root.querySelector(".hub-role-editor"),groups=[...form.querySelectorAll("fieldset")];
 expect(button(form,lang==="en"?"Delete role":"刪除角色")).toBeUndefined();
 expect(form.querySelector("h3").textContent).toBe(lang==="en"?"New role":"新增角色");
 expect(groups.map((g:any)=>g.querySelectorAll('input[type="checkbox"]').length)).toEqual([3,4,5]);
 expect([...groups[0].querySelectorAll("input")].every((el:any)=>!el.disabled)).toBe(true);
 expect([...groups[1].querySelectorAll("input")].map((el:any)=>el.disabled)).toEqual([false,false,true,true]);
 expect([...groups[2].querySelectorAll("input")].map((el:any)=>el.disabled)).toEqual([false,false,false,false,true]);
});
it("uses the shared person picker, hides it after selection, and previews beside the initiating form",async()=>{
 const target={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"};
 const {p,client}=await mount("en",{roleSearch:vi.fn(async()=>({ok:true,candidates:[{kind:"person",key:target,name:"Alex Chen",login:"alex"}]}))});
 fire(button(p.root,"Assign role"),"click");await settle(10);const form=p.root.querySelector(".hub-role-assignment"),input=form.querySelector('input[type="search"]');input.value="Alex";fire(input,"input");
 await vi.waitFor(()=>expect(button(form,"Choose")).toBeTruthy());
 expect(client.roleSearch).toHaveBeenCalledWith("person","Alex");fire(button(form,"Choose"),"click");await settle(10);
 expect(form.querySelector('input[type="search"]')).toBeNull();expect(form.querySelector(".hub-role-selected").textContent).toContain("Alex Chen");
 fire(button(form,"Change"),"click");await settle(10);expect(form.querySelector('input[type="search"]')).toBeTruthy();
 const next=form.querySelector('input[type="search"]');next.value="Alex";fire(next,"input");await vi.waitFor(()=>expect(button(form,"Choose")).toBeTruthy());fire(button(form,"Choose"),"click");await settle(10);
 fire(form,"submit");await settle(10);
 expect(client.rolePreview.mock.calls[0][0].assignments[0].subject).toEqual({kind:"person",person:target});
 const siblings=[...form.parentNode.children];expect(siblings[siblings.indexOf(form)+1]?.className).toContain("hub-role-preview");expect(p.root.querySelectorAll(".hub-ov-card")).toHaveLength(3);expect(p.root.querySelector(".hub-role-preview").textContent).toContain("Assign Administrator to Alex Chen");expect(client.roleApply).not.toHaveBeenCalled();
});
it("keeps the original group key through the shared GroupSearch normalization",async()=>{
 const group={kind:"group",key:{realm:"corp",objectId:"22222222-2222-4222-8222-222222222222"},name:"Support",dn:"cn=support,dc=example,dc=test"};
 const {p,client}=await mount("en",{roleSearch:vi.fn(async()=>({ok:true,candidates:[group]}))});
 fire(button(p.root,"Assign role"),"click");await settle(10);const form=p.root.querySelector(".hub-role-assignment"),selects=form.querySelectorAll("select");selects[0].value="builtin:member";fire(selects[0],"change");await settle(10);selects[1].value="group";fire(selects[1],"change");await settle(10);
 const input=form.querySelector('input[type="search"]');input.value="Support";fire(input,"input");await vi.waitFor(()=>expect(button(form,"Add")).toBeTruthy());fire(button(form,"Add"),"click");await settle(10);fire(form,"submit");await settle(10);
 expect(client.rolePreview.mock.calls[0][0].assignments[0].subject).toEqual({kind:"group",group:group.key,dn:group.dn});expect(form.querySelector('input[type="search"]')).toBeNull();
});

it.each(["en","zh-TW"])("labels an unknown legacy audit actor without exposing raw actor JSON (%s)",async lang=>{
 const {p}=await mount(lang,{roleAudit:vi.fn(async()=>({ok:true,rows:[{id:"row",at:100,actor:{id:"unknown",name:""},action:"fixture.legacy",result:"completed",summary:[]}],nextCursor:null}))});
 expect(p.root.textContent).toContain(lang==="en"?"Unknown actor":"未知操作者");
});

it.each(["en","zh-TW"])("shows cached person names and localized change/audit copy (%s)",async lang=>{
 const current={...view(),personLabels:[{id:`${actor.realm}/${actor.objectId}`,name:"Avery Chen"}]};
 const {p}=await mount(lang,{roles:vi.fn(async()=>({ok:true,view:current})),roleAudit:vi.fn(async()=>({ok:true,rows:[{id:"created",at:100,actor:{id:"root",name:"Avery Chen"},action:"role.created",result:"completed",summary:["after: Helpers · ask_agents"]}],nextCursor:null}))});
 expect(p.root.textContent).toContain("Avery Chen");expect(p.root.textContent).toContain(lang==="en"?"Role created":"新增角色");expect(p.root.textContent).toContain(lang==="en"?"After: Helpers · Chat with agents":"變更後: Helpers · 和 Agent 對話");
 fire(button(p.root,lang==="en"?"Turn roles off":"關閉角色功能"),"click");await settle(10);
 expect(p.root.querySelector(".hub-role-preview").textContent).toContain(lang==="en"?"Turn roles off":"關閉角色功能");
});
