import { contactPersonKey, normalizeContactPersonKey } from "./contact-auth-store.js";
/** Contact changes are proposals, never agent-held approval capabilities. */
import { z } from "zod";
import { ContactDecisionSchema } from "./contact-auth-policy.js";
import type { ContactAuthService } from "./contact-auth-service.js";
import type { ContactOriginClear, ContactPermissionsWrite, ContactPerson, ContactTicket, ContactTicketDecision } from "./contact-auth-types.js";
import { t, getLocale } from "./locale.js";
const name = z.string().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/);
const revision = z.number().int().nonnegative().optional();
export const ContactChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mode"), target: name, revision, mode: z.enum(["legacy", "restricted"]) }),
  z.strictObject({ kind: z.literal("ticket-decision"), ticket_id: name, revision,
    decision: z.enum(["approve-once", "decline"]), grant: ContactDecisionSchema.shape.grant }),
  z.strictObject({ kind: z.literal("grant-adjust"), target: name, revision, grant_id: name,
    expires_at: z.iso.datetime(), remaining_uses: z.number().int().min(1).max(10_000).nullable() }),
  z.strictObject({ kind: z.literal("grant-revoke"), target: name, revision, grant_id: name }),
  // M-3694 (S-262): an agent held by a retained origin — the admin's own Permissions-tab clear, as a proposal.
  z.strictObject({ kind: z.literal("origin-clear"), target: name, revision }),
]).refine(value => value.kind !== "ticket-decision" || !value.grant || value.decision === "approve-once", { message: "A grant requires approve-once", path: ["grant"] });
// Keep the model's menu compact: conditional required fields are validated by
// the same strict variant schema at runtime, rather than repeating every field four times.
export const ProposeContactChangeArgs = z.strictObject({ change: z.strictObject({
  kind: z.enum(["mode", "ticket-decision", "grant-adjust", "grant-revoke", "origin-clear"]),
  target: z.string().optional(), ticket_id: z.string().optional(), revision: z.number().optional(),
  mode: z.string().optional(), decision: z.string().optional(),
  grant: z.strictObject({ expiresAt: z.string(), remainingUses: z.number().nullable(), personKeys: z.array(z.string()).optional() }).optional(),
  grant_id: z.string().optional(), expires_at: z.string().optional(), remaining_uses: z.number().nullable().optional(),
}).superRefine((value, ctx) => {
  const parsed = ContactChangeSchema.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
}) });
/** M-3693: contact_state's arguments — read-only; `agent` narrows to what involves that agent or room. */
export const ContactStateArgs = z.strictObject({ agent: z.string().min(1).max(160).optional() });
export interface ContactChangeHost {
  service: ContactAuthService;
  label?(target: string): string;
  timeZone?(): string;
  mode(target: string): "restricted" | "legacy" | undefined;
  generation(target: string): string;
  modeAdmin(target: string, person: ContactPerson): boolean;
  write(target: string, input: ContactPermissionsWrite, person: ContactPerson): unknown;
  /** The Permissions tab's own clear (FleetManager.clearContactOrigin): the admin's identity replaces the origin. */
  clearOrigin(target: string, input: ContactOriginClear, person: ContactPerson): unknown;
  decide(id: string, input: ContactTicketDecision, person: ContactPerson): unknown;
}
export interface PreparedContactChange {
  target: string;
  success: string;
  summary: string[];
  current(): boolean;
  authorized(person: ContactPerson): boolean;
  apply(person: ContactPerson): void;
}
/** The short id people see — the same rule as the web's shortTicketId (src/ui/contact-auth-client.js): R + 8 hex. */
export const shortContactTicketId = (id: string): string => /^R[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id) ? id.slice(0, 9) : id;
/**
 * M-3693: the held message a person names. People see a 9-character short id (cards, notices, contact_state); the
 * full id still works. A prefix of at least 9 characters resolves to the one pending ticket starting with it; none or
 * several are refused, never guessed.
 */
export function resolvePendingTicket(store: { get(id: string): ContactTicket | undefined; pendingByPrefix(prefix: string): ContactTicket[] }, id: string): ContactTicket {
  const exact = store.get(id);
  if (exact) { if (exact.state !== "pending") throw Error("contact-proposal-ticket-unavailable"); return exact; }
  if (id.length < 9) throw Error("contact-proposal-ticket-unavailable");
  // One query over every pending ticket (Prism #4436 P2-1: no page limit can hide a second match).
  const found = store.pendingByPrefix(id);
  if (found.length > 1) throw Error("contact-proposal-ticket-ambiguous");
  if (!found.length) throw Error("contact-proposal-ticket-unavailable");
  return found[0]!;   // live: the query leaves out a ticket past its expiry; the card re-checks it before Confirm
}
const REFUSAL_CODES = new Set(["general-only", "hub-contact-restricted", "contact-proposal-limit", "contact-proposal-ticket-unavailable",
  "contact-proposal-ticket-ambiguous", "conflict", "stale-generation", "invalid-grant-origin", "contact-proposal-not-room", "not-found",
  "invalid-grant", "forbidden", "contact-proposal-use-web", "contact-proposal-route-unavailable", "contact-proposal-no-origin"]);
