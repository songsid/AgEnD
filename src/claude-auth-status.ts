/**
 * `claude auth status`, read once and the same way everywhere (the AgEnD host's `authCheck` and CLI sign-in list, the Windows Runtime's
 * per-profile report and default sign-in): is it signed in, and which account is it, as an e-mail and a plan.
 *
 * The e-mail is the WHOLE address (`alice@example.com`), because one administrator's accounts usually share a prefix and a mask such as
 * `al***@example.com` then shows two accounts as one. It is validated strictly (printable ASCII, one `@`, at most 254 characters) and an address
 * that does not fit is dropped, never truncated or "cleaned up". Where a value arrives from elsewhere (the server, on a Runtime's report) the same
 * check applies and a value that fails it is a protocol error; the older masked form (`ab***@example.com`, still in a Runtime's cached status)
 * is accepted too. The address is shown only on the Accounts page to a local administrator session (`accountIdentityVisible`; every other caller
 * and the Hub get no identity at all), and it is never written to a log, an error message, an audit line, a notice or a chat reply: `redactedEmail`
 * is the form for any text that is not that page.
 *
 * Built-ins only: it is part of the Runtime bundle (RUNTIME_BUNDLE_MODULES).
 */

/** Reported in the Runtime's capabilities. A Runtime without it still works; it just shows no account identity. */
export const ACCOUNT_IDENTITY_CAPABILITY = "account-identity";
/** The plans that can be reported. Whatever else the CLI says becomes `unknown`; display names belong to the UI (they are product names, not translated). */
export const PLANS = Object.freeze(["free", "pro", "max", "team", "enterprise", "unknown"] as const);
export type Plan = typeof PLANS[number];
export interface AccountIdentity {
  /**
   * The account's whole e-mail address (`alice@example.com`), as validated by `validMaskedEmail`; an older Runtime may still report the masked
   * form (`ab***@example.com`). The field keeps its name so the protocol does not change. Absent when the CLI gave no usable address.
   */
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
 * The address contract. ASCII only: a local part of letters, digits and `._%+-`, `@`, then a dotted ASCII domain, under a total length cap
 * of 254 (the look-ahead; the domain alone is at most 253).
 */
const FULL_EMAIL = /^(?=.{3,254}$)[A-Za-z0-9._%+-]+@(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** The older form that a Runtime may still have cached (`ab***@example.com`): one or two characters, `***`, a dotted ASCII domain. Accepted, never produced. */
const MASKED_EMAIL = /^[A-Za-z0-9._%+-]{1,2}\*\*\*@(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MAX_MASKED = 260;
const MAX_EMAIL = 254;
const ACCOUNT_KEYS = ["maskedEmail", "plan", "apiKey"] as const;

/** A whole address or an older masked one: the only shapes of `maskedEmail` that are sent, stored or shown. Anything else (too long, non-ASCII, a space, two `@`) is not. */
export function validMaskedEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_MASKED && (value.length <= MAX_EMAIL && FULL_EMAIL.test(value) || MASKED_EMAIL.test(value));
}
export function validPlan(value: unknown): value is Plan { return typeof value === "string" && (PLANS as readonly string[]).includes(value); }

/**
 * The address as the CLI reported it, or undefined when it does not fit the contract: never truncated, never partly kept. The RAW value is checked
 * first (its length, and that it holds only printable ASCII plus the ASCII white space `trim` removes), so padding can never make an over-long or
 * non-ASCII value fit: `trim` only strips the ASCII white space around what the CLI printed, and the address that is left is checked again.
 */
function cleanEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_EMAIL || !/^[\t\n\v\f\r \x21-\x7e]+$/.test(value)) return undefined;
  const text = value.trim();
  return text && validMaskedEmail(text) && !text.includes("*") ? text : undefined;
}
/**
 * `ab***@example.com` for any text that is not the Accounts page (a terminal line, a log, an error, an audit line, a notice, a chat reply):
 * one or two characters of the local part, `***`, the whole domain. Undefined when the value is not an address of this contract.
 */
