/** Read-only lookup of an exact AgEnD release, using the npm that manages this install. */
import { promisify } from "node:util";
import { execFile } from "../child-process.js";
import { npmEnvForUpdate } from "../update-dispatch.js";
import { isExactVersion } from "../update-check.js";
export type PublishedVersionResult = "found" | "not-found" | "unavailable";
export type PublishedVersionLookup = (version: string) => Promise<PublishedVersionResult>;
export function createPublishedVersionLookup(): PublishedVersionLookup {
  const pending = new Map<string, Promise<PublishedVersionResult>>();
  const run = promisify(execFile);
  return version => {
    if (version !== version.trim() || version.length > 128 || !isExactVersion(version)) return Promise.resolve("not-found");
    const known = pending.get(version); if (known) return known;
    if (pending.size >= 4) return Promise.resolve("unavailable");
    const task = (async (): Promise<PublishedVersionResult> => {
      try {
        const npm = await npmEnvForUpdate(); if (!npm.ok) return "unavailable";
        const { stdout } = await run("npm", ["view", `@songsid/agend@${version}`, "version", "--json"],
          { env: npm.env, timeout: 15_000, maxBuffer: 16 * 1024 });
        const received: unknown = JSON.parse(stdout.toString());
        return received === version.replace(/^v/, "") ? "found" : "not-found";
      } catch (error) {
        return /\bE404\b|\bETARGET\b/.test(String((error as { stderr?: unknown }).stderr ?? "")) ? "not-found" : "unavailable";
      }
    })();
    pending.set(version, task); void task.finally(() => pending.delete(version)); return task;
  };
}
