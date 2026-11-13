/** Provider allowlist shared by browser-terminal and structured login views. */
export const LOGIN_LINK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "codex": ["openai.com"],
  "grok": ["x.ai"],
  "kiro-cli": ["amazonaws.com", "awsapps.com", "aws.amazon.com", "kiro.dev"],
  "claude-code": ["anthropic.com", "claude.ai", "claude.com"],
  // `agy acp --login` opens Google's account chooser. This is what the link of a structured sign-in may point at; chat's /login for Antigravity is declined (login-flows.ts), so the
  // browser-terminal paths never see it. Exactly this host: the sign-in reducers (runtime-signin.ts) check it again, without subdomains.
  "antigravity": ["accounts.google.com"],
};

/** An HTTPS URL on the backend's own host, without credentials. */
export function linkableLoginUrl(backend: string, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return (LOGIN_LINK_HOSTS[backend] ?? []).some(domain => host === domain || host.endsWith(`.${domain}`));
}
