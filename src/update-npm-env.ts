/**
 * M-2797: bound how long npm keeps trying while `agend update` runs (chat /update, the web Update button and the shell
 * alike). npm's own defaults wait up to 5 minutes for a silent connection and retry it twice with up to a minute in
 * between, per request, so with the network gone an update sat at "downloading" until the network came back. These are
 * npm's own settings, so a slow network that keeps delivering still succeeds: `fetch-timeout` is how long a connection
 * may stay SILENT (no byte at all) and how long npm waits for a response to start, never a cap on a whole download.
 *
 * They are lowered only where npm still has its own default: a value the person set (`.npmrc`, `npm config set`, an
 * `npm_config_*` variable) is theirs and is kept, e.g. a slow proxy's longer timeout. Every npm the update starts after
 * this (the version lookup, the preflight, the release's own installer and its `npm install -g`) inherits them through
 * the environment, so there is one place that says how long npm may try, not one per call.
 */

/** npm's defaults (npm 10 config definitions), and what an update uses instead while they are unchanged. */
export const UPDATE_NPM_BOUNDS = Object.freeze([
  // [npm key, npm's default, the update's value]
  ["fetch-timeout", "300000", "30000"],
  ["fetch-retries", "2", "1"],
  ["fetch-retry-mintimeout", "10000", "2000"],
  ["fetch-retry-maxtimeout", "60000", "10000"],
] as const);

const envName = (key: string): string => `npm_config_${key.replace(/-/g, "_")}`;

/** The `npm config get` argv that reads every bounded key at once (local config only, no network). */
export function npmBoundsQuery(): string[] {
  return ["config", "get", ...UPDATE_NPM_BOUNDS.map(([key]) => key)];
}

/**
 * Parse `npm config get a b c` output (`a=1` lines; one key alone prints just its value) into key → value. Anything
 * that does not parse is left out: an unknown value is treated as npm's default.
 */
export function parseNpmConfigGet(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^([a-z-]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * Add the bounds to `env` (the update's own process environment, inherited by every npm it starts) for each key that
 * is still npm's default: not set in the environment, and `configured` (what `npm config get` answered, null when it
 * could not be asked) reads npm's default or nothing. Returns the keys it set.
 */
export function applyUpdateNpmBounds(env: NodeJS.ProcessEnv, configured: Map<string, string> | null): string[] {
  const set: string[] = [];
  for (const [key, npmDefault, bounded] of UPDATE_NPM_BOUNDS) {
    const name = envName(key);
    if (env[name] !== undefined || env[name.toUpperCase()] !== undefined) continue;     // the person's own variable
    const now = configured?.get(key);
    if (now !== undefined && now !== "" && now !== "undefined" && now !== npmDefault) continue;   // the person's .npmrc
    env[name] = bounded;
    set.push(key);
  }
  return set;
}
