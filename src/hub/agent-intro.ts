/** Hub-owned, explicitly published introductions; never part of a Fleet's private catalog or consent image. */
import type Database from "better-sqlite3";
import { readExposure } from "./catalog.js";
import { personKeyString } from "./identity.js";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";
import { HubProtocolError } from "./validation.js";
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function normalizeAgentIntro(value: unknown): string {
  if (typeof value !== "string") throw new HubProtocolError("invalid");
  const text = value.normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  if ([...segments.segment(text)].length > 50) throw new HubProtocolError("invalid");
  return text;
}
export const HUB_AGENT_INTROS_MIGRATION = Object.freeze({ component: "s3-agent-intros", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_agent_intros(exposure_id TEXT PRIMARY KEY REFERENCES hub_exposures(id) ON DELETE CASCADE,
    text TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('owner','agent','default')), updated_at INTEGER NOT NULL)`);
} });
export function agentIntro(db: Database.Database, id: string): {intro:string;introBy?:"owner"|"agent"|"default";introAt?:number} {
  const row = db.prepare("SELECT text,source,updated_at FROM hub_agent_intros WHERE exposure_id=?").get(id) as {text:string;source:"owner"|"agent"|"default";updated_at:number}|undefined;
  return row ? {intro:row.text,introBy:row.source,introAt:row.updated_at} : {intro:""};
}
export function writeOwnerIntro(db: Database.Database, id: string, text: string, now: number): void {
  db.prepare(`INSERT INTO hub_agent_intros(exposure_id,text,source,updated_at) VALUES(?,?,'owner',?)
    ON CONFLICT(exposure_id) DO UPDATE SET text=excluded.text,source=excluded.source,updated_at=excluded.updated_at`).run(id,text,now);
}
export class HubAgentIntros {
  constructor(private readonly core: HubCore) {}
  /** Call only after the surrounding catalog/room authorization. */
  projection(id: string, batchDb?: Database.Database) { return batchDb ? agentIntro(batchDb, id) : this.core.atomic(db => agentIntro(db,id)); }
  async save(ctx: HubRequestContext,id:string,revision:number,value:unknown) {
    const person=await ctx.requirePerson(),owner=personKeyString(person),text=normalizeAgentIntro(value);
    const permit={assertCurrent:()=>{if(ctx.isCurrent && !ctx.isCurrent())throw new HubProtocolError("revoked");}};
    return this.core.atomic((db,tx)=>{
      const e=readExposure(db,id);
      if(!e||e.owner!==owner)throw new HubProtocolError("not-found");
      if(e.revision!==revision)throw new HubProtocolError("conflict");
      writeOwnerIntro(db,id,text,this.core.now());
      // Personal definitions use this field for display only. Keep both owner editing surfaces in sync.
      if(e.source_kind==="personal")db.prepare("UPDATE hub_personal_agents SET description=? WHERE id=?").run(text,e.personal_agent_id);
      this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person},action:"agent.intro-updated",result:"completed",exposureId:id});
      return agentIntro(db,id);
    },permit);
  }
}
