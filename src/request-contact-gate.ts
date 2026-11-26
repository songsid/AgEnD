import { assertRequestContextRootOpen } from "./request-context-fence.js";
/** Dormant request-scoped contact policy. Only the outbox owns its transaction/admission ports. */
import { t } from "./locale.js";
import type Database from "better-sqlite3";
import type { NewOutboxDelivery, OutboxDelivery } from "./delivery-outbox.js";
import { ContactHeldError } from "./contact-auth-service.js";
import type { ContactAuthStore, ContactRequest, ContactDecisionAuthority } from "./contact-auth-store.js";
import type { ContactPerson, ContactTicket, ContactTicketDecision, ContactVerb } from "./contact-auth-types.js";
import { RequestContextV1Schema, RequestOperationBindingV1Schema, type RequestContextActorV1, type RequestContextV1, type RequestOperationBindingV1 } from "./request-context-protocol.js";
import { RequestContextStore, requestContextDigest, requestContextJson } from "./request-context-store.js";
const TABLE = "request_context_contacts_v1";
const VERBS: readonly string[] = ["send_to_instance", "delegate_task", "request_information", "broadcast", "report_result"];
interface Image { delivery: NewOutboxDelivery; context: RequestContextV1; binding: RequestOperationBindingV1 }
interface Saved { image: Image; ticketId: string }
export interface RequestContactGateHost {
  /** Current role/config/incarnation/Hub restrictions, independent of a held originating turn's lifetime. */
  current(context: RequestContextV1, binding: RequestOperationBindingV1, delivery: NewOutboxDelivery): boolean;
  /** Resolve native identity transport from trusted ingress evidence, never a Hub/display/body fallback. */
  person(actor: RequestContextActorV1): ContactPerson | null;
  adminOf(instance: string, person: ContactPerson): boolean;
  /** Current policy only for a proven accepted room basis; undefined retains the original rule. Never relabel provenance. */
  sourceRestricted?(root:RequestContextV1):boolean|undefined;
  canDecide(target: string, person: ContactPerson): boolean;
  canManage(target: string, person: ContactPerson): boolean;
  /** F/I lifecycle must prove no live turn, input, derivative work or native call ledger references. Uninstalled before cutover. */
  rootRetired?(rootId: string): boolean;
  /** H static constraints and unendorsed Hub exception; absent keeps the existing hold policy. */
  hubRelayAllowed?(context:RequestContextV1,binding:RequestOperationBindingV1,delivery:NewOutboxDelivery):boolean;
}
export interface RequestContactGatePorts {
  ready(): void;
  retire(rootId: string, proof: () => boolean): number;
  admit(delivery: NewOutboxDelivery, context: RequestContextV1, binding: RequestOperationBindingV1): { delivery: OutboxDelivery; inserted: boolean };
}
export class RequestContactGate {
  private readonly contexts: RequestContextStore;
  constructor(private readonly db: Database.Database, private readonly tickets: ContactAuthStore,
    private readonly ports: RequestContactGatePorts, private readonly host: RequestContactGateHost) {
    ports.ready(); this.contexts = new RequestContextStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      source_instance TEXT NOT NULL, operation_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
      root_id TEXT NOT NULL, ticket_id TEXT NOT NULL UNIQUE REFERENCES contact_auth_tickets(id),
      image_json TEXT NOT NULL, image_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL, last_checked_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source_instance,operation_id))`);
    db.exec("CREATE INDEX IF NOT EXISTS request_context_contact_legacy_operation_v1 ON contact_auth_tickets(json_extract(request_json,'$.source'),json_extract(request_json,'$.operationId'))");
  }
  private checked(delivery: NewOutboxDelivery, raw: RequestContextV1, bindingRaw: RequestOperationBindingV1): Image {
    // Clone before any callback; model-owned mutable objects must not change the approved bytes.
    const image = JSON.parse(requestContextJson({ delivery, context: RequestContextV1Schema.parse(raw), binding: RequestOperationBindingV1Schema.parse(bindingRaw) })) as Image;
    const { context, binding } = image;
    if (Buffer.byteLength(requestContextJson(image)) > 128 * 1024 || !VERBS.includes(binding.verb)
      || binding.contextId !== context.ref.contextId || binding.rootContextId !== context.ref.rootContextId
      || binding.operationId !== delivery.operationId || binding.source.instance !== delivery.sourceInstance
      || binding.target.instance !== delivery.targetInstance || requestContextJson(binding.source) !== requestContextJson(context.source)
      || binding.payloadSha256 !== requestContextDigest(delivery.payload)) throw Error("request-context contact binding conflict");
    return image;
  }
  private read(source: string, operation: string,readOnly=false): Saved | null {
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE source_instance=? AND operation_id=?`).get(source, operation) as
      { source_instance: string; operation_id: string; source_key: string; root_id: string; ticket_id: string; image_json: string; image_sha256: string; request_sha256:string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.image_json) as Image, image = this.checked(parsed.delivery, parsed.context, parsed.binding);
    const stored = this.contexts.context(image.context.ref.contextId);
    const ticket = readOnly?this.tickets.peek(row.ticket_id):this.tickets.get(row.ticket_id);
    const request=this.db.prepare("SELECT request_json FROM contact_auth_tickets WHERE id=?").get(row.ticket_id) as {request_json:string}|undefined;
    if (!request || row.request_sha256!==requestContextDigest(JSON.parse(request.request_json)) || row.image_sha256 !== requestContextDigest(image) || image.delivery.sourceKey !== row.source_key
      || image.delivery.sourceInstance !== row.source_instance || image.delivery.operationId !== row.operation_id
      || image.context.ref.rootContextId !== row.root_id || !stored || requestContextJson(stored) !== requestContextJson(image.context)
      || !ticket || requestContextJson(ticket.requestContext ?? null) !== requestContextJson(image.context.ref)
      || ticket.source !== row.source_instance || ticket.target !== image.delivery.targetInstance
      || ticket.sourceGeneration !== image.binding.source.incarnation || ticket.targetGeneration !== image.binding.target.incarnation
      || ticket.verb !== image.binding.verb) throw Error("request-context contact companion unavailable");
    return { image, ticketId: row.ticket_id };
  }
  /** Validated immutable companion, never rebuilt by a card renderer and never mutating expiry. */
  snapshot(id:string):{image:Image;imageSha256:string;ticket:ContactTicket;person:ContactPerson|null} {
    this.ports.ready();
    return this.db.transaction(()=>{
      const row=this.db.prepare(`SELECT source_instance,operation_id,image_sha256 FROM ${TABLE} WHERE ticket_id=?`).get(id) as {source_instance:string;operation_id:string;image_sha256:string}|undefined;
      if(!row)throw Error("request-context scoped ticket required");
      const saved=this.read(row.source_instance,row.operation_id,true),ticket=this.tickets.peek(id);
      if(!saved||!ticket)throw Error("request-context contact companion unavailable");
      return structuredClone({image:saved.image,imageSha256:row.image_sha256,ticket,person:this.person(saved.image.context)});
    })();
  }
  private person(context: RequestContextV1): ContactPerson | null {
    const actor = context.initiatingActor;
    if (actor.kind !== "person" || actor.platform === "hub") return null;
    const person = this.host.person(actor);
    if (person && (person.platform !== actor.platform || person.userId !== actor.userId)) throw Error("request-context contact person differs");
    return person;
  }
  private requireCurrent(image: Image): void {
    assertRequestContextRootOpen(this.db,image.context.ref.rootContextId);
    if(image.context.ingress==="hub")this.host.hubRelayAllowed?.(image.context,image.binding,image.delivery);
    if (!this.host.current(image.context, image.binding, image.delivery)) throw Error("request-context contact is no longer current");
  }
  private admitImage(image: Image): {delivery:OutboxDelivery;inserted:boolean} {
    this.requireCurrent(image);
    const result=this.ports.admit(image.delivery,image.context,image.binding);
    this.requireCurrent(image); return result;
  }
  private request(image: Image): ContactRequest {
    const person = this.person(image.context), payload = image.delivery.payload;
    return { operationId: image.delivery.operationId, source: image.delivery.sourceInstance, target: image.delivery.targetInstance,
      sourceGeneration: image.binding.source.incarnation, targetGeneration: image.binding.target.incarnation,
      verb: image.binding.verb as ContactVerb, origin: { kind: person ? "human" : "unknown", people: person ? [person] : [], receiptIds: [], chain: [] },
      message: typeof payload.content === "string" ? payload.content : requestContextJson(payload),
      correlationId: image.delivery.correlationId ?? image.delivery.operationId, correlationExplicit: true,
      resultRecipient: image.delivery.sourceInstance, payload, forwards: image.delivery.forwards, requestContext: image.context.ref };
  }
  /** A committed original decision plus its exact B-bound delivery is the only D1 proof. */
  private release(root: string): ContactTicket | null {
    const rows = this.db.prepare(`SELECT source_instance,operation_id FROM ${TABLE} WHERE root_id=? ORDER BY rowid`).all(root) as Array<{ source_instance: string; operation_id: string }>;
    for (const row of rows) {
      const saved = this.read(row.source_instance, row.operation_id)!;
      const ticket = this.tickets.get(saved.ticketId)!;
      if (ticket.state !== "approved" && ticket.state !== "delivered" || ticket.rootApprovalTicketId) continue;
      const admitted = this.contexts.operation(row.source_instance, row.operation_id);
      if (!ticket.deliveryId || !admitted || admitted.deliveryId !== ticket.deliveryId
        || requestContextJson(admitted.binding) !== requestContextJson(saved.image.binding)) throw Error("request-context root release unavailable");
      return ticket;
    }
    return null;
  }
  private authority(rootApprovalTicketId?: string): ContactDecisionAuthority {
    return { requestContextVersion: 1, ...(rootApprovalTicketId ? { rootApprovalTicketId } : {}),
      canDecide: (target, actor) => rootApprovalTicketId ? true : this.host.canDecide(target, actor),
      current: request => { const saved = this.read(request.source, request.operationId); return !!saved && this.host.current(saved.image.context, saved.image.binding, saved.image.delivery); },
      admit: request => {
        const saved = this.read(request.source, request.operationId);
        if (!saved || requestContextJson(request.requestContext ?? null) !== requestContextJson(saved.image.context.ref)) throw Error("request-context scoped decision required");
        this.requireCurrent(saved.image);
        return this.admitImage(saved.image).delivery.deliveryId;
      } };
  }
  private continued(saved: Saved, release: ContactTicket): ContactTicket {
    this.requireCurrent(saved.image);
    const ticket = this.tickets.get(saved.ticketId)!;
    if (ticket.state !== "pending") return ticket;
    return this.tickets.decide(ticket.id, { revision: ticket.revision, decision: "approve-once" }, release.decidedBy!, this.authority(release.id));
  }
  admit(delivery: NewOutboxDelivery, context: RequestContextV1, binding: RequestOperationBindingV1): { delivery: OutboxDelivery; inserted: boolean } {
    this.ports.ready(); const image = this.checked(delivery, context, binding);
    const result = this.db.transaction(() => {
      this.contexts.recordContext(image.context); this.requireCurrent(image);
      const keyOwner = this.db.prepare(`SELECT source_instance,operation_id FROM ${TABLE} WHERE source_key=?`).get(delivery.sourceKey) as {source_instance:string;operation_id:string}|undefined;
      if (keyOwner && (keyOwner.source_instance !== delivery.sourceInstance || keyOwner.operation_id !== delivery.operationId)) throw Error("request-context contact source key conflict");
      const previous = this.read(delivery.sourceInstance, delivery.operationId);
      if (previous && requestContextJson(previous.image) !== requestContextJson(image)) throw Error("request-context contact operation conflict");
      const admitted = this.contexts.operation(delivery.sourceInstance, delivery.operationId);
      if (admitted) return { admitted: this.admitImage(image) };
      if (previous) {
        let ticket = this.tickets.get(previous.ticketId)!;
        if (ticket.state === "pending") {
          const release = this.release(context.ref.rootContextId);
          if (release) ticket = this.continued(previous, release);
          else ticket = this.tickets.applyStandingGrant(ticket.id, { ...this.authority(), canDecide: (target, actor) => this.host.canManage(target, actor) }) ?? ticket;
        }
        if (ticket.deliveryId) return { admitted: this.admitImage(image) };
        return { ticket };
      }
      // New-engine work cannot adopt an old held operation, even if its target or verb changed.
      if (this.db.prepare("SELECT 1 FROM contact_auth_tickets WHERE json_extract(request_json,'$.source')=? AND json_extract(request_json,'$.operationId')=? LIMIT 1")
        .get(delivery.sourceInstance, delivery.operationId)) throw Error("request-context cannot adopt legacy ticket");
      if (this.db.prepare("SELECT 1 FROM deliveries WHERE request_context_id IS NULL AND (source_key=? OR (source_instance=? AND operation_id=?)) LIMIT 1").get(delivery.sourceKey,delivery.sourceInstance,delivery.operationId)) throw Error("request-context cannot adopt legacy operation");
      const release = this.release(context.ref.rootContextId), root = this.contexts.context(context.ref.rootContextId);
      const person = root ? this.person(root) : null;
      const roomIngress=context.ingress==="restricted-room"||context.ingress==="free-room";
      const currentRoomPolicy=roomIngress&&root?this.host.sourceRestricted?.(root):undefined;
      const currentlyRestricted=currentRoomPolicy??context.ingress==="restricted-room";
      const normal = context.ingress === "owner" || roomIngress&&!currentlyRestricted
        || roomIngress&&currentlyRestricted && !!root && !!person && this.host.adminOf(root.source.instance, person);
      const hub=context.ingress==="hub"&&this.host.hubRelayAllowed?.(context,binding,delivery)===true;
      if (release || normal || hub) return { admitted: this.admitImage(image) };
      const request=this.request(image),ticket = this.tickets.hold(request);
      this.db.prepare(`INSERT INTO ${TABLE} (source_instance,operation_id,source_key,root_id,ticket_id,image_json,image_sha256,request_sha256) VALUES (?,?,?,?,?,?,?,?)`).run(delivery.sourceInstance, delivery.operationId, delivery.sourceKey,
        context.ref.rootContextId, ticket.id, requestContextJson(image), requestContextDigest(image),requestContextDigest(request));
      const granted = this.tickets.applyStandingGrant(ticket.id, { ...this.authority(), canDecide: (target, actor) => this.host.canManage(target, actor) });
      return granted?.deliveryId ? { admitted: this.admitImage(image) } : { ticket };
    })();
    if (result.admitted) return result.admitted;
    const ticket=result.ticket;
    const message=ticket.state==="pending" ? t("contact.heldAgent")
      : ticket.state==="declined" ? t("contact.noticeDeclined",ticket.id,ticket.target)
      : ticket.state==="expired" ? t("contact.noticeExpired",ticket.id,ticket.target) : t("contact.updated");
    throw new ContactHeldError({ sent: false, held: true, authorization_id: ticket.id, authorization_state: ticket.state, message });
  }
  decide(id: string, decision: ContactTicketDecision, actor: ContactPerson, policyRevision: number,expectedImageSha256:string): ContactTicket {
    this.ports.ready(); this.tickets.get(id); // Persist expiry even when the decision refuses.
    return this.db.transaction(() => {
      const ticket = this.tickets.get(id);
      if (!ticket?.requestContext) throw Error("request-context scoped ticket required");
      const row = this.db.prepare(`SELECT source_instance,operation_id,image_sha256 FROM ${TABLE} WHERE ticket_id=?`).get(id) as { source_instance: string; operation_id: string; image_sha256:string } | undefined;
      if (!row || !this.read(row.source_instance, row.operation_id)) throw Error("request-context contact companion unavailable");
      if(row.image_sha256!==expectedImageSha256)throw Error("operation-conflict");
      if (this.tickets.policy(ticket.target, ticket.targetGeneration).revision !== policyRevision) throw Error("policy-conflict");
      return this.tickets.decide(id, decision, actor, this.authority());
    })();
  }
  retireRoot(rootId: string): number {
    this.ports.ready(); return this.db.transaction(() => {
      const rows=this.db.prepare(`SELECT source_instance,operation_id FROM ${TABLE} WHERE root_id=?`).all(rootId) as Array<{source_instance:string;operation_id:string}>;
      for(const row of rows)this.read(row.source_instance,row.operation_id);
      return this.ports.retire(rootId, () => this.host.rootRetired?.(rootId) === true);
    })();
  }
  private sweepRows(rows: Array<{source_instance:string;operation_id:string;ticket_id:string}>): {approved:ContactTicket[]; refused:Array<{ticketId:string;reason:string}>} {
    const approved:ContactTicket[]=[],refused:Array<{ticketId:string;reason:string}>=[];
    for (const row of rows) {
      let ticketId=row.ticket_id;
      try {
        const ticket=this.db.transaction(()=>{
          const saved=this.read(row.source_instance,row.operation_id)!; ticketId=saved.ticketId;
          if(this.tickets.get(ticketId)?.state!=="pending")return null;
          this.requireCurrent(saved.image);
          const release=this.release(saved.image.context.ref.rootContextId);
          return release ? this.continued(saved,release) : this.tickets.applyStandingGrant(ticketId,{...this.authority(),canDecide:(target,actor)=>this.host.canManage(target,actor)})??null;
        })();
        if(ticket?.deliveryId)approved.push(ticket);
      } catch { refused.push({ticketId,reason:"request-contact-reevaluation-refused"}); }
      finally {
        // Fair scheduling only, never permission/provenance. Failed candidates rotate too.
        this.db.prepare(`UPDATE ${TABLE} SET last_checked_seq=(SELECT COALESCE(MAX(last_checked_seq),0)+1 FROM ${TABLE}) WHERE ticket_id=?`).run(row.ticket_id);
      }
    }
    return {approved,refused};
  }
  /** Owned by the future projection/outcome sweep; default 64 pending scoped operations per tick. */
  sweep(limit=64): {approved:ContactTicket[];refused:Array<{ticketId:string;reason:string}>} {
    this.ports.ready();if(!Number.isInteger(limit)||limit<1||limit>64)throw Error("invalid-limit");
    const rows=this.db.prepare(`SELECT c.source_instance,c.operation_id,c.ticket_id FROM ${TABLE} c JOIN contact_auth_tickets t ON t.id=c.ticket_id WHERE json_extract(t.ticket_json,'$.state')='pending' ORDER BY c.last_checked_seq,c.rowid LIMIT ?`).all(limit) as Array<{source_instance:string;operation_id:string;ticket_id:string}>;
    return this.sweepRows(rows);
  }
  reevaluate(rootId: string, limit = 64): {approved:ContactTicket[];refused:Array<{ticketId:string;reason:string}>} {
    this.ports.ready();if(!Number.isInteger(limit)||limit<1||limit>64)throw Error("invalid-limit");
    if(!this.release(rootId))return {approved:[],refused:[]};
    const rows=this.db.prepare(`SELECT c.source_instance,c.operation_id,c.ticket_id FROM ${TABLE} c JOIN contact_auth_tickets t ON t.id=c.ticket_id WHERE c.root_id=? AND json_extract(t.ticket_json,'$.state')='pending' ORDER BY c.last_checked_seq,c.rowid LIMIT ?`).all(rootId,limit) as Array<{source_instance:string;operation_id:string;ticket_id:string}>;
    return this.sweepRows(rows);
  }
}
