/**
 * M-3770 slice 1.6 (design #4480 §4.1, P3): the pre-flight's fix buttons, where the product can make the fix itself.
 *
 * - **Turn on lingering** (P3 `linger-off`): `loginctl enable-linger <the fleet's own user>`, so the user's service
 *   manager, and the fleet with it, keeps running after that user signs out and can bring AgEnD back after an update.
 *   systemd's polkit lets a user turn on their own lingering (`org.freedesktop.login1.set-self-linger`, allow_any). A host
 *   whose policy refuses it gets the check's own sentence, with the command to run, and nothing else changes.
 *   The proof is the file P3 itself reads (`/var/lib/systemd/linger/<user>`), never the command's exit status.
 *
 * - **Install as a service** (P3 `not-service`, S-246): this install's own `agend install`, started apart from the
 *   fleet so it outlives it. It hands the fleet over to the service manager (service-install-handover.ts): refused
 *   before any stop, a guarded stop of this fleet, and the fleet started again if the service can't start. Every Agent
 *   stops briefly, so the request carries the page's confirmation (`SERVICE_FIX_CONFIRM`).
 *
 * Offered only while the fleet's own pre-flight, run again right before the fix, still fails that check. The user is
 * the fleet's own (the pre-flight's deps), never one a request names.
 */
import type { PreflightCheck, ReadinessDeps, UpdatePreflight } from "./update-readiness.js";

export type UpdateFix = "linger" | "service";
export const UPDATE_FIXES: readonly UpdateFix[] = ["linger", "service"];
/** The body's `confirm` for "service": the page asked first (every Agent stops briefly). */
export const SERVICE_FIX_CONFIRM = "restart-as-service";

export function isUpdateFix(value: unknown): value is UpdateFix {
  return typeof value === "string" && (UPDATE_FIXES as readonly string[]).includes(value);
}

/** The fix a failing check offers, if the product can make it here. */
export function fixFor(check: PreflightCheck | null | undefined): UpdateFix | null {
  if (!check || check.ok !== false || check.id !== "P3") return null;
  return check.code === "linger-off" ? "linger" : check.code === "not-service" ? "service" : null;
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

/** Turn on lingering (the one fix made in place; "service" is the fleet's own `startServiceInstall`). */
export function applyUpdateFix(fix: "linger", d: Pick<ReadinessDeps, "platform" | "user" | "run" | "exists">): Promise<{ ok: boolean }> {
  switch (fix) {
    case "linger": return turnOnLinger(d);
  }
}

/**
 * What became of `agend install` once started: `restarting` — this fleet began to stop (the hand-over is under way);
 * `done` — it ended well with this fleet still up; `failed` — it refused or failed, `reason` its own words (nothing was
 * stopped, or the fleet was started again); `pending` — none of these within the wait (the page waits for the fleet).
 */
export type ServiceInstallResult = { kind: "restarting" | "done" | "pending" } | { kind: "failed"; reason: string };

export interface ServiceInstallWatch {
  /** The child's exit code once it has exited, else undefined (null: killed by a signal). */
  exitCode(): number | null | undefined;
  shuttingDown(): boolean;
  /** The command's own output since it started. */
  output(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  waitMs: number;
}

/** The refusal in the command's own words: its ✗/❌ lines, else its last line. */
export function serviceInstallReason(output: string): string {
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith("---"));
  const marked = lines.filter(l => /^(✗|❌)/.test(l)).map(l => l.replace(/^(✗|❌)\s*/, ""));
  const text = (marked.length ? marked.join(" ") : lines.at(-1) ?? "").slice(0, 400);
  return text || "agend install failed";
}

/**
 * Which known cause a refusal is, so the page can say it in the product's words (#4564 look), with the command's own words
 * after it as a detail: `user-manager` — the user's service manager can't be reached (systemd's "Failed to connect to bus",
 * agend install's own user@N.service lines, either language); anything else is `other`.
 */
export type ServiceInstallCause = "user-manager" | "other";
export function serviceInstallCause(reason: string): ServiceInstallCause {
  return /Failed to connect to bus|user@\d+\.service|\/run\/user\/\d+\/bus|service manager can't be reached|使用者服務管理員/i.test(reason) ? "user-manager" : "other";
}

export async function watchServiceInstall(w: ServiceInstallWatch): Promise<ServiceInstallResult> {
  const deadline = w.now() + w.waitMs;
  for (;;) {
    if (w.shuttingDown()) return { kind: "restarting" };
    const code = w.exitCode();
    if (code !== undefined) {
      // An exit while this fleet is already stopping is the hand-over itself.
      if (w.shuttingDown()) return { kind: "restarting" };
      return code === 0 ? { kind: "done" } : { kind: "failed", reason: serviceInstallReason(w.output()) };
    }
    if (w.now() >= deadline) return { kind: "pending" };
    await w.sleep(200);
  }
}
