/**
 * M-3770 slice 1.6 (design #4480 §4.1, P3): the pre-flight's fix buttons, where the product can make the fix itself.
 *
 * - **Turn on lingering** (P3 `linger-off`): `loginctl enable-linger <the fleet's own user>`, so the user's service
 *   manager, and the fleet with it, keeps running after that user signs out and can bring AgEnD back after an update.
 *   systemd's polkit lets a user turn on their own lingering (`org.freedesktop.login1.set-self-linger`, allow_any). A host
 *   whose policy refuses it gets the check's own sentence, with the command to run, and nothing else changes.
 *   The proof is the file P3 itself reads (`/var/lib/systemd/linger/<user>`), never the command's exit status.
 *
 * Offered only while the fleet's own pre-flight, run again right before the fix, still fails that check. The user is
 * the fleet's own (the pre-flight's deps), never one a request names. "Install as a service" (P3 `not-service`) is not
 * a button here: it stops the running fleet and starts another under the service manager, so it waits for its own card
 * (a guarded stop, as `agend restart`'s); the check's sentence gives the command meanwhile.
 */
import type { PreflightCheck, ReadinessDeps, UpdatePreflight } from "./update-readiness.js";

export type UpdateFix = "linger";
export const UPDATE_FIXES: readonly UpdateFix[] = ["linger"];

export function isUpdateFix(value: unknown): value is UpdateFix {
  return typeof value === "string" && (UPDATE_FIXES as readonly string[]).includes(value);
}

/** The fix a failing check offers, if the product can make it here. */
export function fixFor(check: PreflightCheck | null | undefined): UpdateFix | null {
  return check && check.ok === false && check.id === "P3" && check.code === "linger-off" ? "linger" : null;
}

/** Whether `p` still asks for `fix`: one of its checks fails with that fix. */
export function fixOffered(p: UpdatePreflight | null | undefined, fix: UpdateFix): boolean {
  return !!p && Array.isArray(p.checks) && p.checks.some(c => fixFor(c) === fix);
}

// A login name as useradd takes it: nothing a shell or loginctl could read as an option or a path.
const LOGIN_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?$/;

/** Turn on lingering for the fleet's own user. `ok`: P3's own proof now holds. Never throws. */
export async function turnOnLinger(d: Pick<ReadinessDeps, "platform" | "user" | "run" | "exists">): Promise<{ ok: boolean }> {
  if (d.platform !== "linux" || !LOGIN_NAME.test(d.user)) return { ok: false };
  const proof = `/var/lib/systemd/linger/${d.user}`;
  try {
    if (await d.exists(proof)) return { ok: true };
    await d.run("loginctl", ["enable-linger", d.user], 10_000);
    return { ok: await d.exists(proof) };
  } catch {
    return { ok: false };
  }
}

/** Make `fix` on this machine. */
export function applyUpdateFix(fix: UpdateFix, d: Pick<ReadinessDeps, "platform" | "user" | "run" | "exists">): Promise<{ ok: boolean }> {
  switch (fix) {
    case "linger": return turnOnLinger(d);
  }
}
