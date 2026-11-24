/**
 * M-3693: what General can read about contact permissions, so it can answer "what is held, and who must decide?" and
 * find the ids propose_contact_change needs. Read-only: every call below is a plain read (store.policy without a
 * generation never writes). A held message's text is not included; only its approvers may see that.
 */
import type { ContactStoredPolicy } from "./contact-auth-store.js";
import type { ContactOrigin, ContactPerson, ContactTicket } from "./contact-auth-types.js";
import { shortContactTicketId } from "./contact-change-proposals.js";

export interface ContactStateHost {
  store: {
    list(filter: { status?: string; cursor?: string }): { items: ContactTicket[]; nextCursor: string | null };
    policy(instance: string): ContactStoredPolicy;
    origin(instance: string): ContactOrigin | undefined;
  };
  /** Every agent and ClassicBot room this fleet knows. */
  names(): string[];
  label(name: string): string;
  /** A ClassicBot room's mode (restricted, or stored as "legacy": unrestricted); undefined for an agent. */
  roomMode(name: string): "restricted" | "legacy" | undefined;
  /** The agent's current incarnation: a rule or ticket for an earlier one no longer applies. */
  generation(name: string): string;
  now(): number;
}

const TICKET_PAGES = 20;
const person = (p: ContactPerson): string => `${p.label} (${p.platform === "discord" ? "Discord" : p.platform === "telegram" ? "Telegram" : "this computer"})`;

export function contactStateView(host: ContactStateHost, filter: { agent?: string } = {}) {
  const involves = (...names: string[]) => !filter.agent || names.includes(filter.agent);
  const label = (name: string) => { const shown = host.label(name); return shown && shown !== name ? `${shown} (${name})` : name; };
  const names = host.names().filter(n => involves(n));

  const held: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < TICKET_PAGES; page++) {
    const result = host.store.list({ status: "pending", ...(cursor ? { cursor } : {}) });
    for (const t of result.items) {
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
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const grants = names.flatMap(target => {
    const policy = host.store.policy(target), generation = host.generation(target);
    return policy.grants.filter(g => Date.parse(g.expiresAt) > host.now()).map(g => ({
      grant_id: g.id, target: label(target), revision: policy.revision, person: person(g.person), from: label(g.source),
      verbs: g.verbs, expires_at: g.expiresAt, remaining_uses: g.remainingUses,
      current: !g.targetGeneration || g.targetGeneration === generation,
    }));
  });

  const rooms = names.flatMap(name => {
    const mode = host.roomMode(name);
    return mode ? [{ room: label(name), mode: mode === "restricted" ? "restricted" : "unrestricted", stored_as: mode, revision: host.store.policy(name).revision }] : [];
  });

  // Only origins that restrict: an unknown or mixed origin holds the agent's messages for approval until it is cleared.
  const retained_origins = names.flatMap(name => {
    const origin = host.store.origin(name);
    return origin && origin.kind !== "human" ? [{ agent: label(name), kind: origin.kind, people: origin.people.map(person), chain: origin.chain.map(label) }] : [];
  });

  return {
    held, grants, rooms, retained_origins,
    how_to: [
      "Approve or decline a held message: propose_contact_change { kind: 'ticket-decision', ticket_id (the short_id works), decision }. An admin confirms the card.",
      "Change or revoke a rule: propose_contact_change { kind: 'grant-adjust' | 'grant-revoke', target, grant_id }.",
      "Switch a room: propose_contact_change { kind: 'mode', target, mode: 'restricted' | 'legacy' } ('legacy' is unrestricted).",
      "A retained origin is cleared by an admin on the agent's Permissions tab in the web dashboard; General cannot propose it.",
    ],
  };
}
