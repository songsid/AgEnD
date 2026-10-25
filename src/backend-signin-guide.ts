/** Non-secret navigation only: the authenticated page still owns all sign-in actions. */
import { onboardingBackends } from "./backend-signin-pending.js";
export function backendSignInGuide(csv: string | undefined): string | null {
  if (csv === undefined) return "";
  const backends = onboardingBackends(csv.split(","));
  return backends?.length ? `/settings/agents?backend_signins=${encodeURIComponent(backends.join(","))}` : null;
}
