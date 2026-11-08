import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendHubWebInitEvent, readHubWebInitEvents, WEB_INIT_AUDIT } from "../src/hub/init/web-audit.js";
import { HUB_WEB_INIT_AUDIT_MIGRATION, importHubWebInitAudit } from "../src/hub/init/web-audit-import.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { tempDir } from "./support/hub-init-fixtures.js";
const homes:string[]=[];afterEach(()=>{for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});vi.restoreAllMocks();});
function fixture(){const home=tempDir("web-audit-");homes.push(home);const db=new Database(":memory:");
  applyHubMigrations(db,[HUB_AUDIT_MIGRATION,HUB_WEB_INIT_AUDIT_MIGRATION]);const audit=createHubAudit({db,contentKey:randomBytes(32)});
  return {home,db,audit,put:(reason="ready")=>appendHubWebInitEvent(home,{at:1000,requestId:"request-1",sessionId:"host-session",authorityEpoch:2,operation:"prepare",result:"completed",reason}),
    load:()=>importHubWebInitAudit({home,db,audit,hubId:"hub-1",version:0})};}
describe("initial setup audit transfer",()=>{
  it("imports once, verifies the real audit chain, and does not replay retained bootstrap evidence",()=>{
    const r=fixture();try{r.put();r.put("checking");r.load();r.load();expect(r.db.prepare("SELECT * FROM hub_audit").all()).toHaveLength(2);
      expect(r.audit.verifyChain()).toEqual({ok:true,checked:2});expect(r.db.prepare("SELECT * FROM hub_web_initialization_audit").all()).toHaveLength(2);
      expect(r.db.prepare("SELECT actor,action FROM hub_audit LIMIT 1").get()).toEqual({actor:'{"kind":"local-host"}',action:"hub-initialization.prepare"});
      // Audit retention may remove event rows; import ownership remains durable separately.
      r.db.exec("DELETE FROM hub_audit");r.load();expect(r.db.prepare("SELECT * FROM hub_audit").all()).toHaveLength(0);
    }finally{r.db.close();}
  });
  it("rolls back every imported event and marker if a required append fails, then retries",()=>{
    const r=fixture();try{r.put();r.put("checking");const original=r.audit.appendInTransaction;let n=0;
      vi.spyOn(r.audit,"appendInTransaction").mockImplementation((record,db)=>{original(record,db);if(++n===2)throw Error("injected audit failure");});
      expect(r.load).toThrow("injected");expect(r.db.prepare("SELECT * FROM hub_audit").all()).toHaveLength(0);
      expect(r.db.prepare("SELECT * FROM hub_web_initialization_audit").all()).toHaveLength(0);
      vi.restoreAllMocks();r.load();expect(r.audit.verifyChain()).toEqual({ok:true,checked:2});
    }finally{r.db.close();}
  });
  it("refuses changed evidence, a torn tail, secret-bearing unknown fields and another Hub before importing anything",()=>{
    const r=fixture();try{r.put();r.load();const p=join(r.home,WEB_INIT_AUDIT),saved=readFileSync(p,"utf8");
      const event=JSON.parse(saved);event.reason="changed";writeFileSync(p,JSON.stringify(event)+"\n");expect(r.load).toThrow("mismatch");
      writeFileSync(p,saved.slice(0,-1));expect(r.load).toThrow("unavailable");
      writeFileSync(p,saved);appendFileSync(p,JSON.stringify({...event,id:"11111111-1111-4111-8111-111111111111",password:"forbidden"})+"\n");expect(r.load).toThrow();
      writeFileSync(p,JSON.stringify({...event,hubId:"other-hub"})+"\n");expect(r.load).toThrow("mismatch");
      expect(r.db.prepare("SELECT * FROM hub_audit").all()).toHaveLength(1);
    }finally{r.db.close();}
  });
  it("has no requirement on a legacy CLI initialization without a browser journal",()=>{
    const r=fixture();try{expect(r.load).not.toThrow();expect(r.db.prepare("SELECT * FROM hub_audit").all()).toHaveLength(0);}finally{r.db.close();}
  });
  it("refuses unsafe journal ownership and never follows a symlink",()=>{
    const r=fixture();try{r.put();const p=join(r.home,WEB_INIT_AUDIT);chmodSync(p,0o644);expect(()=>readHubWebInitEvents(r.home)).toThrow();
      expect(()=>r.put()).toThrow();chmodSync(p,0o600);const outside=join(r.home,"keep");writeFileSync(outside,"keep",{mode:0o600});rmSync(p);symlinkSync(outside,p);
      expect(()=>r.put()).toThrow();expect(readFileSync(outside,"utf8")).toBe("keep");
    }finally{r.db.close();}
  });
});
