/**
 * `claude auth status`, read once and the same way everywhere (the AgEnD host's `authCheck` and CLI sign-in list, the Windows Runtime's
 * per-profile report and default sign-in): is it signed in, and which account is it, as a MASKED e-mail and a plan.
 *
 * The full e-mail never leaves `parseClaudeAuthStatus`: it is masked inside, before anything is returned, stored, logged, shown or sent
 * (`ab***@example.com`). The same pattern is enforced where a masked value arrives from elsewhere (the server, on a Runtime's report), and a
 * value that does not match it is a protocol error, never "cleaned up". The domain is sent in full on purpose: it lets an admin tell a work
 * account from a personal one.
 *
 * Built-ins only: it is part of the Runtime bundle (RUNTIME_BUNDLE_MODULES).
 */

/** Reported in the Runtime's capabilities. A Runtime without it still works; it just shows no account identity. */
export const ACCOUNT_IDENTITY_CAPABILITY = "account-identity";
/** The plans that can be reported. Whatever else the CLI says becomes `unknown`; display names belong to the UI (they are product names, not translated). */
export const PLANS = Object.freeze(["free", "pro", "max", "team", "enterprise", "unknown"] as const);
export type Plan = typeof PLANS[number];
export interface AccountIdentity {
  /** `ab***@example.com`: one or two characters of the local part (one when it has two or fewer), `***`, the whole domain. Absent when the CLI gave no usable address. */
  maskedEmail?: string;
  plan?: Plan;
  /** An API-key sign-in: there is no account behind it, so no e-mail and no plan. */
  apiKey?: true;
}
export interface ClaudeAuthStatus extends AccountIdentity {
  /** Null when the answer could not be read at all (not the same as signed out). */
  loggedIn: boolean | null;
}

/**
 * The mask contract. ASCII only, one or two visible characters, then `***@`, then a dotted ASCII domain of at most 253 characters
 * (the look-ahead), under a total length cap.
 */
const MASKED_EMAIL = /^[A-Za-z0-9._%+-]{1,2}\*\*\*@(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MAX_MASKED = 260;
const MAX_EMAIL = 254;
const ACCOUNT_KEYS = ["maskedEmail", "plan", "apiKey"] as const;

export function validMaskedEmail(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_MASKED && MASKED_EMAIL.test(value); }
export function validPlan(value: unknown): value is Plan { return typeof value === "string" && (PLANS as readonly string[]).includes(value); }

/** Module-private on purpose: the only way to get a masked address is through the parser, so no caller ever holds a raw one. */
function mask(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_EMAIL || !/^[\x21-\x7e]+$/.test(text)) return undefined;          // printable ASCII, no space: a non-ASCII address sends none
  const at = text.indexOf("@");
  if (at < 1 || at !== text.lastIndexOf("@")) return undefined;
  const local = text.slice(0, at), domain = text.slice(at + 1);
  const masked = `${local.slice(0, local.length <= 2 ? 1 : 2)}***@${domain}`;
  // Self-check with the very pattern the server enforces: anything that does not fit it sends no e-mail, never a partial one.
  return validMaskedEmail(masked) ? masked : undefined;
}
/**
 * The subscription type as Claude names it, trimmed and lower-cased: the one normalization both the plan reported here and the usage
 * panel's plan label (src/usage/providers.ts) start from.
 */
export function normalizeSubscriptionType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plan = value.trim().toLowerCase();
  return plan || undefined;
}
function planOf(value: unknown): Plan | undefined {
  const type = normalizeSubscriptionType(value);
  return type === undefined ? undefined : (PLANS as readonly string[]).includes(type) && type !== "unknown" ? type as Plan : "unknown";
}

/**
 * Closed parse of an identity that arrives from elsewhere (a Runtime's report): `maskedEmail` only in its masked form, `plan` only from
 * the list, `apiKey` only `true`, and nothing else. A violation is an error carrying no value: the rejected text is never echoed.
 */
export function parseAccountIdentity(value: unknown): AccountIdentity {
  const fail = (field: string): never => { throw new Error(`Invalid account identity: ${field}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("identity");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(ACCOUNT_KEYS as readonly string[]).includes(key)) return fail("unknown field");
  if (input.maskedEmail !== undefined && !validMaskedEmail(input.maskedEmail)) return fail("maskedEmail");
  if (input.plan !== undefined && !validPlan(input.plan)) return fail("plan");
  if (input.apiKey !== undefined && input.apiKey !== true) return fail("apiKey");
  if (input.apiKey === true && (input.maskedEmail !== undefined || input.plan !== undefined)) return fail("apiKey");
  return { ...(input.maskedEmail !== undefined ? { maskedEmail: input.maskedEmail as string } : {}), ...(input.plan !== undefined ? { plan: input.plan as Plan } : {}), ...(input.apiKey === true ? { apiKey: true as const } : {}) };
}
/** The identity part of a parse, or undefined when there is none. */
export function identityOf(status: ClaudeAuthStatus): AccountIdentity | undefined {
  const identity: AccountIdentity = { ...(status.maskedEmail ? { maskedEmail: status.maskedEmail } : {}), ...(status.plan ? { plan: status.plan } : {}), ...(status.apiKey ? { apiKey: true as const } : {}) };
  return Object.keys(identity).length ? identity : undefined;
}

/**
 * Parse the output of `claude auth status` (stdout and stderr may be merged, so a JSON object inside other text is found).
 * `loggedIn`: the CLI's own boolean, null when there is no readable answer. Only a signed-in answer carries an identity: an account login
 * has a masked e-mail and a plan; an API key (`authMethod: "api_key"`) is marked as such and has neither.
 */
export function parseClaudeAuthStatus(text: unknown): ClaudeAuthStatus {
  const unreadable: ClaudeAuthStatus = { loggedIn: null };
  if (typeof text !== "string" || text.length > 64 * 1024) return unreadable;
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return unreadable;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return unreadable; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unreadable;
  const row = value as Record<string, unknown>;
  if (typeof row.loggedIn !== "boolean") return unreadable;
  if (row.loggedIn !== true) return { loggedIn: false };
  if (row.authMethod === "api_key") return { loggedIn: true, apiKey: true };
  const maskedEmail = mask(row.email), plan = planOf(row.subscriptionType);
  return { loggedIn: true, ...(maskedEmail ? { maskedEmail } : {}), ...(plan ? { plan } : {}) };
}
