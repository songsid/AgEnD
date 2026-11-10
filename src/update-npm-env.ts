/**
 * M-2797: bound how long npm keeps trying while `agend update` runs (chat /update, the web Update button and the shell
 * alike). npm's own defaults wait up to 5 minutes for a silent connection and retry it twice with up to a minute in
 * between, per request, so with the network gone an update sat at "downloading" until the network came back. These are
 * npm's own settings, so a slow network that keeps delivering still succeeds: `fetch-timeout` is how long a connection
 * may stay SILENT (no byte at all) and how long npm waits for a response to start, never a cap on a whole download.
 *
 * They are set only for keys nobody set: a value the person set (`.npmrc`, `npm config set`, an `npm_config_*` variable,
 * a flag) is theirs and is kept whatever it is, e.g. a slow proxy's longer timeout. Every npm the update starts after
 * this (the version lookup, the preflight, the release's own installer and its `npm install -g`) inherits them through
 * the environment, so there is one place that says how long npm may try, not one per call.
 */

/** What an update uses while the person has not set the key themselves (npm's own defaults: 300000 / 2 / 10000 / 60000). */
export const UPDATE_NPM_BOUNDS = Object.freeze([
  ["fetch-timeout", "30000"],
  ["fetch-retries", "1"],
  ["fetch-retry-mintimeout", "2000"],
  ["fetch-retry-maxtimeout", "10000"],
] as const);

const envName = (key: string): string => `npm_config_${key.replace(/-/g, "_")}`;

/**
 * The `npm config ls` argv (local config only, no network): it lists exactly the keys someone SET — in a user, global or
 * project .npmrc, an npm_config_* variable or the command line — whatever their value (Prism #3543: a key set to npm's
 * own default value is still the person's choice), and never npm's defaults (that is `-l`).
 */
export function npmConfigQuery(): string[] {
  return ["config", "ls"];
}

/**
 * Parse `npm config ls` into key → value for every key in force that someone set. Comment lines (`;` — the source
 * headers, the facts at the end, and a value another source overrides) are left out; a quoted value is unquoted.
 */
export function parseNpmConfigLs(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const m = /^(\S+) = (.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.startsWith('"')) { try { value = String(JSON.parse(value)); } catch { /* as written */ } }
    out.set(m[1]!, value);
  }
  return out;
}

/**
 * Add the bounds to `env` (the update's own process environment, inherited by every npm it starts) for each key nobody
 * set: not in the environment, and not in `explicit` (what `npm config ls` listed; null when npm could not be asked, then
 * nothing is known to be set). Returns the keys it set.
 */
export function applyUpdateNpmBounds(env: NodeJS.ProcessEnv, explicit: Map<string, string> | null): string[] {
  const set: string[] = [];
  for (const [key, bounded] of UPDATE_NPM_BOUNDS) {
    const name = envName(key);
    if (env[name] !== undefined || env[name.toUpperCase()] !== undefined) continue;     // the person's own variable
    if (explicit?.has(key)) continue;                                                    // the person's .npmrc / cli
    env[name] = bounded;
    set.push(key);
  }
  if (set.length) env[UPDATE_NPM_MARKER] = set.join(",");
  return set;
}

/**
 * Prism #3543: the registry AgEnD's own package comes from — the `@songsid` scope's registry when one is set, else the
 * registry, else npm's default — so the ping asks the registry the update will use, never an unrelated default. Null when
 * npm's config could not be read: then nothing is pinged and the update goes on as before.
 */
export function updateRegistry(explicit: Map<string, string> | null): string | null {
  if (!explicit) return null;
  return explicit.get("@songsid:registry") || explicit.get("registry") || "https://registry.npmjs.org/";
}

/**
 * Fable #3544 F1: which npm settings the UPDATE put in its environment (never a person's own), so they end with the update.
 * `agend update` restarts the fleet, and a detached `fleet start` copies the environment it was started with: without
 * this the long-running fleet, and every npm it starts later (the next update included, which would then read them as
 * the person's), would keep the update's bounds and override a later `.npmrc`.
 */
export const UPDATE_NPM_MARKER = "AGEND_UPDATE_NPM_BOUNDS";

/** Take out of `env`, in place, exactly the npm settings the update set (named by its marker), and the marker. */
export function dropUpdateNpmBounds(env: NodeJS.ProcessEnv): void {
  const ours = String(env[UPDATE_NPM_MARKER] ?? "").split(",");
  for (const [key] of UPDATE_NPM_BOUNDS) if (ours.includes(key)) delete env[envName(key)];
  delete env[UPDATE_NPM_MARKER];
}

/** A copy of `env` without the update's own npm settings: what anything that outlives the update is started with. */
export function withoutUpdateNpmBounds(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  dropUpdateNpmBounds(copy);
  return copy;
}

/**
 * M-2797 (rig): is the registry unreachable, by `npm ping`'s answer? `npm ping` asks the registry itself and never a
 * cache: with the network gone, npm otherwise answers a version lookup from its stale cache, and the install then fails
 * as "No matching version found" (ETARGET), which reads as anything but the network. Only a failure that IS the network
 * (no name lookup, refused, reset, unreachable, a timeout) counts: a registry that does not implement ping (an error
 * status, E404 and the like) or an npm that could not run says nothing, and the update goes on as before.
 * Returns npm's own error code line for the message, or null.
 */
export function registryUnreachable(ping: { status: number | null; stderr?: string | null; error?: Error }): string | null {
  if (ping.status === 0 || ping.error) return null;
  const lines = String(ping.stderr ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const code = lines.map(l => /^npm (?:ERR!|error) code (\S+)/i.exec(l)?.[1]).find(Boolean);
  const network = /^(?:E(?:NOTFOUND|AI_AGAIN|TIMEDOUT|CONNREFUSED|CONNRESET|NETUNREACH|HOSTUNREACH|IDLETIMEOUT|CONNECTIONTIMEOUT|RESPONSETIMEOUT|TRANSFERTIMEOUT)|FETCH_ERROR)$/;
  return code && network.test(code) ? `npm error code ${code}` : null;
}

/**
 * Fable #3544 F2: what `agend update` says and stops on when `npm ping` shows the registry unreachable, or null to go on.
 * The caller records it as the update's failure and returns before the version lookup.
 */
export function registryStop(ping: { status: number | null; stderr?: string | null; error?: Error }): string | null {
  const unreachable = registryUnreachable(ping);
  return unreachable ? `  ✗ Could not reach the update source (${unreachable}). Nothing was changed; the current version keeps running.` : null;
}
