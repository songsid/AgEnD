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
import { createRequire } from "node:module";

interface AllowScripts { FLAG: string; ENV: string; flagFor(spec: string): string; installCommand(spec?: string): string; covers(value: unknown): boolean; withPackage(value: unknown): string; scriptsIgnored(value: unknown): boolean }
const require = createRequire(import.meta.url);
/** M-3805: the one place that says how npm 12 is told to run AgEnD's install scripts (shared with the launcher). */
export const npmAllowScripts = require("../launcher/npm-allow-scripts.cjs") as AllowScripts;
interface GlobalPrefix { MASK: string; ASK: string[]; masked(text: unknown): boolean; lastLine(text: unknown): string; rootOf(prefix: string, platform?: string): string; resolve(prefixOut: string, rootOut: string | undefined, ask: () => string, platform?: string): { prefix: string; root?: string } }
/** M-3806: npm 11/12 print `***` for a UUID in the global prefix; this asks again the way npm tells a child. */
export const npmGlobalPrefix = require("../launcher/npm-global-prefix.cjs") as GlobalPrefix;

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

const ALLOW_SCRIPTS_KEY = "allow-scripts";

/**
 * M-3805: npm 12 runs a package's install scripts only when `allow-scripts` names it, and skipped, AgEnD's postinstall
 * never proves the bundled Node: the new version then refuses to start. Every npm the update starts inherits this
 * variable, also through `npm exec` (a flag does not reach the program it starts), so the release's own installer and
 * its `npm install -g` run the scripts, whichever release that installer comes from. What the person allows in .npmrc
 * is kept in the value; a variable the person set is theirs and is left alone (the installer passes its own flag).
 * npm 8–11 accept the variable and run scripts anyway. Recorded in the marker, so it ends with the update like the bounds.
 */
export function applyUpdateAllowScripts(env: NodeJS.ProcessEnv, explicit: Map<string, string> | null): boolean {
  const name = envName(ALLOW_SCRIPTS_KEY);
  if (env[name] !== undefined || env[name.toUpperCase()] !== undefined) return false;
  const theirs = explicit?.get(ALLOW_SCRIPTS_KEY);
  if (npmAllowScripts.covers(theirs)) return false;
  env[name] = npmAllowScripts.withPackage(theirs);
  const ours = String(env[UPDATE_NPM_MARKER] ?? "").split(",").filter(Boolean);
  if (!ours.includes(ALLOW_SCRIPTS_KEY)) ours.push(ALLOW_SCRIPTS_KEY);
  env[UPDATE_NPM_MARKER] = ours.join(",");
  return true;
}

/**
 * M-3805: is npm set to skip every install script (`ignore-scripts`)? That overrides any allow list, on every npm, so the
 * new version's install step would not run and it would not start. From what `npm config ls` listed (which includes an
 * npm_config_* variable), or, when npm could not be asked, the variable itself.
 */
export function updateScriptsIgnored(env: NodeJS.ProcessEnv, explicit: Map<string, string> | null): boolean {
  if (explicit) return npmAllowScripts.scriptsIgnored(explicit.get("ignore-scripts"));
  const name = envName("ignore-scripts");
  return npmAllowScripts.scriptsIgnored(env[name] ?? env[name.toUpperCase()]);
}

/** What `agend update` says and stops on when npm is set to skip install scripts. */
export function scriptsIgnoredStop(): string {
  return "  npm is set to skip install scripts (ignore-scripts), so the new version's install step would not run and AgEnD would\n"
    + "  not start. Nothing was changed. Turn it off (and unset npm_config_ignore_scripts if it is set), then update again:\n"
    + "    npm config delete ignore-scripts";
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
  if (ours.includes(ALLOW_SCRIPTS_KEY)) delete env[envName(ALLOW_SCRIPTS_KEY)];
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
