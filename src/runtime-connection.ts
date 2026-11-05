/** Public connection defaults only; paired credentials stay in the private runtime profile. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeClientStore, validateRuntimeServer } from "./runtime-client-store.js";

export const RUNTIME_SERVER_FILE = "agend-server.json";
export const RUNTIME_CONNECT_BAT = '@echo off\r\nsetlocal\r\nnode.exe "%~dp0dist\\runtime-cli.js" connect\r\nset "AGEND_EXIT=%errorlevel%"\r\necho.\r\nif not "%AGEND_EXIT%"=="0" (\r\n  echo AgEnD Runtime stopped or could not connect. Read the message above for what to do next.\r\n) else (\r\n  echo AgEnD Runtime stopped.\r\n)\r\npause\r\n';
export function runtimeServerOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 2048) throw Error("Invalid AgEnD server address");
  return validateRuntimeServer(value).origin;
}
export function readBundledRuntimeServer(directory = join(dirname(fileURLToPath(import.meta.url)), "..")): string | undefined {
  let fd: number;
  try { fd = openSync(join(directory, RUNTIME_SERVER_FILE), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw Error("Cannot read bundled AgEnD connection information"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw Error("Invalid bundled AgEnD connection information");
    const bytes = Buffer.alloc(4097); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 4096) throw Error("Bundled AgEnD connection information is too large");
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "server") || !("server" in value)) throw Error("Invalid bundled AgEnD connection information");
    return runtimeServerOrigin(value.server);
  } catch { throw Error("Invalid agend-server.json. Re-download the Runtime or use connect --server with an explicit AgEnD address."); } finally { closeSync(fd); }
}
/** Folder name for one server inside the default profile, e.g. `fleet.example.test-8445`; stable so the same bat finds it again. */
export function runtimeProfileName(origin: string): string {
  const url = validateRuntimeServer(origin);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = url.hostname.replace(/[^a-z0-9.-]/g, "_");
  return host === url.hostname ? `${host}-${port}` : `${host}-${port}-${createHash("sha256").update(url.origin).digest("hex").slice(0, 8)}`;
}
export function runtimeServerProfile(base: string, origin: string): string { return join(base, "profiles", runtimeProfileName(origin)); }
/** Reads only the public server address of a profile; a profile that does not exist is not created. */
export function readStoredRuntimeServer(directory: string): string | undefined {
  return existsSync(join(directory, "connection.json")) ? new RuntimeClientStore(directory).credentials()?.server : undefined;
}
/**
 * Picks the profile when neither --profile nor AGEND_RUNTIME_HOME was given. Without a bundled server the default profile is used.
 * With one, the default profile is kept while it is unpaired or already paired to that server; once it belongs to another server the
 * per-server profile is used instead, so no profile's credentials are ever aimed at a different server.
 * Commands other than connect only look for an existing per-server profile, so run/status/rotate/disconnect land where connect paired.
 */
export function chooseRuntimeProfile(base: string, bundled: string | undefined, forConnect: boolean,
  stored: (directory: string) => string | undefined = readStoredRuntimeServer): { directory: string; separate: boolean; defaultServer?: string } {
  if (!bundled) return { directory: base, separate: false };
  const defaultServer = stored(base), own = runtimeServerProfile(base, bundled);
  if (defaultServer !== undefined && runtimeServerOrigin(defaultServer) === bundled) return { directory: base, separate: false, defaultServer };
  if (stored(own) !== undefined) return { directory: own, separate: true, defaultServer };
  if (defaultServer === undefined || !forConnect) return { directory: base, separate: false, defaultServer };
  return { directory: own, separate: true, defaultServer };
}
/** `explicitProfile` is the --profile the user passed: the follow-up commands must name it again, not fall back to the default profile. */
export function resolveRuntimeServer(explicit: string | undefined, bundled: string | undefined, stored: string | undefined, profileHint?: string, explicitProfile?: string): string {
  const target = explicit ?? bundled ?? stored;
  if (!target) throw Error("No AgEnD address is configured. Download a connection-ready Runtime or use connect --server https://your-agend-host");
  const origin = runtimeServerOrigin(target);
  if (stored && runtimeServerOrigin(stored) !== origin) {
    const profile = profileHint ?? runtimeServerProfile("%USERPROFILE%\\.agend-runtime", origin);
    throw Error(`This profile is paired with ${runtimeServerOrigin(stored)}, but this connection is for ${origin}. Its credentials will not be sent to the new server.\n`
      + `  Keep both: .\\agend-runtime.cmd connect --server ${origin} --profile "${profile}"\n`
      + `    (then pass the same --profile to run, status, rotate and disconnect)\n`
      + (explicitProfile
        ? `  Replace the old pairing: .\\agend-runtime.cmd disconnect --profile "${explicitProfile}", then .\\agend-runtime.cmd connect --server ${origin} --profile "${explicitProfile}".`
        : `  Replace the old pairing: .\\agend-runtime.cmd disconnect, then connect again.`));
  }
  return origin;
}
