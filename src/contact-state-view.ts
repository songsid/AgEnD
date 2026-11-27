/**
 * M-3693: what General can read about contact permissions, so it can answer "what is held, and who must decide?" and
 * find the ids propose_contact_change needs. Read-only: every call below is a plain read (store.policy without a
 * generation never writes). A held message's text is not included; only its approvers may see that.
 */
import type { ContactStoredPolicy } from "./contact-auth-store.js";
import type { ContactOrigin, ContactPerson, ContactTicket } from "./contact-auth-types.js";
import { shortContactTicketId } from "./contact-change-proposals.js";
import { CONTACT_DELIVERY_IN_FLIGHT } from "./contact-auth-store.js";

export interface ContactStateHost {
  store: {
    /** No write (Prism #4436 P2-2): the ordinary list marks expired tickets and bumps their revision. */
    pendingSnapshot(limit?: number): { items: ContactTicket[]; truncated: boolean };
    policy(instance: string): ContactStoredPolicy;
    origin(instance: string): ContactOrigin | undefined;
  };
  /** Every agent and ClassicBot room this fleet knows. */
  names(): string[];
  label(name: string): string;
  /**
   * #4555 F1: does this agent's retained origin hold it — the contact gate's own rule (ContactAuthService.needsApplication):
   * an unknown or mixed origin, or a single person who isn't an admin, on anything but an unrestricted room.
   */
  restricts(name: string): boolean;
  /** A ClassicBot room's mode (restricted, or stored as "legacy": unrestricted); undefined for an agent. */
  roomMode(name: string): "restricted" | "legacy" | undefined;
  /** The agent's current incarnation: a rule or ticket for an earlier one no longer applies. */
  generation(name: string): string;
  now(): number;
}

const person = (p: ContactPerson): string => `${p.label} (${p.platform === "discord" ? "Discord" : p.platform === "telegram" ? "Telegram" : "this computer"})`;

export function contactStateView(host: ContactStateHost, filter: { agent?: string } = {}) {
  const involves = (...names: string[]) => !filter.agent || names.includes(filter.agent);
  const label = (name: string) => { const shown = host.label(name); return shown && shown !== name ? `${shown} (${name})` : name; };
  const names = host.names().filter(n => involves(n));

  const held: Array<Record<string, unknown>> = [];
  const snapshot = host.store.pendingSnapshot();
  {
    for (const t of snapshot.items) {
      if (t.state !== "pending" || Date.parse(t.expiresAt) <= host.now() || !involves(t.source, t.target)) continue;
      const approvers = host.store.policy(t.target).approvers ?? [];
      held.push({
        ticket_id: t.id, short_id: shortContactTicketId(t.id), from: label(t.source), to: label(t.target), verb: t.verb,
        origin: { kind: t.origin.kind, people: t.origin.people.map(person) },
        decides: approvers.length ? approvers.map(person) : [host.roomMode(t.target) ? "an admin of the room" : "a fleet admin"],
        expires_at: t.expiresAt, revision: t.revision,
        current: t.targetGeneration === host.generation(t.target) && t.sourceGeneration === host.generation(t.source),
      });
    }
  }

  const grants = names.flatMap(target => {
    const policy = host.store.policy(target), generation = host.generation(target);
    return policy.grants.filter(g => Date.parse(g.expiresAt) > host.now()).map(g => ({
      grant_id: g.id, target: label(target), revision: policy.revision, person: person(g.person), from: label(g.source),
      verbs: g.verbs, expires_at: g.expiresAt, remaining_uses: g.remainingUses,
      // The same exact bindings the proposal's matcher checks (Prism #4436 P2-3): both incarnations, none missing.
      current: g.targetGeneration === generation && g.sourceGeneration === host.generation(g.source),
    }));
  });

  const rooms = names.flatMap(name => {
    const mode = host.roomMode(name);
    return mode ? [{ room: label(name), mode: mode === "restricted" ? "restricted" : "unrestricted", stored_as: mode, revision: host.store.policy(name).revision }] : [];
  });

  // Only origins that restrict, by the gate's own rule (#4555 F1): one non-admin person holds the agent too.
  const retained_origins = names.flatMap(name => {
    const origin = host.store.origin(name);
    return origin && host.restricts(name) ? [{ agent: label(name), target: name, kind: origin.kind, people: origin.people.map(person), chain: origin.chain.map(label) }] : [];
  });

  return {
    held, ...(snapshot.truncated ? { held_truncated: "More messages are held than listed; the admin sees all on Fleet › Authorizations." } : {}),
    grants, rooms, retained_origins,
    how_to: [
      "Approve or decline a held message: propose_contact_change { kind: 'ticket-decision', ticket_id (the short_id works), decision }. An admin confirms the card.",
      "Change or revoke a rule: propose_contact_change { kind: 'grant-adjust' | 'grant-revoke', target, grant_id }.",
      "Switch a room: propose_contact_change { kind: 'mode', target, mode: 'restricted' | 'legacy' } ('legacy' is unrestricted).",
      "Clear a retained origin: propose_contact_change { kind: 'origin-clear', target } (the agent's target from retained_origins). An admin confirms the card, as on the agent's Permissions tab.",
    ],
  };
}

/**
 * M-3716 (the user, 11-25): what one agent may read about the requests IT sent that were held — never anyone else's,
 * and never the people or message text (its own context already has those). `delivery` reads the outbox row of an
 * approved request, so "approved" becomes "delivered" or "not confirmed" as the target's copy settles.
 */
export function ownContactRequestsView(tickets: ContactTicket[], host: {
  label(name: string): string; delivery(ticket: ContactTicket): string | undefined;
}) {
  const by = (p?: ContactPerson) => !p ? undefined : p.platform === "host" ? "host operator" : person(p);
  const requests = tickets.map(t => {
    // Prism #4452 P2-1/P2-2: an approved request's state is its real delivery row's — delivered, still in flight, or not
    // confirmed (failed, uncertain, or a row that is missing or pruned). How it was approved is a separate field.
    const delivery = t.state === "approved" ? host.delivery(t) : undefined;
    const state = t.state !== "approved" ? t.state : delivery === "delivered" ? "delivered"
      : CONTACT_DELIVERY_IN_FLIGHT.includes(delivery ?? "") ? "approved-queued" : "not-confirmed";
    const next = state === "pending" ? "Waiting for an admin. Do not send it again; you get a notice when it is decided."
      : state === "delivered" || state === "approved-queued" ? "The target has it or will get it. Wait for its answer; do not send it again."
      : state === "not-confirmed" ? (delivery ? "Approved, but delivery is not confirmed. Check delivery_status with its delivery_id before sending anything again."
        : "Approved, but its delivery is no longer on record, so it cannot be confirmed. Ask the target whether it got it before sending anything again.")
      : "Not forwarded. Send again only if it is still needed (a new request needs approval again).";
    return {
      short_id: shortContactTicketId(t.id), ticket_id: t.id, to: host.label(t.target), verb: t.verb, state,
      asked_at: t.createdAt, ...(t.decidedAt ? { decided_at: t.decidedAt } : {}),
      ...(t.grantId ? { approved_by_rule: true } : t.decidedBy ? { decided_by: by(t.decidedBy) } : {}),
      ...(state === "pending" ? { expires_at: t.expiresAt } : {}), ...(t.deliveryId ? { delivery_id: t.deliveryId } : {}), next,
    };
  });
  return { requests, ...(requests.length ? {} : { note: "None of your messages to other agents were held." }) };
}
