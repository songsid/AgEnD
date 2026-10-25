/** Provider allowlist shared by browser-terminal and structured login views. */
export const LOGIN_LINK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "codex": ["openai.com"],
  "grok": ["x.ai"],
  "kiro-cli": ["amazonaws.com", "awsapps.com", "aws.amazon.com", "kiro.dev"],
  "claude-code": ["anthropic.com", "claude.ai", "claude.com"],
};

/** An HTTPS URL on the backend's own host, without credentials. */
export function linkableLoginUrl(backend: string, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return (LOGIN_LINK_HOSTS[backend] ?? []).some(domain => host === domain || host.endsWith(`.${domain}`));
}
