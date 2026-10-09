/**
 * Build the `X-Agend-Instance-Token` header value for a given instance name
 * and bearer token.
 *
 * The instance name is percent-encoded so non-ASCII names (e.g. "鬥破開發-opus-…")
 * and names containing ":" survive HTTP/1.1 header transmission without
 * throwing ERR_INVALID_CHAR. The agent endpoint reverses this with
 * `decodeURIComponent` before token lookup.
 *
 * Kept in its own side-effect-free module so tests can import just this
 * function without running agent-cli's `main()`.
 */
export function agentTokenHeader(instance: string, token: string): string {
  return `${encodeURIComponent(instance)}:${token}`;
}
