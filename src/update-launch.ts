/** Chat updates must survive the fleet's service cgroup being stopped (#1490 row 37). */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { updateCommand } from "./update-dispatch.js";

export interface UpdateLaunchDeps {
  platform: string;
  cgroup(): Promise<string>;
  version(): Promise<string | null>;
  nonce(): string;
}

export const defaultUpdateLaunchDeps: UpdateLaunchDeps = {
  platform: process.platform,
  cgroup: async () => {
    const started = performance.now();
    const result = await readFile("/proc/self/cgroup", { encoding: "utf8", signal: AbortSignal.timeout(2000) });
    if (performance.now() - started >= 2000) throw Error("cgroup read deadline");
    return result;
  },
  version: async () => {
    const started = performance.now();
    try {
      const { stdout } = await promisify(execFile)("systemd-run", ["--version"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
      });
      return performance.now() - started < 2000 ? stdout : null;
    } catch { return null; }
  },
  nonce: () => randomBytes(16).toString("hex"),
};

/** Unknown is not proof that a detached child can escape a service's KillMode. */
export function inServiceCgroup(text: string): boolean | null {
  if (!text || text.length > 64 * 1024 || text.includes("\0")) return null;
  const rows = text.trimEnd().split("\n");
  let service = false;
  for (const row of rows) {
    const parsed = /^(\d+):([^:]*):(\/[^\r\n]*)$/.exec(row);
    if (!parsed || parsed[3].split("/").some(part => part === "." || part === "..")) return null;
    // user@UID.service is the user manager itself, not a fleet stop boundary.
    service ||= parsed[3].split("/").some(part => part.endsWith(".service") && !/^user@\d+\.service$/.test(part));
  }
  return service;
}

export type UpdateLaunch = { ok: true; command: string; args: string[]; scope?: string }
  | { ok: false; reason: string };

/** Same UID, no privileged or remote manager, no credentials in argv. No unsafe detached fallback. */
export async function resolveUpdateLaunch(agend: string, deps: UpdateLaunchDeps = defaultUpdateLaunchDeps): Promise<UpdateLaunch> {
  const plain = updateCommand(agend);
  if (deps.platform !== "linux") return { ok: true, ...plain };
  let before: string;
  try { before = await deps.cgroup(); }
  catch { return { ok: false, reason: "cannot read the fleet's service cgroup" }; }
  const service = inServiceCgroup(before);
  if (service === null) return { ok: false, reason: "cannot identify the fleet's service cgroup" };
  if (!service) return { ok: true, ...plain };
  let version: string | null;
  try { version = await deps.version(); } catch { version = null; }
  const major = /^systemd (\d+)\b/.exec(version ?? "")?.[1];
  if (!major || Number(major) < 240) return { ok: false, reason: "cannot verify a supported systemd-run for an independent updater scope" };
  // v254 introduced --expand-environment. Older scope implementations pass argv literally.
  // Newer versions must explicitly disable expansion: both "$1" and the installed path are data.
  const expansion = Number(major) >= 254 ? ["--expand-environment=no"] : [];
  const nonce = deps.nonce();
  if (!/^[a-f0-9]{32}$/.test(nonce)) return { ok: false, reason: "cannot allocate an updater scope identity" };
  try {
    if (await deps.cgroup() !== before) return { ok: false, reason: "the fleet's service cgroup changed during update preparation" };
  } catch { return { ok: false, reason: "cannot recheck the fleet's service cgroup" }; }
  const scope = `agend-updater-${nonce}.scope`;
  return { ok: true, command: "systemd-run", scope, args: [
    "--user", "--scope", "--quiet", "--collect", "--no-ask-password", `--unit=${scope}`,
    ...expansion, "--", plain.command, ...plain.args,
  ] };
}

/** Spawn/manager refusal and nonzero updater exit are visible; exit 75 is the existing pending hand-off. */
export function watchUpdateLaunch(child: Pick<import("node:child_process").ChildProcess, "once">, fail: (message: string) => void): void {
  let reported = false;
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    fail(`/update could not complete (${reason}). Run \`agend update\` from a host shell.`);
  };
  child.once("error", () => report("updater launch failed"));
  child.once("exit", (code, signal) => {
    if (signal || (code !== 0 && code !== 75)) report(signal ? "updater was interrupted" : `updater exited ${code ?? "without a status"}`);
  });
}
