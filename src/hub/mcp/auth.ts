/** Hub-owned OAuth grants for a company person. No caller-selected identity or administrative context. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { personKeyString } from "../identity.js";
import { personFromString, type HubCore, type HubOperationPermit } from "../http/core.js";
import { HubProtocolError, plain, person as personSchema, validated } from "../validation.js";
import type { HubRequestContext, PersonKey } from "../types.js";

export const HUB_MCP_SCOPES = ["rooms:read", "rooms:post", "agents:ask"] as const;
export type HubMcpScope = typeof HUB_MCP_SCOPES[number];
export const HUB_MCP_APP_IDLE = 30 * 24 * 60 * 60_000;
export const HUB_MCP_ACCESS_TTL = 60 * 60_000;
const REQUEST_TTL = 10 * 60_000, CODE_TTL = 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const label = plain(160).min(1).max(80).refine(v => v === v.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v));
const scopesSchema = z.array(z.enum(HUB_MCP_SCOPES)).min(1).max(3).refine(v => new Set(v).size === v.length);
function redirect(value: string): boolean {
  try { const u = new URL(value); return !u.username && !u.password && !u.hash &&
    (u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)); }
  catch { return false; }
}
// RFC 7591 permits extra client metadata. Strip it; never forward it as caller identity.
const registration = z.object({ client_name: label.default("AI app"), redirect_uris: z.array(plain(2048).refine(redirect)).min(1).max(5),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2).default(["authorization_code", "refresh_token"]),
  response_types: z.tuple([z.literal("code")]).default(["code"]), token_endpoint_auth_method: z.literal("none").default("none") });
const authorization = z.strictObject({ client_id: opaque, redirect_uri: plain(2048), response_type: z.literal("code"),
  code_challenge: opaque, code_challenge_method: z.literal("S256"), resource: plain(2048),
  scope: plain(128).optional(), state: plain(512).optional() });
interface ClientRow { id: string; name: string; redirect_uris: string; created_at: number }
interface RequestRow { id_hash: string; client_id: string; redirect_uri: string; challenge: string; scopes: string; state: string | null; created_at: number; expires_at: number }
interface AppRow { id: string; client_id: string; person: string; scopes: string; resource: string; directory_epoch: number; created_at: number; seen_at: number; state: "active" | "ended" }
interface CodeRow { code_hash: string; app_id: string; redirect_uri: string; challenge: string; expires_at: number }
interface TokenRow { token_hash: string; app_id: string; kind: "access" | "refresh"; expires_at: number }
const authorityImage = (row: AppRow) => JSON.stringify([row.id,row.client_id,row.person,row.scopes,row.resource,row.directory_epoch,row.created_at,row.state]);

export class HubMcpOAuthError extends Error {
  constructor(readonly error: "invalid_request" | "invalid_client" | "invalid_client_metadata" | "invalid_grant" | "invalid_scope" | "access_denied" | "temporarily_unavailable") {
    super(`Hub app authorization: ${error}`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, error: ConstructorParameters<typeof HubMcpOAuthError>[0] = "invalid_request"): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new HubMcpOAuthError(error); return parsed.data;
}
function scopes(value?: string): HubMcpScope[] {
  return parse(scopesSchema, value === undefined ? [...HUB_MCP_SCOPES] : value.split(" "), "invalid_scope");
}
function sameRedirect(registered: string, selected: string): boolean {
  if (registered === selected) return true;
  if (!redirect(selected)) return false;
  const a = new URL(registered), b = new URL(selected);
  // Native apps choose a fresh loopback port. Every other component stays exact.
  if (a.protocol !== "http:" || b.protocol !== "http:") return false;
  a.port = ""; b.port = ""; return a.href === b.href;
}

export interface HubMcpAppPolicy {
  /** Default-off feature and live allowed-list permit; rechecked after every asynchronous boundary. */
  authorize(person: PersonKey, current: () => boolean): Promise<HubOperationPermit>;
}
export class HubMcpAuth {
  readonly resource: string;
  constructor(private readonly core: HubCore, private readonly policy?: HubMcpAppPolicy) {
    const origin = new URL(core.deps.config.webOrigin);
    if (origin.protocol !== "https:" || origin.origin !== core.deps.config.webOrigin) throw new HubMcpOAuthError("invalid_request");
    this.resource = `${origin.origin}/mcp`;
  }
  private now(): number {
    const now = this.core.now(); if (!Number.isSafeInteger(now) || now < 0) throw new HubMcpOAuthError("temporarily_unavailable"); return now;
  }
  private app(id: string): AppRow | undefined { return this.core.atomic(db => db.prepare("SELECT * FROM hub_mcp_apps WHERE id=?").get(id) as AppRow | undefined); }
  private valid(row: AppRow | undefined): boolean {
    const now = this.now(); return !!row && row.state === "active" && row.resource === this.resource
      && row.directory_epoch === this.core.directoryEpoch && row.created_at <= now && row.seen_at <= now && now - row.seen_at < HUB_MCP_APP_IDLE;
  }
  private client(id: string): ClientRow {
    const row = this.core.atomic(db => db.prepare("SELECT * FROM hub_mcp_clients WHERE id=?").get(id) as ClientRow | undefined);
    if (!row) throw new HubMcpOAuthError("invalid_client"); return row;
  }
  register(input: unknown) {
    const value = parse(registration, input, "invalid_client_metadata"), now = this.now(), id = secret();
    if (!value.grant_types.includes("authorization_code")) throw new HubMcpOAuthError("invalid_client_metadata");
    this.core.atomic(db => {
      if ((db.prepare("SELECT count(*) AS n FROM hub_mcp_clients").get() as {n:number}).n >= 1024) throw new HubMcpOAuthError("temporarily_unavailable");
      db.prepare("INSERT INTO hub_mcp_clients VALUES(?,?,?,?)").run(id, value.client_name, JSON.stringify(value.redirect_uris), now);
    });
    return { ...value, client_id: id, client_id_issued_at: Math.floor(now / 1000) };
  }
  begin(input: unknown): { request: string } {
    const value = parse(authorization, input), client = this.client(value.client_id), allowed = scopes(value.scope), now = this.now();
    if (value.resource !== this.resource || !(JSON.parse(client.redirect_uris) as string[]).some(uri => sameRedirect(uri, value.redirect_uri))) throw new HubMcpOAuthError("invalid_request");
    const request = secret();
    this.core.atomic(db => {
      db.prepare("DELETE FROM hub_mcp_authorizations WHERE expires_at<=?").run(now);
      if ((db.prepare("SELECT count(*) AS n FROM hub_mcp_authorizations").get() as {n:number}).n >= 1024
        || (db.prepare("SELECT count(*) AS n FROM hub_mcp_authorizations WHERE client_id=?").get(client.id) as {n:number}).n >= 32) throw new HubMcpOAuthError("temporarily_unavailable");
      db.prepare("INSERT INTO hub_mcp_authorizations VALUES(?,?,?,?,?,?,?,?)")
        .run(digest(request), client.id, value.redirect_uri, value.code_challenge, JSON.stringify(allowed), value.state ?? null, now, now + REQUEST_TTL);
    });
    return { request };
  }
  private request(id: string): RequestRow {
    parse(opaque, id); const row = this.core.atomic(db => db.prepare("SELECT * FROM hub_mcp_authorizations WHERE id_hash=?").get(digest(id)) as RequestRow | undefined);
    if (!row || this.now() >= row.expires_at || this.now() < row.created_at) throw new HubMcpOAuthError("invalid_request"); return row;
  }
  private async browser(ctx: HubRequestContext) {
    const person = await ctx.requirePerson(), actor = await ctx.current();
    const current = () => this.core.live() && ctx.isCurrent?.() === true;
    if (actor.kind !== "directory" || actor.sessionId.startsWith("mcp:") || personKeyString(actor.person) !== personKeyString(person) || !current()) throw new HubMcpOAuthError("access_denied");
    // A directory actor is not necessarily a browser: app contexts deliberately
    // reuse that actor for existing person services, but have no cookie session row.
    const session = this.core.atomic(db => db.prepare("SELECT person,state,directory_epoch,expires_at FROM hub_sessions WHERE id=?").get(actor.sessionId) as
      {person:string;state:string;directory_epoch:number;expires_at:number}|undefined);
    if(!session || session.person!==personKeyString(person) || session.state!=="active"
      || session.directory_epoch!==this.core.directoryEpoch || session.expires_at<=this.now()) throw new HubMcpOAuthError("access_denied");
    return { person, current };
  }
  private async permit(person: PersonKey, current: () => boolean): Promise<HubOperationPermit> {
    if (!this.policy) throw new HubMcpOAuthError("temporarily_unavailable");
    if (!current()) throw new HubMcpOAuthError("access_denied");
    const permit = await this.policy.authorize(person, current);
    permit.assertCurrent(); if (!current()) throw new HubMcpOAuthError("access_denied"); return permit;
  }
  async preview(ctx: HubRequestContext, id: string) {
    const row = this.request(id), actor = await this.browser(ctx), permit = await this.permit(actor.person, actor.current);
    this.request(id); permit.assertCurrent();
    return { name: this.client(row.client_id).name, scopes: JSON.parse(row.scopes) as HubMcpScope[] };
  }
  async approve(ctx: HubRequestContext, id: string, input: unknown): Promise<string> {
    const selected = parse(scopesSchema, input, "invalid_scope"), row = this.request(id), actor = await this.browser(ctx);
    if (selected.some(scope => !(JSON.parse(row.scopes) as string[]).includes(scope))) throw new HubMcpOAuthError("invalid_scope");
    const permit = await this.permit(actor.person, actor.current), now = this.now(), app = randomUUID(), code = secret();
    this.core.atomic((db,tx) => {
      if (!actor.current() || JSON.stringify(this.request(id)) !== JSON.stringify(row)) throw new HubMcpOAuthError("access_denied");
      if ((db.prepare("SELECT count(*) AS n FROM hub_mcp_apps WHERE person=? AND state='active'").get(personKeyString(actor.person)) as {n:number}).n >= 64) throw new HubMcpOAuthError("access_denied");
      db.prepare("DELETE FROM hub_mcp_authorizations WHERE id_hash=?").run(row.id_hash);
      db.prepare("INSERT INTO hub_mcp_apps VALUES(?,?,?,?,?,?,?,?,?)").run(app,row.client_id,personKeyString(actor.person),JSON.stringify(selected),this.resource,this.core.directoryEpoch,now,now,"active");
      db.prepare("INSERT INTO hub_mcp_codes VALUES(?,?,?,?,?)").run(digest(code),app,row.redirect_uri,row.challenge,now + CODE_TTL);
      for (const action of ["mcp.connected","mcp.consented"]) this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:actor.person},action,result:"completed",codeId:app,reasonCode:selected.join(" ")});
    },permit);
    const target = new URL(row.redirect_uri); target.searchParams.set("code",code); if (row.state !== null) target.searchParams.set("state",row.state); return target.href;
  }
  cancel(id: string): string {
    const row = this.request(id);
    this.core.atomic(db => db.prepare("DELETE FROM hub_mcp_authorizations WHERE id_hash=?").run(row.id_hash));
    const target = new URL(row.redirect_uri); target.searchParams.set("error","access_denied"); if(row.state !== null) target.searchParams.set("state",row.state); return target.href;
  }
  private async liveApp(id: string, externalCurrent: () => boolean = () => true) {
    if(!externalCurrent()) throw new HubMcpOAuthError("invalid_grant");
    const row = this.app(id);
    if (!row || !this.valid(row)) { if (row?.state === "active") this.end(row,"expired"); throw new HubMcpOAuthError("invalid_grant"); }
    const person = personFromString(row.person), image = authorityImage(row);
    const current = () => { const latest = this.app(id); return !!latest && externalCurrent() && this.core.live() && this.valid(latest) && authorityImage(latest) === image; };
    const facts = await this.core.current(person);
    if (!facts) {
      const status = this.core.atomic(db => db.prepare("SELECT status FROM hub_people WHERE person=?").get(row.person) as {status:string}|undefined);
      if (status?.status === "disabled") this.revokePolicyGrants({kind:"person",person},"account-disabled");
      throw new HubMcpOAuthError("invalid_grant");
    }
    let permit: HubOperationPermit;
    if(!externalCurrent()) throw new HubMcpOAuthError("invalid_grant");
    // The policy permit owns policy/lifetime only. The exact app image is separately
    // checked before writes; an intended scope reduction must not reject itself.
    try { permit = await this.permit(person,() => externalCurrent() && this.core.live()); }
    catch (error) {
      if (externalCurrent() && this.core.live() && (error instanceof HubMcpOAuthError && error.error === "access_denied"
        || error instanceof HubProtocolError && error.code === "denied")) this.revokePolicyGrants({kind:"person",person},"not-allowed");
      throw error;
    }
    permit.assertCurrent(); if(!current()) throw new HubMcpOAuthError("invalid_grant");
    return {row,person,permit,current};
  }
  /** Internal policy lifecycle port. The policy writer calls the global sweep in
   * its disable transaction; an observed person denial ends that person's grants
   * together. Never expose this method as an app or browser request dispatcher. */
  revokePolicyGrants(scope:{kind:"all"}|{kind:"person";person:PersonKey},reason:"feature-disabled"|"not-allowed"|"account-disabled"="not-allowed"):void {
    const selected=validated(z.discriminatedUnion("kind",[z.strictObject({kind:z.literal("all")}),z.strictObject({kind:z.literal("person"),person:personSchema})]),scope);
    this.core.atomic(db=>{
      const rows=(selected.kind==="person"?db.prepare("SELECT * FROM hub_mcp_apps WHERE person=? AND state='active'").all(personKeyString(selected.person))
        :db.prepare("SELECT * FROM hub_mcp_apps WHERE state='active'").all()) as AppRow[];
      for(const row of rows)this.end(row,reason);
    });
  }
  private end(row: AppRow, reason: string): void {
    this.core.atomic((db,tx) => {
      if (db.prepare("UPDATE hub_mcp_apps SET state='ended' WHERE id=? AND state='active'").run(row.id).changes === 0) return;
      db.prepare("DELETE FROM hub_mcp_tokens WHERE app_id=?").run(row.id);
      db.prepare("DELETE FROM hub_mcp_codes WHERE app_id=?").run(row.id);
      this.core.audit(tx,{requestId:randomUUID(),actor:{kind:"person",person:personFromString(row.person)},action:"mcp.ended",result:"completed",codeId:row.id,reasonCode:reason});
    });
  }
  private issue(db: import("better-sqlite3").Database, app: AppRow, allowed: HubMcpScope[]) {
    const now = this.now(), access = secret(), refresh = secret();
    db.prepare("DELETE FROM hub_mcp_tokens WHERE expires_at<=? OR (app_id=? AND kind='refresh')").run(now,app.id);
    if((db.prepare("SELECT count(*) AS n FROM hub_mcp_tokens WHERE app_id=?").get(app.id) as {n:number}).n >= 32) throw new HubMcpOAuthError("temporarily_unavailable");
    // A refresh cannot grow the grant; old access tokens remain within that grant until their short expiry.
    db.prepare("UPDATE hub_mcp_apps SET scopes=?,seen_at=? WHERE id=?").run(JSON.stringify(allowed),now,app.id);
    const insert = db.prepare("INSERT INTO hub_mcp_tokens VALUES(?,?,?,?)");
    insert.run(digest(access),app.id,"access",now + HUB_MCP_ACCESS_TTL); insert.run(digest(refresh),app.id,"refresh",now + HUB_MCP_APP_IDLE);
    return {access_token:access,refresh_token:refresh,token_type:"Bearer" as const,expires_in:HUB_MCP_ACCESS_TTL / 1000,scope:allowed.join(" ")};
  }
  async exchangeCode(input: unknown) {
    const v = parse(z.strictObject({client_id:opaque,code:opaque,code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),redirect_uri:plain(2048),resource:plain(2048)}),input,"invalid_grant");
    const row = this.core.atomic(db => db.prepare("SELECT * FROM hub_mcp_codes WHERE code_hash=?").get(digest(v.code)) as CodeRow|undefined);
    if(!row || row.expires_at <= this.now() || row.redirect_uri !== v.redirect_uri || v.resource !== this.resource) throw new HubMcpOAuthError("invalid_grant");
    const challenge = createHash("sha256").update(v.code_verifier).digest("base64url");
    if(!timingSafeEqual(Buffer.from(row.challenge),Buffer.from(challenge))) throw new HubMcpOAuthError("invalid_grant");
    const checked = await this.liveApp(row.app_id);
    if(checked.row.client_id !== v.client_id) throw new HubMcpOAuthError("invalid_grant");
    return this.core.atomic(db => {
      if(!checked.current() || row.expires_at <= this.now() || db.prepare("DELETE FROM hub_mcp_codes WHERE code_hash=?").run(row.code_hash).changes !== 1) throw new HubMcpOAuthError("invalid_grant");
      return this.issue(db,checked.row,JSON.parse(checked.row.scopes) as HubMcpScope[]);
    },checked.permit);
  }
  async refresh(input: unknown) {
    const v = parse(z.strictObject({client_id:opaque,refresh_token:opaque,resource:plain(2048),scope:plain(128).optional()}),input,"invalid_grant");
    const token = this.token(v.refresh_token,"refresh"), checked = await this.liveApp(token.app_id);
    if(checked.row.client_id !== v.client_id || v.resource !== this.resource) throw new HubMcpOAuthError("invalid_grant");
    const selected = v.scope === undefined ? JSON.parse(checked.row.scopes) as HubMcpScope[] : scopes(v.scope);
    if(selected.some(s => !(JSON.parse(checked.row.scopes) as string[]).includes(s))) throw new HubMcpOAuthError("invalid_scope");
    return this.core.atomic(db => {
      if(!checked.current() || this.token(v.refresh_token,"refresh").token_hash !== token.token_hash) throw new HubMcpOAuthError("invalid_grant");
      return this.issue(db,checked.row,selected);
    },checked.permit);
  }
  private token(value: string, kind: TokenRow["kind"]): TokenRow {
    parse(opaque,value,"invalid_grant"); const token = this.core.atomic(db => db.prepare("SELECT * FROM hub_mcp_tokens WHERE token_hash=?").get(digest(value)) as TokenRow|undefined);
    if(!token || token.kind !== kind) throw new HubMcpOAuthError("invalid_grant");
    if(token.expires_at <= this.now()) {
      const app = this.app(token.app_id); if(app?.state === "active" && !this.valid(app)) this.end(app,"expired");
      throw new HubMcpOAuthError("invalid_grant");
    }
    return token;
  }
  async authenticate(value: string) {
    const token = this.token(value,"access"), checked = await this.liveApp(token.app_id);
    this.core.atomic(db => { if(!checked.current() || this.token(value,"access").token_hash !== token.token_hash) throw new HubMcpOAuthError("invalid_grant");
      db.prepare("UPDATE hub_mcp_apps SET seen_at=? WHERE id=?").run(this.now(),checked.row.id); },checked.permit);
    const id = checked.row.id, person = checked.person, sessionId = `mcp:${id}`, image = authorityImage(checked.row);
    let permit = checked.permit;
    const identityCurrent = () => { try { const t = this.token(value,"access"), row = this.app(id);
      return !!row && t.app_id === id && this.valid(row) && authorityImage(row) === image; } catch { return false; } };
    const current = () => { try { permit.assertCurrent(); return identityCurrent(); } catch { return false; } };
    const requirePerson = async () => { const latest = await this.liveApp(id,identityCurrent); permit = latest.permit;
      if(!current()) throw new HubMcpOAuthError("invalid_grant"); return person; };
    const context: HubRequestContext = {requestId:randomUUID(),isCurrent:current,
      isIdentityCurrent:(p,s) => s === sessionId && personKeyString(p) === personKeyString(person) && current(),
      current:async () => { await requirePerson(); return {kind:"directory",person,sessionId}; }, requirePerson,
      requireAdmin:async () => { throw new HubProtocolError("denied"); }};
    return {appId:id,name:this.client(checked.row.client_id).name,scopes:JSON.parse(checked.row.scopes) as HubMcpScope[],context};
  }
  async list(ctx: HubRequestContext) {
    const actor = await this.browser(ctx);
    return this.core.atomic(db => { if(!actor.current()) throw new HubMcpOAuthError("access_denied");
      return (db.prepare("SELECT a.*,c.name FROM hub_mcp_apps a JOIN hub_mcp_clients c ON c.id=a.client_id WHERE a.person=? AND a.state='active' ORDER BY a.created_at DESC")
        .all(personKeyString(actor.person)) as (AppRow & {name:string})[]).filter(row => this.valid(row))
        .map(row => ({id:row.id,name:row.name,scopes:JSON.parse(row.scopes) as HubMcpScope[],connectedAt:row.created_at,lastUsedAt:row.seen_at}));
    });
  }
  async disconnect(ctx: HubRequestContext, id: string) {
    const actor = await this.browser(ctx), row = this.app(id);
    if(!row || row.person !== personKeyString(actor.person)) throw new HubMcpOAuthError("access_denied");
    this.core.atomic((db,tx) => {
      if(!actor.current()) throw new HubMcpOAuthError("access_denied");
      if(db.prepare("UPDATE hub_mcp_apps SET state='ended' WHERE id=? AND state='active'").run(id).changes) {
        db.prepare("DELETE FROM hub_mcp_tokens WHERE app_id=?").run(id); db.prepare("DELETE FROM hub_mcp_codes WHERE app_id=?").run(id);
        this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:actor.person},action:"mcp.disconnected",result:"completed",codeId:id});
      }
    });
  }
}
