import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Liveness of an instance's MCP server, derived from `channel.mcp.pid`.
 *
 * The MCP server writes that file at startup and unlinks it on a clean exit, so:
 * - **dead**    → file present but the pid is gone: it died without cleaning up
 *                 (crash / OOM / SIGKILL). This is the incident worth reporting.
 * - **unknown** → no file, or an unusable value: not started yet, or exited
 *                 cleanly. Never alarm on this, or every startup would alert.
 * - **alive**   → the pid responds to signal 0 (EPERM counts as alive: the
 *                 process exists but is owned by another user).
 */
export type McpServerState =
  | { state: "alive"; pid: number }
  | { state: "dead"; pid: number }
  | { state: "unknown" };

export function mcpServerState(instanceDir: string): McpServerState {
  let raw: string;
  try {
    raw = readFileSync(join(instanceDir, "channel.mcp.pid"), "utf-8").trim();
  } catch {
    return { state: "unknown" };
  }
  const pid = Number.parseInt(raw, 10);
  // Reject non-numeric, init, and anything unsafe — a bad pid must never be
  // reported as "dead" (that would be a false alarm) nor signalled.
  if (!Number.isSafeInteger(pid) || pid <= 1 || String(pid) !== raw.replace(/^\+/, "")) {
    return { state: "unknown" };
  }
  try {
    process.kill(pid, 0);
    return { state: "alive", pid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return { state: "alive", pid };
    return { state: "dead", pid };
  }
}
