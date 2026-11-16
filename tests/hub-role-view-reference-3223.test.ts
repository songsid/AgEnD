import {beforeAll,expect,it} from "vitest";
import {page} from "./helpers/app-harness.js";
let display:any,words:any;
beforeAll(async()=>{const p=page();display=await import("/ui/js/hub-role-view.js");words=await import("/assets/app-i18n.js");p.restore();});
it.each(["en","zh-TW"])("writes audit sentences and old/new role names without internal IDs (%s)",lang=>{
 words.setLang(lang,{store:false});const row={at:100,actor:{id:"unknown",name:""},action:"role.assigned",result:"allowed",details:{kind:"assignment",before:null,after:{roleName:"Administrator",roleKind:"admin",subject:{kind:"person",name:"Alex Chen"},scope:{kind:"hub"}}}};
 expect(display.auditSentence(row)).toBe(lang==="en"?"Gave Administrator to Alex Chen · Whole Hub":"將「管理員」指派給 Alex Chen · 整個 Hub");expect(display.auditActor(row)).toBe(lang==="en"?"Unknown actor":"未知操作者");expect(display.auditResult(row.result)).toBe(lang==="en"?"Done":"完成");
 expect(display.auditSentence({action:"role.policy-changed"})).toBe(lang==="en"?"Updated roles and permissions":"更新角色與權限");
});
it("exports only action fields and prevents spreadsheet formula names",()=>{
 words.setLang("en",{store:false});const csv=display.auditCsv([{at:100,actor:{id:"person",name:"=1+1"},action:"role.changed",result:"completed",question:"PRIVATE QUESTION",contentRef:"PRIVATE REF",details:{kind:"role",before:{roleName:"Manager",roleKind:"manager",permissions:[]},after:{roleName:"Leads",roleKind:"manager",description:"Works with partners",permissions:["audit.view"]}}}]);
 expect(csv).toContain('"\'=1+1"');expect(csv).toContain("Works with partners");expect(csv).not.toContain("PRIVATE");expect(csv).not.toContain("builtin:");expect(csv).toContain("Before");expect(csv).toContain("After");
});
it("keeps unknown membership out of a no-loss review",()=>{
 words.setLang("en",{store:false});const person={realm:"corp",objectId:"p"};const impact=display.reviewImpact({impact:{held:[]},review:{losingPermissions:[],unverified:[{person,name:"Alex"}]}},{personLabels:[]});expect(impact.unknown).toEqual([{name:"Alex"}]);expect(impact.lost).toEqual([]);
});
