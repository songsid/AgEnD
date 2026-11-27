/** Separate owner-only inventory: never used by the shared-agent directory or app tools. */
import { HUB_LAPSE_CARRY, lapsedRevision, rememberLapse } from "./lapse-carry.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { uuid } from "./validation.js";
import { agentCatalogSchema, HUB_AGENT_CATALOG_CAPABILITY, HUB_EXPOSURE_REQUEST_CAPABILITY, type HubAgentCatalog } from "./agent-catalog-model.js";
import { canonicalArguments, personKeyString } from "./identity.js";
import { HubProtocolError, validated } from "./validation.js";
import type { HubCore } from "./http/core.js";
import type { HubLinkContext } from "./server.js";
import type { HubRequestContext } from "./types.js";

export const HUB_AGENT_CATALOG_MIGRATION = Object.freeze({ component:"s3-agent-catalog",version:1,up(db:Database.Database) {
  db.exec("CREATE TABLE hub_agent_catalogs(fleet_id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,received_at INTEGER NOT NULL)");
} });
interface Row { owner:string;generation:number;revision:string;body:string;received_at:number }
export class HubAgentCatalogs {
  private readonly links=new Map<string,HubLinkContext>();
  private readonly reports=new WeakSet<HubLinkContext>();
  private readonly refreshed = new Map<string, number>();
  constructor(private readonly core:HubCore) {}
  connected(link:HubLinkContext):void { if(link.current())this.links.set(link.fleetId,link); }
  prune():void {
    this.core.atomic(db=>{
      const fleets=this.core.deps.store.read().fleets;
      for(const row of db.prepare("SELECT fleet_id,owner,generation FROM hub_agent_catalogs").all() as (Row&{fleet_id:string})[]) {
        if(!fleets.some(f=>f.id===row.fleet_id&&f.status==="active"&&f.generation===row.generation&&personKeyString(f.owner)===row.owner)) db.prepare("DELETE FROM hub_agent_catalogs WHERE fleet_id=?").run(row.fleet_id);
      }
    });
  }
  report(value:unknown,link:HubLinkContext):void {
    const body=validated(agentCatalogSchema,value);
    if(!link.features.has("welcome-caps-v1")||!link.features.has(HUB_AGENT_CATALOG_CAPABILITY))throw new HubProtocolError("incompatible");
    if(body.requests&&!link.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY))throw new HubProtocolError("incompatible");
    this.core.atomic(db=>{
      if(!link.current())throw new HubProtocolError("stale");
      const fleet=this.core.deps.store.read().fleets.find(f=>f.id===link.fleetId);
      if(!fleet||fleet.status!=="active"||personKeyString(fleet.owner)!==personKeyString(link.owner))throw new HubProtocolError("revoked");
      const known=this.links.get(fleet.id);
      if(known && known!==link && known.current())throw new HubProtocolError("stale");
      const previous=db.prepare("SELECT * FROM hub_agent_catalogs WHERE fleet_id=?").get(fleet.id) as Row|undefined;
      const bytes=canonicalArguments(body);
      if(previous?.owner===personKeyString(fleet.owner)&&previous.generation===fleet.generation&&previous.revision===body.revision&&previous.body!==bytes)throw new HubProtocolError("conflict");
      // #4361 review (M-3543): the other order — this Fleet's catalog shows its lapsed exposure republished (next revision,
      // no longer lapsed) before the snapshot. A catalog authorizes nothing: keep the evidence for that Fleet; the snapshot,
      // whose binding the Hub checks, decides.
      if(HUB_LAPSE_CARRY&&previous?.owner===personKeyString(fleet.owner)&&previous.generation===fleet.generation)for(const row of body.agents){
        const e=row.exposure,from=e?lapsedRevision(previous.body,e.id):null;
        if(e&&from!==null&&e.state==="published"&&!e.lapsed&&e.revision===from+1)rememberLapse(db,e.id,fleet.id,from,this.core.now());
      }
      db.prepare(`INSERT INTO hub_agent_catalogs VALUES(?,?,?,?,?,?) ON CONFLICT(fleet_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,revision=excluded.revision,body=excluded.body,received_at=excluded.received_at`)
        .run(fleet.id,personKeyString(fleet.owner),fleet.generation,body.revision,bytes,this.core.now());
      this.links.set(fleet.id,link); this.reports.add(link);
    });
  }
  async owner(ctx: HubRequestContext) {
    const person = await ctx.requirePerson(), actor = await ctx.current();
    const current = () => this.core.live() && ctx.isCurrent?.() === true;
    if (ctx.application || actor.kind !== "directory" || actor.sessionId.startsWith("mcp:")
      || personKeyString(actor.person) !== personKeyString(person) || !current()) throw new HubProtocolError("denied");
    const assertCurrent = () => this.core.atomic(db => {
      const session = db.prepare("SELECT person,state,directory_epoch,expires_at FROM hub_sessions WHERE id=?").get(actor.sessionId) as { person: string; state: string; directory_epoch: number; expires_at: number } | undefined;
      if (!current() || !session || session.person !== personKeyString(person) || session.state !== "active"
        || session.directory_epoch !== this.core.directoryEpoch || session.expires_at <= this.core.now()) throw new HubProtocolError("revoked");
    });
    assertCurrent(); return { person, actor, assertCurrent };
  }
  /** Internal owner queue view; the browser caller is checked separately and never selected from input. */
  reportOf(fleetId: string, batchDb?: Database.Database, state?: ReturnType<HubCore["deps"]["store"]["read"]>) {
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => {
      const fleet = (state ?? this.core.deps.store.read()).fleets.find(row => row.id === fleetId);
      const row = db.prepare("SELECT * FROM hub_agent_catalogs WHERE fleet_id=?").get(fleetId) as Row | undefined;
      const link = this.links.get(fleetId);
      if (!fleet || fleet.status !== "active" || !row || row.generation !== fleet.generation || row.owner !== personKeyString(fleet.owner)) return null;
      return { fleet, catalog: validated(agentCatalogSchema, JSON.parse(row.body)), link: link?.current() && this.reports.has(link) ? link : null };
    });
  }
  async view(ctx:HubRequestContext) {
    const { person, assertCurrent } = await this.owner(ctx);
    this.prune();
    return this.core.atomic(db=>{
      assertCurrent();
      return {fleets:this.core.deps.store.read().fleets.filter(f=>f.status==="active"&&personKeyString(f.owner)===personKeyString(person)).map(f=>{
        const row=db.prepare("SELECT * FROM hub_agent_catalogs WHERE fleet_id=?").get(f.id) as Row|undefined;
        const link=this.links.get(f.id),connected=link?.current()===true;
        return {id:f.id,label:f.label??null,connected,catalogSupported:connected?this.reports.has(link!):null,
          catalog:row?{...validated(agentCatalogSchema,JSON.parse(row.body)) as HubAgentCatalog,at:row.received_at}:null};
      })};
    });
  }
  /** A send is only a refresh request, never proof of a new report. Old peers receive nothing. */
  async refresh(ctx: HubRequestContext, input: unknown) {
    const { fleetId } = validated(z.strictObject({ fleetId: uuid }), input);
    const browser = await this.owner(ctx), report = this.reportOf(fleetId);
    if (!report || personKeyString(report.fleet.owner) !== personKeyString(browser.person)) throw new HubProtocolError("not-found");
    const link = report.link, transport = this.core.deps.transport();
    if (!link?.current() || !link.features.has(HUB_AGENT_CATALOG_CAPABILITY) || !transport) throw new HubProtocolError("unavailable");
    const now = this.core.now();
    for (const [id, at] of this.refreshed) if (now - at >= 5_000) this.refreshed.delete(id);
    if (this.refreshed.has(fleetId)) throw new HubProtocolError("backpressure");
    browser.assertCurrent(); this.refreshed.set(fleetId, now);
    await transport.send(fleetId, { v: 1, type: "agent.catalog-refresh", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: {} });
    browser.assertCurrent();
    if (this.reportOf(fleetId)?.link !== link || !link.current()) throw new HubProtocolError("unavailable");
    return { requested: true, fleetId };
  }
  close():void {this.links.clear();}
}
