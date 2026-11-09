/** Non-secret onboarding hints. Never used as proof that credentials work. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { hostFacts, hostIdsByRank, type HostCliWith } from "./cli-registry.js";
import type { StructuredBackend } from "./structured-signin.js";

/** The CLIs the first-run page offers a sign-in for, in its order (cli-registry.ts: `host.firstRunSignIn`). */
export type OnboardingBackend = HostCliWith<"firstRunSignIn">;
export const ONBOARDING_BACKENDS: readonly OnboardingBackend[] = Object.freeze(hostIdsByRank("firstRunSignIn") as OnboardingBackend[]);
/** Those it signs in with browser controls, and those it only names the console command for. */
export const ONBOARDING_BROWSER_BACKENDS: readonly (OnboardingBackend & StructuredBackend)[] = Object.freeze(ONBOARDING_BACKENDS.filter(id => hostFacts(id, "firstRunSignIn")!.mode === "browser") as Array<OnboardingBackend & StructuredBackend>);
export const ONBOARDING_CONSOLE_BACKENDS: readonly OnboardingBackend[] = Object.freeze(ONBOARDING_BACKENDS.filter(id => hostFacts(id, "firstRunSignIn")!.mode === "console"));
export interface PendingBackendSignIns { version: 1; selected: OnboardingBackend[]; pending: OnboardingBackend[] }
export function onboardingBackends(value: unknown): OnboardingBackend[] | null {
  if (!Array.isArray(value) || value.length > ONBOARDING_BACKENDS.length || value.some(v => typeof v !== "string"
    || !(ONBOARDING_BACKENDS as readonly string[]).includes(v))) return null;
  return [...new Set(value)] as OnboardingBackend[];
}
export function readPendingBackendSignIns(dataDir: string): PendingBackendSignIns {
  const empty: PendingBackendSignIns = { version: 1, selected: [], pending: [] };
  let fd: number | undefined;
  try {
    fd = openSync(join(dataDir, "backend-signin-pending.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) return empty;
    const buffer = Buffer.alloc(4097);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 4096) return empty;
    const parsed = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    const selected = onboardingBackends(parsed.selected), pending = onboardingBackends(parsed.pending);
    if (parsed.version !== 1 || !selected || !pending || pending.some(v => !selected.includes(v))) return empty;
    return { version: 1, selected, pending };
  } catch { return empty; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function writePendingBackendSignIns(dataDir: string, value: PendingBackendSignIns): void {
  const selected = onboardingBackends(value.selected), pending = onboardingBackends(value.pending);
  if (!selected || !pending || pending.some(v => !selected.includes(v))) throw new Error("invalid_signin_checklist");
  atomicWriteFileSync(join(dataDir, "backend-signin-pending.json"), JSON.stringify({ version: 1, selected, pending }) + "\n", { mode: 0o600 });
}
