/**
 * Rate-limit state that only the CLI can see, remembered for the usage panel.
 *
 * Antigravity's quota summary API reports per-model bucket pools — and those
 * can read "0% used" while the account-level individual cap is exhausted.
 * Verified live (2026-08-02, same minute): `agy -p` returned "Individual quota
 * reached … Resets in 139h12m12s" while `retrieveUserQuotaSummary` reported
 * every bucket at remainingFraction 1.0. No Google API exposes the individual
 * cap; the generation error relayed through a running instance's pane is the
 * only place it surfaces. So the daemon's error monitor reports it here, and
 * the usage provider overlays it on the row that would otherwise say 🟢 0%.
 *
 * In-memory on purpose: the fleet process hosts both the error monitor and the
 * usage provider, and a restart just means the alert reappears the next time an
 * instance hits the cap.
 */

interface ProviderAlert {
  message: string;
  /** When the limit lifts — the alert's own expiry. */
  resetsAtMs: number;
  reportedAtMs: number;
}

const alerts = new Map<string, ProviderAlert>();

/**
 * `Resets in 139h12m12s` → milliseconds. Null when the text carries no such
 * phrase — the caller falls back to a default TTL rather than guessing.
 */
export function parseResetsIn(text: string): number | null {
  const m = text.match(/Resets? in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** A cap with no parseable reset still should not alarm forever. */
const DEFAULT_ALERT_TTL_MS = 60 * 60_000;

/**
 * Record a CLI-observed rate limit for a usage provider. The alert expires by
 * itself at the reset time the message names (or after an hour when it names
 * none), which is what makes "reset 後警示消失" true without a cleanup job.
 */
export function reportProviderRateLimit(providerId: string, message: string, now = Date.now()): void {
  const resetInMs = parseResetsIn(message);
  alerts.set(providerId, {
    message,
    resetsAtMs: now + (resetInMs ?? DEFAULT_ALERT_TTL_MS),
    reportedAtMs: now,
  });
}

/** The live alert for a provider, or null once its reset time has passed. */
export function getProviderRateLimit(providerId: string, now = Date.now()):
  { message: string; resetsAtMs: number } | null {
  const alert = alerts.get(providerId);
  if (!alert) return null;
  if (now >= alert.resetsAtMs) {
    alerts.delete(providerId);
    return null;
  }
  return { message: alert.message, resetsAtMs: alert.resetsAtMs };
}

export function clearProviderRateLimitsForTests(): void {
  alerts.clear();
}
