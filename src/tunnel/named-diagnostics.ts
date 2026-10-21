/** #2344: private vendor text is evidence for a closed reason, never a user/log message. */
import { redactDiagnostics } from "../diagnostic-redaction.js";

export const NAMED_TUNNEL_FAILURE_MESSAGES = {
  "named-auth-failed": "Named tunnel credentials were refused; copy only the connector token from Cloudflare and set it again.",
  "named-route-missing": "The named hostname did not reach a published application; check this tunnel's hostname, DNS and published application route.",
  "named-hostname-mismatch": "The named hostname answered with a different page; check that its published application points to AgEnD's origin URL.",
  "named-origin-unreachable": "Cloudflare could not reach the local origin; check the published application's origin URL and port.",
  "named-connection-failed": "The named tunnel could not connect to Cloudflare; check network, DNS and firewall access, then retry.",
} as const;
export type NamedTunnelFailureKind = keyof typeof NAMED_TUNNEL_FAILURE_MESSAGES;
export function namedTunnelFailureMessage(kind: string): string | undefined {
  return Object.hasOwn(NAMED_TUNNEL_FAILURE_MESSAGES, kind) ? NAMED_TUNNEL_FAILURE_MESSAGES[kind as NamedTunnelFailureKind] : undefined;
}

const CONNECTION_CODES = new Set(["EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Node fetch wraps DNS/connect failures in cause; AggregateError can contain several address attempts. */
export function classifyNamedTunnelProbeError(error: unknown, token: string): NamedTunnelFailureKind | undefined {
  const pending: unknown[] = [error], seen = new Set<object>(), messages: string[] = [];
  let connection = false;
  // Bound both nested errors and text; cycles or a large address list must not turn a failed probe into work.
  while (pending.length && seen.size < 8) {
    const next = pending.shift();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    const node = next as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (node.code === "ENOTFOUND") return "named-route-missing";
    if (typeof node.code === "string" && CONNECTION_CODES.has(node.code)) connection = true;
    if (typeof node.message === "string") messages.push(node.message.slice(0, 8 * 1024));
    if (node.cause) pending.push(node.cause);
    if (Array.isArray(node.errors)) pending.push(...node.errors.slice(0, 8));
  }
  return connection ? "named-connection-failed" : classifyNamedTunnelOutput(messages.join("\n"), token);
}

/** Exact configured credentials and the shared redactor's credential shapes are removed before interpretation. */
export function classifyNamedTunnelOutput(output: string, token: string): NamedTunnelFailureKind | undefined {
  const exactRemoved = token ? output.split(token).join("[REDACTED]") : output;
  const clean = redactDiagnostics("cloudflared diagnostics: " + exactRemoved.slice(-64 * 1024), { keepIdentifiers: true });
  if (/\b(?:invalid|unauthorized|unauthorised|expired|revoked)\b.{0,100}\b(?:token|credentials?|tunnel)\b|\b(?:token|credentials?)\b.{0,100}\b(?:not valid|invalid|unauthorized|unauthorised|expired|revoked)\b|\bauthentication (?:failed|error)\b/i.test(clean)) return "named-auth-failed";
  if (/\b(?:no|missing) (?:ingress|published application) (?:rules?|routes?)\b|\bno ingress rules\b/i.test(clean)) return "named-route-missing";
  if (/\bunable to reach the origin service\b|\b(?:origin|127\.0\.0\.1|localhost)\b.{0,160}\b(?:connection refused|ECONNREFUSED)\b/i.test(clean)) return "named-origin-unreachable";
  if (/\b(?:failed to (?:dial|connect|resolve)|unable to (?:dial|connect|resolve)|no such host|network is unreachable|i\/o timeout|connection timed out|connect timeout|context deadline exceeded|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/i.test(clean)) return "named-connection-failed";
  return undefined;
}
