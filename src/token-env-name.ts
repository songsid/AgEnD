/**
 * #1519 P1 (docs/design/ux-onboarding-walkthrough.md §5.2): the env var that holds a connection's bot token is
 * generated, never asked for — `AGEND_<PLATFORM>_<ID>_TOKEN`, upper-cased, the id reduced to [A-Z0-9_], a numeric
 * suffix on collision. A name is never one another connection holds, a provider key, a reserved shell name, or a key
 * already in the data dir's .env or this process's environment: a generated name only ever names a new value.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReservedProviderEnvKey, providerRegistryEnvKeys } from "./provider-secret-registry.js";

/** What a token env name must look like (fleet.yaml and the wizard). */
export const TOKEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

const sanitize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** `AGEND_<PLATFORM>_TOKEN` for the platform's own id, else `AGEND_<PLATFORM>_<ID>_TOKEN` (a leading "<platform>-" dropped). */
export function tokenEnvBase(platform: string, channelId: string): string {
  const p = sanitize(platform) || "BOT";
  const lowerId = channelId.toLowerCase(), lowerP = platform.toLowerCase();
  const rest = lowerId === lowerP ? "" : sanitize(lowerId.startsWith(`${lowerP}-`) ? channelId.slice(platform.length + 1) : channelId);
  const middle = rest ? `_${rest}` : "";
  // AGEND_ + P + middle + _TOKEN must fit 64 characters (with room for a "_99" suffix).
  const room = 64 - "AGEND_".length - p.length - "_TOKEN".length - 4;
  return `AGEND_${p}${middle.slice(0, Math.max(0, room)).replace(/_+$/, "")}_TOKEN`;
}

/** The base name, or with `_2`, `_3`… before `_TOKEN` until it is free. */
export function generateTokenEnvName(platform: string, channelId: string, taken: ReadonlySet<string>): string {
  const base = tokenEnvBase(platform, channelId);
  const free = (name: string) => !taken.has(name) && !isReservedProviderEnvKey(name);
  if (free(base)) return base;
  const stem = base.slice(0, -"_TOKEN".length);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}_${n}_TOKEN`;
    if (free(candidate)) return candidate;
  }
  throw new Error("no free token env name");
}

/** The .env could not be read, so which names it holds is unknown — never taken as "none" (#1529 review). */
export class EnvFileUnreadableError extends Error {
  constructor(cause: unknown) { super(`the data dir's .env cannot be read: ${(cause as Error)?.message ?? String(cause)}`); }
}

/** The names already in the data dir's .env (names only). No file: none. A file that cannot be read throws. */
export function envFileKeys(dataDir: string): Set<string> {
  let text: string;
  try { text = readFileSync(join(dataDir, ".env"), "utf-8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Set();
    throw new EnvFileUnreadableError(err);
  }
  return new Set(text.split("\n").map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]).filter((k): k is string => !!k));
}

/**
 * Why a GENERATED name (#1519 P1) can no longer be written, or null. A generated name only ever names a new value, so
 * at the write it must still be free of everything the plan avoided — another connection, a provider or reserved name,
 * a key in .env (read under the caller's lease), one in this process's environment. Throws when .env is unreadable.
 */
export function generatedTokenEnvStale(name: string, opts: { dataDir: string; channelEnvs: Iterable<string | null>; processEnv?: Iterable<string> }): string | null {
  const taken = takenTokenEnvNames({ channelEnvs: opts.channelEnvs, envFile: envFileKeys(opts.dataDir), processEnv: opts.processEnv ?? Object.keys(process.env) });
  if (taken.has(name) || isReservedProviderEnvKey(name)) return `${name} is no longer free (it was taken after this setup was planned) — plan it again`;
  return null;
}

/** Every name a new connection's token must not take. */
export function takenTokenEnvNames(opts: { channelEnvs: Iterable<string | null>; envFile?: Iterable<string>; processEnv?: Iterable<string> }): Set<string> {
  const taken = new Set<string>(providerRegistryEnvKeys());
  for (const name of opts.channelEnvs) if (name) taken.add(name);
  for (const name of opts.envFile ?? []) taken.add(name);
  for (const name of opts.processEnv ?? []) taken.add(name);
  return taken;
}

/**
 * Why `name` cannot be the token env of a NEW connection, or null. Only the names that would make it another holder's
 * value: another connection's, a provider key, a reserved shell name (a key merely present in .env is allowed when a
 * caller names it explicitly — the pre-fleet setup form and the CLI do).
 */
export function newTokenEnvConflict(name: string, channels: ReadonlyArray<{ id: string; token_env: string | null }>): string | null {
  if (!TOKEN_ENV_PATTERN.test(name)) return "token_env must be an UPPER_SNAKE env var name";
  if (isReservedProviderEnvKey(name) || providerRegistryEnvKeys().has(name)) return `${name} is reserved`;
  const owner = channels.find(channel => channel.token_env === name);
  if (owner) return `${name} already holds the token of the "${owner.id}" connection — a new connection never replaces one; use Replace token on that connection`;
  return null;
}
