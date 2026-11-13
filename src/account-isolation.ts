/**
 * AGEND-119: the proof that a CLI told its account by an argument really keeps each folder's sign-in in that folder. Antigravity keeps its sign-in in the system's keyring unless the registry's `pin` makes it use
 * the account's file, and the keyring is one for every folder: a sign-in run where the pin does not hold REPLACES another account's login. So before a login command runs, the CLI is asked (`agy <folder argument> models`,
 * with the pin) about a SCRATCH folder that is empty by construction: only "signed out" proves the pin holds. Never the account's own folder: one that already has a token file (a re-login) proves nothing about a
 * CLI that has stopped honouring the pin since, and the folder is deleted when the probe is over.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProfileLaunchAt } from "./backend/credential-profile.js";
import type { AuthCheckResult } from "./login-flows.js";

/** True only when the CLI answered "signed out" for an empty scratch folder under the launch of an account. A probe that could not answer is asked once more; still no answer: not proven. */
export async function proveFolderIsolation(
  backend: string,
  check: (launch: { env: Record<string, string>; args: string[] }) => Promise<AuthCheckResult>,
  scratchRoot: string = tmpdir(),
): Promise<boolean> {
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(scratchRoot, "agend-isolation-"));
    const launch = credentialProfileLaunchAt(backend, scratch);
    if (!launch) return false;
    let answer = await check(launch);
    if (answer === "unknown") answer = await check(launch);
    return answer === "invalid";
  } catch { return false; }
  finally {
    if (scratch) {
      // The CLI's background updater can write into its folder a moment after the probe has answered (measured: an `updater` folder appeared after the first removal), so it is removed again shortly after.
      const remove = () => { try { rmSync(scratch!, { recursive: true, force: true }); } catch { /* a temp folder */ } };
      remove();
      const again = setTimeout(remove, 3_000); again.unref?.();
    }
  }
}
