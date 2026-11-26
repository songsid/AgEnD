import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
import {builtinRoles,ROLE_PERMISSIONS,MANAGEMENT_PERMISSIONS} from "../src/hub/roles/model.js";
const actor={realm:"corp",objectId:"00000000-0000-4000-8000-000000000000"};
let ui:any,words:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();ui=await import("/ui/js/hub-roles.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const button=(root:any,text:string)=>[...root.querySelectorAll("button")].find((b:any)=>b.textContent===text);
const view=()=>({policy:{realm:"corp",generation:"g1",revision:1,rolesActive:true,state:"enabled",everEnabled:true,roles:builtinRoles(),assignments:[],denies:[]},permissions:ROLE_PERMISSIONS,root:actor,actor,management:MANAGEMENT_PERMISSIONS,personLabels:[{id:`${actor.realm}/${actor.objectId}`,name:"Avery Chen"}],rootSelfUsed:false});
async function mount(lang="en",overrides:any={}){
 const p=page({url:"http://127.0.0.1/ui/hub/admin?view=roles",storage:{agend_lang:lang}});pages.push(p);words.setLang(lang,{store:false});const ends=new Set<()=>void>();
 const client={roleAuditFiltersV1:true,roles:vi.fn(async()=>({ok:true,view:view()})),roleAudit:vi.fn(async()=>({ok:true,rows:[],nextCursor:null})),rolePreview:vi.fn(async()=>({ok:true,previewDigest:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",impact:{losingActions:[],suspendedOnSave:[],held:[]}})),roleApply:vi.fn(async()=>({ok:true})),roleRootPreview:vi.fn(async()=>({ok:true,previewDigest:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",impact:{}})),roleRootApply:vi.fn(async()=>({ok:true})),roleSearch:vi.fn(async()=>({ok:true,candidates:[]})),roleNotices:vi.fn(async()=>({ok:true,notices:[]})),onSignedOut:(fn:()=>void)=>{ends.add(fn);return()=>ends.delete(fn);},...overrides};
 await p.mount(h(ui.HubRoles,{client}));await settle(15);const link=p.document.querySelector('[data-hub-roles-css="1"]');expect(link).toBeTruthy();expect(p.root.querySelector("select")).toBeNull();fire(link!,"load");await settle(15);return{p,client,end:()=>{for(const fn of ends)fn();}};
}
const click=async(root:any,text:string)=>{const el=button(root,text);expect(el,`button ${text}`).toBeTruthy();fire(el,"click");await settle(10);};
async function newRole(p:AppPage,name="Helpers"){
 await click(p.root,"Create new role");const form=p.root.querySelector(".hub-role-info")!,input=form.querySelector('input[maxlength="120"]')!;input.value=name;fire(input,"input");await settle(5);return form;
}
it.each(["en","zh-TW"])("opens built-in role details, keeps all13 permissions readable and exposes no Administrator editor (%s)",async lang=>{
 const {p}=await mount(lang);expect(p.root.querySelector(".hub-role-list")!.querySelectorAll("tbody tr")).toHaveLength(3);
 expect(button(p.root,lang==="en"?"Edit":"編輯")).toBeUndefined();
 await click(p.root,lang==="en"?"Administrator":"管理員");
 const permissionTab=[...p.root.querySelectorAll('button[role="tab"]')].find((el:any)=>el.textContent.startsWith(lang==="en"?"Permissions":"權限"));fire(permissionTab!,"click");await settle(10);
 expect(p.root.querySelectorAll(".hub-role-permission-mark")).toHaveLength(11);expect(p.root.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
 expect(p.root.textContent).toContain(lang==="en"?"Not available yet (2)":"尚未開放（2）");expect(button(p.root,lang==="en"?"Edit permissions":"編輯權限")).toBeUndefined();
 expect(p.root.textContent).toContain(lang==="en"?"Creating rooms is granted separately":"開房間權限另外授予");
});
it("keeps the three-step custom edit local and saves only its checked policy/digest",async()=>{
 const {p,client}=await mount(),form=await newRole(p);const description=form.querySelector('input[maxlength="500"]')!;description.value="Help colleagues";fire(description,"input");
 const template=form.querySelector("select")!;template.value="builtin:member";fire(template,"change");await settle(10);fire(form,"submit");await settle(10);
 expect(p.root.querySelectorAll('input[type="checkbox"]')).toHaveLength(10);expect([...p.root.querySelectorAll('input[type="checkbox"]')].filter((el:any)=>el.checked)).toHaveLength(3);
 expect([...p.root.querySelectorAll('input[type="checkbox"]')].every((el:any)=>!el.disabled)).toBe(true);expect(client.rolePreview).not.toHaveBeenCalled();
 await click(p.root,"Review");expect(client.roleApply).not.toHaveBeenCalled();expect(client.rolePreview).toHaveBeenCalledTimes(1);const proposed=client.rolePreview.mock.calls[0][0];expect(proposed.roles).toHaveLength(4);expect(proposed.roles[3].name).toBe("Helpers");expect(proposed.roles[3].permissions).toEqual(["ask_agents","publish_agents","pair_fleet"]);
 await click(p.root,"Create role");expect(client.roleApply).toHaveBeenCalledWith(proposed,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});
it("an empty quota cannot silently become zero or advance the info step",async()=>{
 const {p,client}=await mount(),form=await newRole(p),input=form.querySelector('input[type="number"]')!;input.value="";fire(input,"input");await settle(5);
 expect(button(form,"Continue").disabled).toBe(true);fire(form,"submit");await settle(5);expect(p.root.querySelector(".hub-role-editor")).toBeNull();expect(client.rolePreview).not.toHaveBeenCalled();
});
it("management assignment cannot pick a group and root defaults use their dedicated checked operation",async()=>{
 const {p,client}=await mount();await click(p.root,"Assign");const panel=p.root.querySelector(".hub-role-panel")!,selects=panel.querySelectorAll("select");expect(selects[1]!.querySelectorAll("option")[1]!.disabled).toBe(true);expect(panel.textContent).toContain("people only");
 await click(panel,"Cancel");await click(p.root,"Apply new defaults for myself");await click(p.root,"Save changes");expect(client.roleRootApply).toHaveBeenCalledWith("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");expect(client.roleApply).not.toHaveBeenCalled();
});
it("drops a held settings preview after sign-out and never offers its Save",async()=>{
 let release!:(value:any)=>void;const {p,client,end}=await mount("en",{rolePreview:vi.fn(()=>new Promise(resolve=>release=resolve))});await click(p.root,"Roles settings");await click(p.root,"Turn roles off");end();release({ok:true,previewDigest:"x",impact:{}});await settle(15);expect(button(p.root,"Save changes")).toBeUndefined();expect(client.roleApply).not.toHaveBeenCalled();
});
it("edits an existing assignment atomically while preserving identity and server stamps",async()=>{
 const current=view(),target={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"};current.personLabels.push({id:`${target.realm}/${target.objectId}`,name:"Alex Chen"});
 current.policy.assignments=[{id:"existing",roleId:current.policy.roles[2]!.id,subject:{kind:"person",person:target},scope:{kind:"hub"},maxFleets:2,startsAt:0,expiresAt:null,assignedBy:actor,assignedAt:42}]as any;
 const {p,client}=await mount("en",{roles:vi.fn(async()=>({ok:true,view:current}))});await click(p.root,"People");await click(p.root,"Alex Chen");await click(p.root,"Edit");
 const panel=p.root.querySelector(".hub-role-panel")!,expiry=panel.querySelectorAll('input[type="datetime-local"]')[1]!;expiry.value="2027-01-02T10:30";fire(expiry,"input");await settle(5);await click(panel,"Review");
 const proposed=client.rolePreview.mock.calls[0][0];expect(proposed.assignments).toHaveLength(1);expect(proposed.assignments[0]).toMatchObject({id:"existing",assignedBy:actor,assignedAt:42,maxFleets:2});expect(proposed.assignments[0].expiresAt).toBe(new Date("2027-01-02T10:30").getTime());expect(client.roleApply).not.toHaveBeenCalled();
});
it.each(["en","zh-TW"])("keeps built-in renames and system-generated own-access labels (%s)",async lang=>{
 const current=view();current.policy.roles[1]!.name="Release leads";current.policy.roles.push({id:`root-self:${actor.objectId}`,kind:"custom",name:"Root self-use",permissions:["ask_agents"],defaultMaxFleets:8});const {p}=await mount(lang,{roles:vi.fn(async()=>({ok:true,view:current}))});expect(p.root.textContent).toContain("Release leads");expect(p.root.textContent).toContain(lang==="en"?"First administrator’s own access":"第一位管理員的個人使用權限");expect(p.root.textContent).not.toContain("Root self-use");
});
it("a failed save reports a save failure while keeping the draft available to review again",async()=>{
 const {p}=await mount("en",{roleApply:vi.fn(async()=>({ok:false,code:"unavailable"}))}),form=await newRole(p);fire(form,"submit");await settle(10);await click(p.root,"Review");await click(p.root,"Create role");expect(p.root.querySelector('[role="alert"]')!.textContent).toBe("The changes were not saved. Try again.");expect(p.root.textContent).not.toContain("Roles could not be loaded");expect(button(p.root,"Review")).toBeTruthy();
});
it("adds multiple people through the shared picker and names the checked batch",async()=>{
 const one={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"},two={realm:"corp",objectId:"22222222-2222-4222-8222-222222222222"};
 const {p,client}=await mount("en",{roleSearch:vi.fn(async(_kind:string,q:string)=>({ok:true,candidates:[{kind:"person",key:q==="Alex"?one:two,name:q==="Alex"?"Alex Chen":"Jo Lin",login:q.toLowerCase()}]}))});await click(p.root,"Assign");const panel=p.root.querySelector(".hub-role-panel")!;
 for(const text of ["Alex","Jo"]){const input=panel.querySelector('input[type="search"]')!;input.value=text;fire(input,"input");await vi.waitFor(()=>expect([...panel.querySelectorAll("button")].some((b:any)=>b.getAttribute("aria-label")===`Choose ${text==="Alex"?"Alex Chen":"Jo Lin"}`)).toBe(true));await click(panel,"Choose");}
 expect(panel.querySelectorAll(".hub-role-selected .tag")).toHaveLength(2);await click(panel,"Review");expect(client.rolePreview.mock.calls[0][0].assignments.map((a:any)=>a.subject.person)).toEqual([one,two]);expect(panel.textContent).toContain("Administrator to Alex Chen");expect(panel.textContent).toContain("Administrator to Jo Lin");
});

it("describes a non-zero named impact instead of showing Nobody loses access",async()=>{
 const target={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"};
 const {p,client}=await mount("en",{rolePreview:vi.fn(async()=>({ok:true,previewDigest:"named-preview",impact:{},review:{losingPermissions:[{person:target,name:"Alex Chen",permissions:["team.view"]}],unverified:[]}}))});
 await click(p.root,"Manager");const tab=[...p.root.querySelectorAll('button[role="tab"]')].find((el:any)=>el.textContent.startsWith("Permissions"))!;fire(tab,"click");await settle(10);await click(p.root,"Edit permissions");fire(p.root.querySelector(".hub-role-info")!,"submit");await settle(10);
 const label=[...p.root.querySelectorAll(".hub-role-permission")].find((el:any)=>el.querySelector("strong")?.textContent==="View team roster")!,checkbox=label.querySelector("input")!;checkbox.checked=false;fire(checkbox,"change");await settle(5);await click(p.root,"Review");
 const review=p.root.querySelector("[data-role-review]")!;expect(review.textContent).toContain("Alex Chen");expect(review.textContent).toContain("View team roster");expect(review.textContent).toContain("1 person loses");expect(review.textContent).not.toContain("Nobody loses access");expect(client.roleApply).not.toHaveBeenCalled();
});
it("keeps metadata-only named audit rows and sends the selected filters to the server",async()=>{
 const {p,client}=await mount("en",{roleAudit:vi.fn(async()=>({ok:true,rows:[{id:"audit",at:100,actor:{id:"corp/alex",name:"Alex Chen"},action:"role.changed",result:"completed",details:{kind:"role",before:{roleName:"Manager",roleKind:"manager",permissions:["ask_agents"]},after:{roleName:"Support leads",roleKind:"manager",permissions:["ask_agents","audit.view"]}}}],nextCursor:null}))});
 await click(p.root,"Audit log");expect(p.root.textContent).toContain("Changed the role “Support leads”");expect(p.root.textContent).not.toContain("role.policy-changed");expect(p.root.textContent).not.toContain("builtin:");
 const filters=p.root.querySelector(".hub-role-audit-filters")!,action=filters.querySelectorAll("select")[1]!;action.value="role.changed";fire(action,"change");await settle(5);fire(filters,"submit");await settle(10);expect(client.roleAudit).toHaveBeenLastCalledWith(null,{action:"role.changed"});
});

it("keeps the original AD group realm/key when the shared picker normalizes a batch selection",async()=>{
 const group={kind:"group",key:{realm:"corp",objectId:"33333333-3333-4333-8333-333333333333"},name:"Product leads",dn:"CN=Product leads,DC=test"};
 const {p,client}=await mount("en",{roleSearch:vi.fn(async()=>({ok:true,candidates:[group]}))});await click(p.root,"Assign");const panel=p.root.querySelector(".hub-role-panel")!,selects=panel.querySelectorAll("select");selects[0]!.value="builtin:member";fire(selects[0]!,"change");await settle(10);selects[1]!.value="group";fire(selects[1]!,"change");await settle(10);
 const input=panel.querySelector('input[type="search"]')!;input.value="Product";fire(input,"input");await vi.waitFor(()=>expect(button(panel,"Add")).toBeTruthy());await click(panel,"Add");await click(panel,"Review");expect(client.rolePreview.mock.calls[0][0].assignments[0].subject).toEqual({kind:"group",group:group.key,dn:group.dn});
});
it("shows the specific last-administrator refusal in Roles settings",async()=>{
 const {p}=await mount("en",{rolePreview:vi.fn(async()=>({ok:false,code:"last-administrator"}))});await click(p.root,"Roles settings");await click(p.root,"Turn roles off");expect(p.root.querySelector('[role="alert"]')!.textContent).toContain("Keep at least one verified administrator");expect(button(p.root,"Save changes")).toBeUndefined();
});

it("a retained older client cannot silently ignore audit filters or export an unfiltered file",async()=>{
 const {p,client}=await mount("en",{roleAuditFiltersV1:false});await click(p.root,"Audit log");expect(p.root.querySelector(".hub-role-audit-filters")).toBeNull();expect(button(p.root,"Export CSV").disabled).toBe(true);expect(p.root.textContent).toContain("Refresh this page for filters and CSV export");expect(client.roleAudit).toHaveBeenCalledWith(null,{});
});

it("shows permission disclosure cues and uses a recipient label in the zh-TW assignment drawer",async()=>{
 const {p}=await mount("zh-TW");await click(p.root,"主管");const tab=[...p.root.querySelectorAll('button[role="tab"]')].find((el:any)=>el.textContent.startsWith("權限"))!;fire(tab,"click");await settle(10);expect(p.root.querySelectorAll(".hub-role-disclosure")).toHaveLength(3);
 await click(p.root,"‹ 角色");await click(p.root,"指派");const panel=p.root.querySelector(".hub-role-panel")!;expect(panel.textContent).toContain("指派對象");expect(panel.textContent).not.toContain("操作者");
});

it("supports arrow and Home navigation between the Roles, People and Audit tabs",async()=>{
 const {p}=await mount();const roles=p.root.querySelector('.hub-role-top [role="tab"]')!;fire(roles,"keydown",{key:"ArrowRight"});await settle(10);expect(p.root.querySelector(".hub-role-people")).toBeTruthy();
 const people=[...p.root.querySelectorAll('.hub-role-top [role="tab"]')].find((el:any)=>el.getAttribute("aria-selected")==="true")!;fire(people,"keydown",{key:"Home"});await settle(10);expect(p.root.querySelector(".hub-role-list")).toBeTruthy();
});

it("does not call audit for a limited Fleet manager without role or audit permission",async()=>{
 const current={...view(),policy:null,management:["fleets.manage"]};const {p,client}=await mount("en",{roles:vi.fn(async()=>({ok:true,view:current}))});expect(client.roleAudit).not.toHaveBeenCalled();expect(p.root.textContent).toContain("Your role does not allow editing or assigning roles");expect(button(p.root,"Roles settings")).toBeUndefined();
});

it("can select a role action filter even when that event is absent from the loaded page",async()=>{
 const {p,client}=await mount();await click(p.root,"Audit log");const form=p.root.querySelector(".hub-role-audit-filters")!,action=form.querySelectorAll("select")[1]!;expect([...action.querySelectorAll("option")].some((el:any)=>el.value==="role.assigned")).toBe(true);action.value="role.assigned";fire(action,"change");await settle(5);fire(form,"submit");await settle(10);expect(client.roleAudit).toHaveBeenLastCalledWith(null,{action:"role.assigned"});
});
it.each(["en","zh-TW"])("labels an unknown legacy audit actor without exposing raw actor JSON (%s)",async lang=>{
 const {p}=await mount(lang,{roleAudit:vi.fn(async()=>({ok:true,rows:[{id:"row",at:100,actor:{id:"unknown",name:""},action:"fixture.legacy",result:"completed",summary:[]}],nextCursor:null}))});
 await click(p.root,lang==="en"?"Audit log":"稽核紀錄");
 expect(p.root.textContent).toContain(lang==="en"?"Unknown actor":"未知操作者");
});

it.each(["en","zh-TW"])("shows cached person names and localized change/audit copy (%s)",async lang=>{
 const current={...view(),personLabels:[{id:`${actor.realm}/${actor.objectId}`,name:"Avery Chen"}]};
 const {p}=await mount(lang,{roles:vi.fn(async()=>({ok:true,view:current})),roleAudit:vi.fn(async()=>({ok:true,rows:[{id:"created",at:100,actor:{id:"root",name:"Avery Chen"},action:"role.created",result:"completed",summary:[],details:{kind:"role",before:null,after:{roleName:"Helpers",roleKind:"custom",permissions:["ask_agents"]}}}],nextCursor:null}))});
 await click(p.root,lang==="en"?"Audit log":"稽核紀錄");
 expect(p.root.textContent).toContain("Avery Chen");expect(p.root.textContent).toContain(lang==="en"?"Created the role “Helpers”":"建立角色「Helpers」");expect(p.root.querySelector(".hub-role-audit-values").textContent).toContain(lang==="en"?"HelpersChat with agents":"Helpers和 Agent 對話");
 await click(p.root,lang==="en"?"Roles settings":"角色設定");
 fire(button(p.root,lang==="en"?"Turn roles off":"關閉角色功能"),"click");await settle(10);
 expect(p.root.querySelector("[data-role-review]").textContent).toContain(lang==="en"?"Turn roles off":"關閉角色功能");
});

it("carries a newly selected person's display name into the checked change summary",async()=>{
 const target={realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"};
 const {p}=await mount("en",{roleSearch:vi.fn(async()=>({ok:true,candidates:[{kind:"person",key:target,name:"Alex Chen",login:"alex"}]}))});
 await click(p.root,"Assign");const form=p.root.querySelector(".hub-role-panel"),input=form.querySelector('input[type="search"]');input.value="Al";fire(input,"input");
 await vi.waitFor(()=>expect(button(form,"Choose")).toBeTruthy());await click(form,"Choose");await click(form,"Review");
 expect(p.root.querySelector("[data-role-review]").textContent).toContain("You are giving Administrator to Alex Chen.");
});
