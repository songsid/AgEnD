import type { ContactAuthStore, ContactRequest } from "./contact-auth-store.js";
import { sameContactPerson } from "./contact-auth-policy.js";
import { t } from "./locale.js";
import type { ContactHeldResult, ContactOrigin, ContactPerson, ContactTicket, ContactTicketDecision } from "./contact-auth-types.js";

export class ContactHeldError extends Error {
  constructor(readonly result: ContactHeldResult) { super(result.message); }
}
export interface ContactAuthHost {
  store: ContactAuthStore;
  restricted(instance: string): boolean;
  legacyClassic?(instance: string): boolean;
  adminOf(instance: string, person: ContactPerson): boolean;
  defaultApprovers(instance: string): ContactPerson[];
  generation(instance: string): string;
  hubRestricted(instance: string): boolean;
  delivered(ticket: ContactTicket): boolean;
  deliveryState?(ticket: ContactTicket): string | undefined;
  /** Synchronous callback on the same outbox database; must never start a direct send. */
  admit(request: ContactRequest, ticketId: string): string;
  changed(instance: string, ticketId?: string): void;
}
const unknown = (): ContactOrigin => ({ kind: "unknown", people: [], receiptIds: [], chain: [] });
export class ContactAuthService {
  constructor(readonly host: ContactAuthHost) {}
  approvers(instance: string): ContactPerson[] {
    return this.host.store.policy(instance, this.host.generation(instance)).approvers ?? this.host.defaultApprovers(instance);
  }
  canManage(instance: string, person: ContactPerson): boolean {
    // The verified host operator is also the administrator of every local instance.
    return (person.platform === "host" && person.adapterId === "host" && person.userId === "operator")
      || this.host.defaultApprovers(instance).some(row => sameContactPerson(row, person));
  }
  canDecide(instance: string, person: ContactPerson): boolean {
    return this.canManage(instance, person) && ((person.platform === "host" && person.adapterId === "host" && person.userId === "operator")
      || this.approvers(instance).some(row => sameContactPerson(row, person)));
  }
  origin(instance: string): ContactOrigin | undefined { return this.host.store.origin(instance); }
  needsApplication(instance: string): boolean {
    if (this.host.legacyClassic?.(instance)) return false;
    const origin = this.origin(instance);
    if (!this.host.restricted(instance) && !origin) return false;
    if (!origin || origin.kind !== "human" || origin.people.length !== 1) return true;
    return !this.host.adminOf(instance, origin.people[0]!);
  }
  requireApplication(input: Omit<ContactRequest, "origin" | "sourceGeneration" | "targetGeneration">): string | undefined {
    const previous = this.host.store.operationTicket(input.source, input.operationId, input.target, input.verb);
    const required = this.needsApplication(input.source);
    // Recovery of the person identity does not replay or bypass a decision for this exact old operation.
    if (!required && !previous) return;
    // M-3160 always precedes even ticket persistence, including a standing grant.
    if (this.host.hubRestricted(input.source)) throw Error("hub-contact-restricted");
    const request: ContactRequest = { ...input, origin: this.origin(input.source) ?? unknown(),
      sourceGeneration: this.host.generation(input.source), targetGeneration: this.host.generation(input.target) };
    if (!previous && input.verb === "report_result" && this.host.store.approvedReturn(input.source, input.target, input.correlationId)
      .some(ticket => ticket.targetGeneration === this.host.generation(input.source)
        && ticket.sourceGeneration === this.host.generation(input.target) && this.host.delivered(ticket))) return;
    const ticket = this.host.store.hold(request);
    // Validate the immutable operation payload before preserving its pending decision.
    if (!required && ticket.state === "pending") throw new ContactHeldError({ sent: false, held: true,
      authorization_id: ticket.id, authorization_state: ticket.state, message: t("contact.heldAgent") });
    const granted = this.host.store.applyStandingGrant(ticket.id, {
      canDecide: (target, person) => this.canManage(target, person),
      current: current => !this.host.hubRestricted(current.source)
        && this.host.generation(current.source) === current.sourceGeneration
        && this.host.generation(current.target) === current.targetGeneration,
      admit: (current, ticketId) => this.host.admit(current, ticketId),
    });
    if (!previous || previous.state !== granted?.state && !!granted) this.host.changed(ticket.source, ticket.id);
    if (granted?.deliveryId) return granted.deliveryId;
    throw new ContactHeldError({ sent: false, held: true, authorization_id: ticket.id,
      authorization_state: ticket.state, message: t(request.origin.kind === "unknown" ? "contact.refusedUnknown" : "contact.refusedEarlier") });
  }
  view(ticket: ContactTicket, actor: ContactPerson): ContactTicket {
    const current = (instance: string, generation: string) => {
      try { return this.host.generation(instance) === generation; } catch { return false; }
    };
    const targetCurrent = current(ticket.target, ticket.targetGeneration);
    const sourceCurrent = current(ticket.source, ticket.sourceGeneration);
    const canDecide = sourceCurrent && targetCurrent && this.canDecide(ticket.target, actor);
    if (!(targetCurrent && this.canManage(ticket.target, actor)) && !(sourceCurrent && this.host.adminOf(ticket.source, actor))) throw Error("forbidden");
    const delivery = this.host.deliveryState?.(ticket);
    const state = ticket.deliveryId && delivery === "delivered" ? "delivered"
      : ["failed", "uncertain", "cancelled", "reconciliation_pending"].includes(delivery ?? "") ? "unknown" : ticket.state;
    return { ...ticket, state, reason: ticket.origin.kind === "unknown" ? "unknown-origin" : "earlier-non-admin",
      canDecide: canDecide && state === "pending" };
  }
  decide(id: string, decision: ContactTicketDecision, actor: ContactPerson): ContactTicket {
    const ticket = this.host.store.decide(id, decision, actor, {
      canDecide: (target, person) => this.canDecide(target, person),
      current: request => !this.host.hubRestricted(request.source)
        && this.host.generation(request.source) === request.sourceGeneration
        && this.host.generation(request.target) === request.targetGeneration,
      admit: (request, ticketId) => this.host.admit(request, ticketId),
    });
    this.host.changed(ticket.source, ticket.id);
    if (decision.grant) this.host.changed(ticket.target);
    return this.view(ticket, actor);
  }
}
