/**
 * IPC reconnect backoff for the per-instance MCP server.
 *
 * Kept in its own module because mcp-server.ts runs `main()` on import (it is a
 * CLI entrypoint) — importing it from a test would exit the process.
 *
 * There is deliberately NO give-up: the MCP server used to stop after
 * 20 × 3s = 60s, but a fleet restart routinely takes longer (142s measured on a
 * fleet with ~2k tasks), and an exited MCP server cannot be respawned mid-session
 * by its client — the agent silently loses every agend tool until the user
 * restarts the CLI. Idle retries cost ~nothing (one unix-socket connect), and the
 * server's orphan check still terminates it when its own CLI goes away.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Delay before reconnect attempt N (1-based): 1s, 2s, 4s, 8s, 16s, then 30s forever. */
export function reconnectDelayMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt, 1) - 1, 5);
  return Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_MAX_MS);
}
