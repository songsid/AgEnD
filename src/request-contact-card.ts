/** Same SQLite owners as E/legacy; no production constructor until L. */
import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import type {ContactAuthStore,ContactDecisionAuthority,ContactRequest} from "./contact-auth-store.js";
import {contactPersonKey} from "./contact-auth-store.js";
import type {ContactPerson,ContactTicket} from "./contact-auth-types.js";
import type {RequestContactGate,RequestContactGateHost} from "./request-contact-gate.js";
import type {RequestContactCardV1,RequestContactCardPageV1,RequestContactDecisionV1,RequestContactListFilter,RequestContactPrincipal,RequestContactNeedV1} from "./request-contact-types.js";
import {RequestContactDecisionV1Schema} from "./request-contact-types.js";
import {requestContextDigest} from "./request-context-store.js";
export interface RequestContactCardsHost extends RequestContactGateHost {
 generation(instance:string):string|null;
 roleRevision():string|null;
 managedTargets(person:ContactPerson):readonly string[];
 label(instance:string):string;
 deliveryState(ticket:ContactTicket):string|undefined;
 legacyCurrent(request:ContactRequest):boolean;
 admitLegacy(request:ContactRequest,ticketId:string):string;
 changed?(ticket:ContactTicket):void;
}
type Cursor={actor:string;filter:string;roles:string;at:number;id:string;until:number};
export class RequestContactCards {
 private readonly cursors=new Map<string,Cursor>();
 constructor(private readonly db:Database.Database,private readonly tickets:ContactAuthStore,private readonly scoped:()=>RequestContactGate,private readonly host:RequestContactCardsHost){}
 private alive(actor:RequestContactPrincipal,verified=false):void {
  if(!actor.current())throw Error("forbidden");if(verified&&!actor.verified)throw Error("verification-required");
 }
 private ticket(id:string):ContactTicket {const ticket=this.tickets.peek(id);if(!ticket)throw Error("not-found");return ticket;}
 private readable(ticket:ContactTicket,actor:RequestContactPrincipal):boolean {
  try{return actor.current()&&this.host.generation(ticket.target)===ticket.targetGeneration&&this.host.canManage(ticket.target,actor.person);}catch{return false;}
 }
 canRead(card:RequestContactCardV1,actor:RequestContactPrincipal):boolean {
  try{return this.readable(this.ticket(card.ticket.id),actor);}catch{return false;}
 }
 private current(ticket:ContactTicket):boolean {return this.host.generation(ticket.source)===ticket.sourceGeneration&&this.host.generation(ticket.target)===ticket.targetGeneration;}
 read(id:string,actor:RequestContactPrincipal):RequestContactCardV1 {
  this.alive(actor);const ticket=this.ticket(id);if(!this.readable(ticket,actor))throw Error("not-found");
  const card=this.present(ticket,actor);
  if(!this.readable(this.ticket(id),actor))throw Error("not-found");return card;
 }
 private present(ticket:ContactTicket,actor:RequestContactPrincipal|null):RequestContactCardV1 {
  const scoped=!!ticket.requestContext;
  const table=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_contacts_v1'").get();
  const companion=!!table&&!!this.db.prepare("SELECT 1 FROM request_context_contacts_v1 WHERE ticket_id=?").get(ticket.id);
  if(companion!==scoped)throw Error("operation-conflict");
  const record=scoped?this.scoped().snapshot(ticket.id):null;
  const legacy=scoped?null:this.tickets.requestSnapshot(ticket.id);if(!record&&!legacy)throw Error("not-found");
  const context=record?.image.context,person=record?.person??(!scoped&&ticket.origin.kind==="human"&&ticket.origin.people.length===1?ticket.origin.people[0]!:null);
  const requester=context?.initiatingActor??(person?{kind:"person" as const,platform:person.platform,userId:person.userId,displayName:person.label}:null);
  const policy=this.tickets.policySnapshot(ticket.target,ticket.targetGeneration),continued=ticket.rootApprovalTicketId;
  const delivery=this.host.deliveryState(ticket),state=ticket.deliveryId&&delivery==="delivered"?"delivered":["failed","uncertain","cancelled","reconciliation_pending"].includes(delivery??"")?"unknown":ticket.state;
  const eligible=!!actor&&this.current(ticket)&&this.host.canDecide(ticket.target,actor.person)&&state==="pending"&&!continued;
  // Guest ingress is not a new exclusion: representability is exactly E.person(), not a guessed native identity.
  const representable=scoped?!!record?.person:ticket.origin.people.length>0&&ticket.origin.kind!=="unknown";
  const grantPeople=scoped?(person?[person]:[]):["human","mixed"].includes(ticket.origin.kind)?ticket.origin.people:[];
  const grantCandidates=[...new Map(grantPeople.map(person=>[contactPersonKey(person),{key:contactPersonKey(person),label:person.label,platform:person.platform}])).values()];
  const {id,revision,source,target,verb,message,createdAt,expiresAt,decidedAt,deliveryId}=ticket;
  return {version:1,engine:scoped?"request-v1":"legacy",ticket:{id,revision,source,target,verb,message,createdAt,expiresAt,state,...(decidedAt?{decidedAt}:{}),...(deliveryId?{deliveryId}:{})},sourceLabel:this.host.label(source),targetLabel:this.host.label(target),requester,
   ingress:context?.ingress??"legacy",sourceAudience:context?.sourceAudience??null,returnAudience:context?.returnAudience??null,grantCandidates,reason:context?context.initiatingActor.kind==="unknown"&&context.initiatingActor.reason==="unproved-recovery"?"unproved-recovery":["restricted-room","guest","hub"].includes(context.ingress)?`${context.ingress}-request`:"request":ticket.origin.kind==="unknown"?"unknown-origin":"earlier-non-admin",
   ...(continued?{continuedFrom:continued}:{}),approvalScope:scoped?"root-request":"operation",authority:"none",snapshot:{ticketRevision:revision,policyRevision:policy.revision,imageSha256:record?.imageSha256??legacy!.imageSha256},
   actions:{canDecide:eligible&&!!actor?.verified,canGrant:representable&&(eligible||!actor)&&!continued&&state==="pending",requiresVerification:!!actor&&!actor.verified&&eligible}};
 }
 needs(actor:RequestContactPrincipal):RequestContactNeedV1[] {
  this.alive(actor);const roles=this.host.roleRevision();if(!roles)throw Error("unavailable");
  const targets=[...new Set(this.host.managedTargets(actor.person))].filter(name=>this.host.canManage(name,actor.person));
  if(!targets.length)return [];if(targets.length>2000)throw Error("unavailable");
  const rows=this.db.prepare(`SELECT id FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.target') IN (${targets.map(()=>"?").join(",")}) AND json_extract(ticket_json,'$.state')='pending' LIMIT 512`).all(...targets) as Array<{id:string}>;
  const items:RequestContactNeedV1[]=[];
  for(const row of rows){const ticket=this.ticket(row.id);if(ticket.state!=="pending"||ticket.rootApprovalTicketId||!this.readable(ticket,actor)||!this.current(ticket)||!this.host.canDecide(ticket.target,actor.person))continue;
   items.push({id:`contact:${ticket.id}`,type:"contact",reason:"contact_request",instance:ticket.target,since:Date.parse(ticket.createdAt),detail:"",contactTicket:{id:ticket.id,source:ticket.source,target:ticket.target}});
  }
  this.alive(actor);if(this.host.roleRevision()!==roles)throw Error("forbidden");return items;
 }
 list(filter:RequestContactListFilter,actor:RequestContactPrincipal):RequestContactCardPageV1 {
  this.alive(actor);const roles=this.host.roleRevision();if(!roles)throw Error("unavailable");
  const actorKey=contactPersonKey(actor.person),filterKey=requestContextDigest({agent:filter.agent??null,status:filter.status??"pending"});
  const now=Date.now();for(const [key,row]of this.cursors)if(row.until<=now)this.cursors.delete(key);
  const cursor=filter.cursor?this.cursors.get(filter.cursor):undefined;
  if(filter.cursor&&(!cursor||cursor.actor!==actorKey||cursor.filter!==filterKey||cursor.roles!==roles))throw Error("invalid-cursor");
  const targets=[...new Set(this.host.managedTargets(actor.person))].filter(target=>this.host.canManage(target,actor.person));
  if(targets.length>2000)throw Error("unavailable");if(!targets.length)return {version:1,items:[],nextCursor:null};
  const params:unknown[]=[...targets];
  let where=`json_extract(t.ticket_json,'$.target') IN (${targets.map(()=>"?").join(",")})`;
  if(filter.status!=="all"){params.push(new Date(now).toISOString(),filter.status??"pending");where+=` AND
   (CASE WHEN d.state='delivered' THEN 'delivered' WHEN d.state IN ('failed','uncertain','cancelled','reconciliation_pending') THEN 'unknown'
    WHEN json_extract(t.ticket_json,'$.state')='pending' AND julianday(json_extract(t.ticket_json,'$.expiresAt'))<=julianday(?) THEN 'expired'
    ELSE json_extract(t.ticket_json,'$.state') END)=?`;}
  if(filter.agent){where+=" AND (json_extract(t.ticket_json,'$.source')=? OR json_extract(t.ticket_json,'$.target')=?)";params.push(filter.agent,filter.agent);}
  if(cursor){where+=" AND (t.created_at<? OR (t.created_at=? AND t.id<?))";params.push(cursor.at,cursor.at,cursor.id);}
  const rows=this.db.prepare(`SELECT t.id,t.created_at FROM contact_auth_tickets t LEFT JOIN deliveries d ON d.delivery_id=json_extract(t.ticket_json,'$.deliveryId') WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT 33`).all(...params)as Array<{id:string;created_at:number}>;
  const items:RequestContactCardV1[]=[];for(const row of rows.slice(0,32)){try{items.push(this.read(row.id,actor));}catch(e){if(!(e instanceof Error)||e.message!=="not-found")throw e;}}
  this.alive(actor);if(this.host.roleRevision()!==roles)throw Error("invalid-cursor");
  let nextCursor:string|null=null;
  if(rows.length>32){if(this.cursors.size>=1024)throw Error("unavailable");const last=rows[31]!;nextCursor=randomUUID();this.cursors.set(nextCursor,{actor:actorKey,filter:filterKey,roles,at:last.created_at,id:last.id,until:now+5*60_000});}
  return {version:1,items:items.filter(card=>this.canRead(card,actor)),nextCursor};
 }
 /** Internal native proposal, never a model actor or an HTTP permit. K owns server-fixed destination/nonce. */
 prepareForNativePost(id:string,currentGeneralPostingOwner:(ticket:ContactTicket)=>boolean):RequestContactCardV1 {
  const ticket=this.ticket(id);if(!currentGeneralPostingOwner(ticket))throw Error("forbidden");const card=this.present(ticket,null);
  if(!currentGeneralPostingOwner(this.ticket(id)))throw Error("forbidden");return card;
 }
 decide(id:string,raw:RequestContactDecisionV1,actor:RequestContactPrincipal):RequestContactCardV1 {
  const parsed=RequestContactDecisionV1Schema.safeParse(raw);if(!parsed.success)throw Error("invalid-request");const input=parsed.data;this.alive(actor,true);
  const decided=this.db.transaction(()=>{
   this.alive(actor,true);const ticket=this.ticket(id);if(!this.readable(ticket,actor)||!this.host.canDecide(ticket.target,actor.person))throw Error("forbidden");
   if(!this.current(ticket))throw Error("stale-generation");
   if(ticket.state==="expired")throw Error("expired");if(ticket.state!=="pending")throw Error("already-decided");
   const image=this.present(ticket,actor);if(input.grant&&!image.actions.canGrant)throw Error("invalid-grant-origin");
   const decision={revision:input.snapshot.ticketRevision,decision:input.decision,...(input.grant?{grant:input.grant}:{})};
   let result:ContactTicket;
   if(ticket.requestContext)result=this.scoped().decide(id,decision,actor.person,input.snapshot.policyRevision,input.snapshot.imageSha256);
   else {
    const authority:ContactDecisionAuthority={canDecide:(target,person)=>actor.current()&&actor.verified&&this.host.canDecide(target,person),current:request=>actor.current()&&actor.verified&&this.host.legacyCurrent(request)&&this.current(ticket),admit:(request,ticketId)=>this.host.admitLegacy(request,ticketId)};
    result=this.tickets.decideExpected(id,decision,actor.person,authority,input.snapshot);
   }
   this.alive(actor,true);if(!this.readable(result,actor)||!this.host.canDecide(result.target,actor.person)||!this.current(result))throw Error("forbidden");return result;
  })();
  this.host.changed?.(decided);return this.read(id,actor);
 }
}