/** M-3693: a refusal General can act on — a sentence with the next step, never a bare code. */
export function contactProposalRefusal(error: unknown): string {
  if (error instanceof z.ZodError) return t("contactProposal.err_invalid", error.issues.map(i => `${i.path.join(".") || "change"}: ${i.message}`).join("; "));
  const code = error instanceof Error ? error.message : String(error);
  return REFUSAL_CODES.has(code) ? t(`contactProposal.err_${code}`) : t("contactProposal.err_other", code);
}
/** Snapshots are daemon-owned and cloned; no identity or confirmation flag is accepted from the tool. */
export function prepareContactChange(raw: unknown, host: ContactChangeHost): PreparedContactChange {
  const input = ContactChangeSchema.parse(raw), store = host.service.host.store;
  const ticket = input.kind === "ticket-decision" ? resolvePendingTicket(store, input.ticket_id) : undefined;
  const target = input.kind === "ticket-decision" ? ticket!.target : input.target;
  const targetGeneration = host.generation(target), policy = structuredClone(store.policy(target, targetGeneration));
  const pins = new Map([[target, targetGeneration]]);
  const mode = host.mode(target);
  let payload: ContactPermissionsWrite | ContactTicketDecision | ContactOriginClear;
  const originRevision = store.originRevision(target);
  const label = (name: string) => host.label?.(name) || name;
  const shortId = shortContactTicketId;
  // A Latin-ending name gets a space before following Chinese prose; punctuation does not.
  const beforeCjk = (value: string): string => getLocale() === "zh-TW" && /[\p{Script=Latin}\p{Number}]$/u.test(value) ? value + " " : value;
  const timeZone = host.timeZone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (iso: string): string => {
    const parts = new Intl.DateTimeFormat(getLocale() === "zh-TW" ? "zh-TW" : "en-US", { timeZone, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
    const part = (key: string) => parts.find(p => p.type === key)?.value || "";
    const weekday = part("weekday").replace(/^(?:週|星期)/, "");
    return getLocale() === "zh-TW" ? `${part("month")}/${part("day")}（${weekday}）${part("hour")}:${part("minute")}` : `${weekday} ${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
  };
  const personName = (p: ContactPerson): string => `${p.label}${getLocale() === "zh-TW" ? "（" : " ("}${p.platform === "discord" ? "Discord" : p.platform === "telegram" ? "Telegram" : t("contactProposal.host")}${getLocale() === "zh-TW" ? "）" : ")"}`;
  const typed = (source: string, verbs: string[]): string => `${label(source)}${getLocale() === "zh-TW" ? "（" : " ("}${verbs.map(v => t(`contactProposal.verb_${v}`)).join(getLocale() === "zh-TW" ? "、" : ", ")}${getLocale() === "zh-TW" ? "）" : ")"}`;
  const summary = ticket ? [] : [t(mode ? "contactProposal.room" : "contactProposal.agent", label(target))];
  if (input.kind === "ticket-decision") {
    if (input.revision !== undefined && input.revision !== ticket!.revision) throw Error("conflict");
    pins.set(ticket!.source, host.generation(ticket!.source));
    if (ticket!.targetGeneration !== targetGeneration || ticket!.sourceGeneration !== pins.get(ticket!.source)) throw Error("stale-generation");
    payload = ContactDecisionSchema.parse({ revision: ticket!.revision, decision: input.decision, ...(input.grant ? { grant: input.grant } : {}) });
    const requestLine = t(input.grant ? "contactProposal.request" : input.decision === "decline" ? "contactProposal.declineRequest" : "contactProposal.approveRequest", shortId(ticket!.id), beforeCjk(label(ticket!.source)));
    summary.push(`${requestLine}${getLocale() === "zh-TW" ? "（" : " ("}${t(`contactProposal.verb_${ticket!.verb}`)}${getLocale() === "zh-TW" ? "）" : ")"}`);
    if (input.grant) {
      const keys = (input.grant.personKeys ?? (ticket!.origin.people.length === 1 ? [contactPersonKey(ticket!.origin.people[0]!)] : [])).map(key => normalizeContactPersonKey(key) ?? "");
      const people = ticket!.origin.people.filter(p => keys.includes(contactPersonKey(p)));
      if (ticket!.origin.kind === "unknown" || !keys.length || new Set(keys).size !== keys.length || people.length !== keys.length) throw Error("invalid-grant-origin");
      const names = people.map(personName).join(getLocale() === "zh-TW" ? "、" : ", ");
      summary.push(t("contactProposal.allowUntil", beforeCjk(names), label(ticket!.target), when(input.grant.expiresAt)),
        ...(input.grant.remainingUses === null ? [] : [t("contactProposal.uses", input.grant.remainingUses)]), t("contactProposal.boundary"));
    }
  } else {
    if (input.revision !== undefined && input.revision !== policy.revision) throw Error("conflict");
    if (input.kind === "origin-clear") {
      // Only an origin that holds the agent (unknown or mixed — what contact_state lists); a human one holds nothing.
      const origin = store.origin(target);
      if (!origin || origin.kind === "human") throw Error("contact-proposal-no-origin");
      payload = { revision: policy.revision, originRevision, generation: targetGeneration };
      const people = origin.people.map(personName).join(getLocale() === "zh-TW" ? "、" : ", ");
      summary.push(t("contactProposal.originNow", t(`contactProposal.origin_${origin.kind}`), people || t("contactProposal.originNobody")),
        t("contactProposal.originClear"), t("contactProposal.originBoundary"));
    } else if (input.kind === "mode") {
      if (!mode) throw Error("contact-proposal-not-room");
      payload = { revision: policy.revision, mode: input.mode };
      summary.push(t("contactProposal.mode", t(`contactProposal.${mode}`), t(`contactProposal.${input.mode}`)), t("contactProposal.modeWarning"), ...(input.mode === "restricted" && mode !== "restricted" ? [t("contactProposal.historyNote")] : []), t("contactProposal.guardNote"));
    } else {
      const row = policy.grants.find(g => g.id === input.grant_id);
      if (!row) throw Error("not-found");
      pins.set(row.source, host.generation(row.source));
      if (row.sourceGeneration !== pins.get(row.source) || row.targetGeneration !== targetGeneration) throw Error("stale-generation");
      payload = { revision: policy.revision, grants: policy.grants.filter(g => input.kind !== "grant-revoke" || g.id !== row.id)
        .map(g => {
          const { id, person, source, target, verbs, expiresAt, remainingUses } = g;
          return { id, person, source, target, verbs,
            expiresAt: id === row.id && input.kind === "grant-adjust" ? input.expires_at : expiresAt,
            remainingUses: id === row.id && input.kind === "grant-adjust" ? input.remaining_uses : remainingUses };
        }) };
      summary.push(t("contactProposal.rule", beforeCjk(personName(row.person))), t("contactProposal.sourceType", typed(row.source, row.verbs)),
        ...(input.kind === "grant-revoke" ? [t("contactProposal.revoke")] : [t("contactProposal.until", when(input.expires_at)), ...(input.remaining_uses === null ? [] : [t("contactProposal.uses", input.remaining_uses)])]), t("contactProposal.boundary"));
    }
  }
  if (input.kind === "grant-adjust" && Date.parse(input.expires_at) <= Date.now()
    || input.kind === "ticket-decision" && input.grant && Date.parse(input.grant.expiresAt) <= Date.now()) throw Error("invalid-grant");
  const frozen = structuredClone(payload);
  const current = (): boolean => {
    try {
      if ([...pins].some(([n, g]) => host.generation(n) !== g) || host.mode(target) !== mode || store.policy(target, targetGeneration).revision !== policy.revision) return false;
      if (input.kind === "origin-clear" && store.originRevision(target) !== originRevision) return false;
      if (ticket) { const now = store.get(ticket.id); return !!now && now.state === "pending" && now.revision === ticket.revision && Date.parse(now.expiresAt) > Date.now(); }
      return true;
    } catch { return false; }
  };
  const authorized = (person: ContactPerson): boolean => input.kind === "mode" ? host.modeAdmin(target, person)
    : ticket ? host.service.canDecide(target, person) : host.service.canManage(target, person);
  const success = ticket ? t(input.kind === "ticket-decision" && input.decision === "decline" ? "contactProposal.requestDeclined" : "contactProposal.requestApproved", shortId(ticket.id))
    : t(input.kind === "grant-adjust" ? "contactProposal.ruleAdjusted" : input.kind === "grant-revoke" ? "contactProposal.ruleRevoked"
      : input.kind === "origin-clear" ? "contactProposal.originCleared" : "contactProposal.applied");
  return { target, success, summary, current, authorized, apply(person) {
    if (!current()) throw Error("conflict");
    if (!authorized(person)) throw Error("forbidden");
    if (ticket) host.decide(ticket.id, structuredClone(frozen) as ContactTicketDecision, person);
    else if (input.kind === "origin-clear") host.clearOrigin(target, structuredClone(frozen) as ContactOriginClear, person);
    else host.write(target, structuredClone(frozen) as ContactPermissionsWrite, person);
  } };
}
