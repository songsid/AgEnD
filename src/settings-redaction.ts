import { SETTINGS_SECRET_KEY } from "./settings-change.js";

/**
 * #1490 (row 18): what Settings shows in place of a credential written inline in fleet.yaml (a hand-written
 * `bot_token`, say). #1496 keeps Settings from adding or changing one; this keeps it from reading one back out.
 */
export const REDACTED_SECRET = "[configured - redacted]";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Sets an own property, even one named `__proto__` (a plain assignment would hit the prototype setter instead). */
const own = (out: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
};
const credential = (key: string | undefined, value: unknown): value is string =>
  key !== undefined && SETTINGS_SECRET_KEY.test(key) && typeof value === "string" && value !== "";

/** A copy of `value` with every credential-named string replaced by REDACTED_SECRET. */
export function redactInlineSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactInlineSecrets(item)) as T;
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) own(out, key, credential(key, child) ? REDACTED_SECRET : redactInlineSecrets(child));
  return out as T;
}

/**
 * A write built from a redacted read carries REDACTED_SECRET back under a credential-named key: put the value it
 * stands for in its place, from `previous` at the same path, so a save never writes the placeholder over a real
 * credential. A placeholder with no credential behind it (a new key, or one the save moved) is refused: `{ path }`
 * names it. Under any other key the same text is an ordinary string, saved as sent.
 */
export function restoreRedactedSecrets<T>(next: T, previous: unknown): { value: T } | { path: string } {
  const walk = (value: unknown, before: unknown, key: string | undefined, at: string): { value: unknown } | { path: string } => {
    if (value === REDACTED_SECRET && key !== undefined && SETTINGS_SECRET_KEY.test(key)) {
      return credential(key, before) ? { value: before } : { path: at };
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const step = walk(item, Array.isArray(before) ? before[index] : undefined, undefined, `${at}[${index}]`);
        if ("path" in step) return step;
        out.push(step.value);
      }
      return { value: out };
    }
    if (!record(value)) return { value };
    const out: Record<string, unknown> = {};
    for (const [child, item] of Object.entries(value)) {
      const step = walk(item, record(before) && Object.hasOwn(before, child) ? before[child] : undefined, child, at ? `${at}.${child}` : child);
      if ("path" in step) return step;
      own(out, child, step.value);
    }
    return { value: out };
  };
  return walk(next, previous, undefined, "") as { value: T } | { path: string };
}

const REDACTED = "[redacted]";
/** A key that names a credential anywhere in it (an agent's read only; Settings keeps its exact-name list). */
const AGENT_SECRET_WORD = /token|secret|password|passwd|api_?key|signing_?key|private_?key|credential|cookie/i;
/** A URL's secret parts gone: its userinfo and query, and — for a webhook, whose path is its secret — everything after the host. */
function redactUrl(text: string, wholePath: boolean): string {
  let url: URL;
  try { url = new URL(text); } catch { return text; }
  if (wholePath) return `${url.protocol}//${url.host}/${REDACTED}`;
  if (!url.username && !url.password && !url.search) return text;
  return `${url.protocol}//${url.username || url.password ? `${REDACTED}@` : ""}${url.host}${url.pathname}${url.search ? `?${REDACTED}` : ""}`;
}

/**
 * M-3694 (S-266; Fable #4561 F1): what an AGENT may read of the configuration. Settings' own key-name redaction
 * (redactInlineSecrets), then by shape, so a key added later can't leak: every header value (an `Authorization:
 * Bearer …`), every webhook URL past its host (Discord's and Slack's carry their secret in the path), and any other URL's
 * userinfo (`user:pass@`) and query (a `?token=`).
 */
export function redactForAgent<T>(value: T): T {
  const walk = (v: unknown, key: string | undefined, inWebhook: boolean): unknown => {
    // Fable #4561 follow-up: a credential word inside a compound key (client_secret, signing_key, smtp_password) too —
    // a plain-string secret there has no URL shape to catch.
    if (typeof v === "string" && v !== "" && v !== REDACTED_SECRET && key !== undefined && AGENT_SECRET_WORD.test(key)) return REDACTED;
    if (typeof v === "string") return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? redactUrl(v, inWebhook && key === "url") : v;
    if (Array.isArray(v)) return v.map(item => walk(item, undefined, inWebhook || key === "webhooks"));
    if (!record(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) {
      own(out, k, k === "headers" && record(child) ? Object.fromEntries(Object.keys(child).map(h => [h, REDACTED])) : walk(child, k, inWebhook));
    }
    return out;
  };
  return walk(redactInlineSecrets(value), undefined, false) as T;
}
