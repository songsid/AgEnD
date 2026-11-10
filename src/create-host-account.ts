/**
 * New agent on this host (WSL / Linux): the account the dashboard's create form picked, checked before anything is created.
 *
 * The form sends `credentialProfile` (a NAME, like the paired-Windows-computer form). It becomes the new agent's
 * `backend_options.<cli>.credential_profile`, so the agent's first start already runs under that account. A name that cannot
 * be used is refused with a clear reason — never dropped, never replaced by the fleet default. The same rule covers a
 * `backend_options.<cli>.credential_profile` sent directly. Pure but for reading the profile folders and their sign-in state.
 */
import { isCredentialProfileName, signedOutCredentialProfile } from "./backend/credential-profile.js";
import { PROFILE_CLIS, profilesOnDisk } from "./accounts-view.js";

export type CreateAccountResult =
  | { ok: true; backendOptions?: Record<string, Record<string, unknown>> }
  | { ok: false; status: number; error: string; code: string; backend?: string; profile?: string; loginCommand?: string };

const fail = (status: number, code: string, error: string, extra: Partial<Extract<CreateAccountResult, { ok: false }>> = {}): CreateAccountResult => ({ ok: false, status, code, error, ...extra });

/**
 * `body` is the create request (already known to be an object); `defaultBackend` is the fleet default CLI, used when the
 * request names none. On success `backendOptions` is what to create the agent with (the request's own, plus the account).
 */
export function resolveCreateAccount(dataDir: string, body: Record<string, unknown>, defaultBackend: string | undefined): CreateAccountResult {
  const backend = typeof body.backend === "string" && body.backend ? body.backend : defaultBackend || "claude-code";
  const options = body.backend_options && typeof body.backend_options === "object" && !Array.isArray(body.backend_options)
    ? body.backend_options as Record<string, Record<string, unknown>> : undefined;
  const own = options?.[backend]?.credential_profile;
  const sent = body.credentialProfile;
  if (sent !== undefined && typeof sent !== "string") return fail(400, "credential_profile_invalid", "credentialProfile must be a string");
  if (own !== undefined && own !== null && typeof own !== "string") return fail(400, "credential_profile_invalid", "backend_options credential_profile must be a string");
  const asked = (sent ?? "").trim(), inOptions = typeof own === "string" ? own.trim() : "";
  if (asked && inOptions && asked.toLowerCase() !== inOptions.toLowerCase()) {
    return fail(400, "credential_profile_conflict", "credentialProfile and backend_options credential_profile name different accounts");
  }
  const profile = asked || inOptions;
  // No account chosen: the agent follows the fleet default, as before (an empty value in backend_options already means that).
  if (!profile) return { ok: true, ...(options ? { backendOptions: options } : {}) };
  if (!PROFILE_CLIS.has(backend)) return fail(400, "credential_profile_unsupported", `${backend} does not support named accounts on this host`, { backend, profile });
  if (!isCredentialProfileName(profile)) return fail(400, "credential_profile_invalid", `Account name ${JSON.stringify(profile)} is not a valid account name`, { backend, profile });
  const known = profilesOnDisk(dataDir, backend).find(name => name === profile);
  if (!known) return fail(400, "credential_profile_not_found", `There is no ${backend} account named ${JSON.stringify(profile)} on this host — add it in Settings → Agents → Accounts first`, { backend, profile });
  const login = signedOutCredentialProfile(dataDir, backend, known);
  if (login) {
    return fail(409, "credential_profile_signed_out", `The ${backend} account ${JSON.stringify(known)} is not connected — connect it in Settings → Agents → Accounts first`,
      { backend, profile: known, loginCommand: login.loginCommand });
  }
  return { ok: true, backendOptions: { ...(options || {}), [backend]: { ...(options?.[backend] || {}), credential_profile: known } } };
}