export function redactedEmail(value: unknown): string | undefined {
  if (!validMaskedEmail(value)) return undefined;
  const at = value.indexOf("@"), local = value.slice(0, at);
  if (local.endsWith("***")) return value;
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}***@${value.slice(at + 1)}`;
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
 * Closed parse of an identity that arrives from elsewhere (a Runtime's report): `maskedEmail` only as a valid address (or the older masked form), `plan` only from
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
 * The JSON objects in a text, in order: a balanced `{ … }` (string-aware, so a brace inside a quoted value does not count) from each `{`. Stdout and
 * stderr are merged by every caller, so other text, even text with braces in it, can sit around the answer. Bounded: a step budget, so a hostile
 * or enormous output cannot make this quadratic.
 */
function* jsonObjectCandidates(text: string): Generator<string> {
  let budget = 262_144;
  for (let start = text.indexOf("{"); start >= 0 && budget > 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length && budget-- > 0; i++) {
      const c = text[i];
      if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { yield text.slice(start, i + 1); start = i; break; }
    }
  }
}
/**
 * Parse the output of `claude auth status` (stdout and stderr may be merged, so the JSON object is looked for among other text, braces included):
 * the first balanced object that parses and has a boolean `loggedIn` is the answer.
 * `loggedIn`: the CLI's own boolean, null when there is no readable answer. Only a signed-in answer carries an identity: an account login
 * has an e-mail and a plan; an API key (`authMethod: "api_key"`) is marked as such and has neither.
 */
export function parseClaudeAuthStatus(text: unknown): ClaudeAuthStatus {
  const unreadable: ClaudeAuthStatus = { loggedIn: null };
  if (typeof text !== "string" || text.length > 64 * 1024) return unreadable;
  let row: Record<string, unknown> | undefined, tried = 0;
  for (const candidate of jsonObjectCandidates(text)) {
    if (++tried > 32) break;
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).loggedIn === "boolean") { row = value as Record<string, unknown>; break; }
  }
  if (!row) return unreadable;
  if (row.loggedIn !== true) return { loggedIn: false };
  if (row.authMethod === "api_key") return { loggedIn: true, apiKey: true };
  const maskedEmail = cleanEmail(row.email), plan = planOf(row.subscriptionType);
  return { loggedIn: true, ...(maskedEmail ? { maskedEmail } : {}), ...(plan ? { plan } : {}) };
}

/**
 * AGEND-113: which Google account an Antigravity (`agy`) sign-in is, from the text of its own token file (`antigravity-oauth-token`), as a MASKED e-mail only, the way Claude's is.
 *
 * Only the one field `id_token_email` is looked at: nothing else of the file (the access, refresh or ID token, their expiry, the auth method) is read into the answer, returned,
 * stored or logged, and no plan is claimed (Antigravity's plans are not the closed list above; the usage panel names them). The address is masked inside this function, before it is
 * returned, by the same private `cleanEmail` as Claude's; a missing, empty, non-ASCII, multi-`@` or over-long address, text that is not a JSON object, or text over 64 KiB gives no identity.
 * It proves nothing about whether the login still works: the caller shows it only for a sign-in that is already known to be signed in.
 */
/** The one key of agy's token file this module reads (not a key of `claude auth status`: the test that pins the status parser's keys must not count it). */
const AGY_EMAIL_KEY = "id_token_email";
export function parseAntigravityToken(text: unknown): AccountIdentity | undefined {
  if (typeof text !== "string" || text.length > 64 * 1024) return undefined;
  let file: unknown;
  try { file = JSON.parse(text); } catch { return undefined; }
  if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
  const maskedEmail = cleanEmail((file as { [key: string]: unknown })[AGY_EMAIL_KEY]);
  return maskedEmail ? { maskedEmail } : undefined;
}
