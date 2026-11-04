/** Public connection defaults only; paired credentials stay in the private runtime profile. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRuntimeServer } from "./runtime-client-store.js";

export const RUNTIME_SERVER_FILE = "agend-server.json";
export const RUNTIME_CONNECT_BAT = '@echo off\r\nnode.exe "%~dp0dist\\runtime-cli.js" connect\r\nif errorlevel 1 (\r\n  echo.\r\n  echo AgEnD Runtime could not connect. Review the message above.\r\n  pause\r\n)\r\n';
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
export function resolveRuntimeServer(explicit: string | undefined, bundled: string | undefined, stored: string | undefined): string {
  const target = explicit ?? bundled ?? stored;
  if (!target) throw Error("No AgEnD address is configured. Download a connection-ready Runtime or use connect --server https://your-agend-host");
  const origin = runtimeServerOrigin(target);
  if (stored && runtimeServerOrigin(stored) !== origin) throw Error("This profile is paired with another server. Use another --profile; its credentials will not be sent to the new server.");
  return origin;
}
