import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HUB_PERSONAL_AGENTS_MIGRATION } from "../src/hub/personal/schema.js";
import { exposureOf, readExposure } from "../src/hub/catalog.js";
import { exposureSchema } from "../src/hub/protocol.js";
const legacyRegistry=HUB_HTTP_MIGRATIONS.filter(m=>m.component!==HUB_PERSONAL_AGENTS_MIGRATION.component);
const registry=HUB_HTTP_MIGRATIONS;
function fixture(){const db=new Database(":memory:");db.pragma("foreign_keys=ON");applyHubMigrations(db,legacyRegistry);return db;}
describe("personal sources without fictional Fleet identities",()=>{
  it("preserves retained Fleet publications and all inbound grant/room/quota references",()=>{
    const db=fixture();try{
      const exposure=randomUUID(),fleet=randomUUID(),grant=randomUUID(),room=randomUUID(),owner=`corp/${randomUUID()}`,asker=`corp/${randomUUID()}`;
      db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Existing',4,'published','view','[\"read\"]',?,123)").run(exposure,fleet,owner,"a".repeat(64));
      db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,3,?,?,4,?,0,?,'[\"ask\"]',0,999,'active')").run(grant,owner,exposure,owner,asker);
      db.prepare("INSERT INTO hub_rooms(id,asker,exposure_id,owner_at_creation,grant_id,state,created_at) VALUES(?,?,?,?,?,'active',123)").run(room,asker,exposure,owner,grant);
      db.prepare("INSERT INTO hub_quota_preferences VALUES(?,1)").run(exposure);
      const before=db.prepare("SELECT * FROM hub_exposures").get() as object;
      const children=["hub_grants","hub_rooms","hub_quota_preferences"].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
      applyHubMigrations(db,registry);applyHubMigrations(db,registry);
      expect(db.prepare("SELECT * FROM hub_exposures").get()).toEqual({...before,source_kind:"fleet",personal_agent_id:null});
      expect(["hub_grants","hub_rooms","hub_quota_preferences"].map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(children);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT enabled FROM hub_personal_settings").get()).toEqual({enabled:0});
      expect(()=>applyHubMigrations(db,legacyRegistry)).toThrow();
    }finally{db.close();}
  });
  it("enforces disjoint Fleet and personal publication shapes including NULL values",()=>{
    const db=fixture();try{
      applyHubMigrations(db,registry);const personal=randomUUID(),owner=`corp/${randomUUID()}`,machine=randomUUID();
      db.prepare("INSERT INTO hub_personal_agents(id,owner,machine_id,cli,created_at,updated_at) VALUES(?,?,?,'codex',0,0)").run(personal,owner,machine);
      const insert=db.prepare("INSERT INTO hub_exposures(id,owner,display_name,revision,state,updated_at,source_kind,personal_agent_id,fleet_id,data_view_id,allowed_tools,policy_digest) VALUES(?,?,'Personal',1,'published',0,?,?,?,?,?,?)");
      expect(()=>insert.run(randomUUID(),owner,"personal",personal,null,null,null,null)).not.toThrow();
      for(const values of [["personal",personal,machine,null,null,null],["personal",null,null,null,null,null],["fleet",null,null,"view","[]","digest"],["unknown",null,machine,"view","[]","digest"]])
        expect(()=>insert.run(randomUUID(),owner,...values)).toThrow();
      expect(db.prepare("SELECT fleet_id,data_view_id,allowed_tools,policy_digest FROM hub_exposures").get()).toEqual({fleet_id:null,data_view_id:null,allowed_tools:null,policy_digest:null});
      const row=db.prepare("SELECT id FROM hub_exposures").get() as {id:string};
      const projected=exposureOf(readExposure(db,row.id)!);
      expect(projected).toMatchObject({kind:"personal",personalAgentId:personal,fleetId:null,dataViewId:null,allowedTools:[],policyDigest:null});
      // A member cannot manufacture a Hub-owned personal source through its existing snapshot schema.
      expect(exposureSchema.safeParse(projected).success).toBe(false);
      expect(()=>exposureOf({...readExposure(db,row.id)!,fleet_id:machine})).toThrow();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    }finally{db.close();}
  });
});
