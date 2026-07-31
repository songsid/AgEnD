/**
 * IPC timeout budgets, shared by the daemon (which owns the work) and the MCP
 * server (which waits on it).
 *
 * There are two independent timers on every tool call: the MCP server arms one
 * BEFORE sending, and the daemon arms its own ON RECEIPT. With both set to 30s the
 * outer one always fired first, so every carefully worded daemon message —
 * "Schedule operation timed out after 30s", "Cross-instance operation timed out
 * after 30s", "Task operation timed out after 30s", "Fleet outbound timed out after
 * 30s" — was unreachable, and the agent always saw the generic
 * "IPC request timed out after 30000ms" instead.
 *
 * The invariant this module exists to hold: the MCP ceiling is strictly larger than
 * the daemon's budget for the same tool, so the specific message always wins the
 * race. Deriving both from one table is what keeps them from drifting apart again.
 */

/** Tools that spawn a tmux window and a CLI before they can answer. */
export const SLOW_TOOLS: ReadonlySet<string> = new Set([
  "start_instance",
  "create_instance",
  "delete_instance",
  "replace_instance",
]);

/**
 * Tools that do unbounded work: deploy_template creates instances serially, each
 * spawning a window and a CLI; checkout_repo runs `git worktree add` against a repo
 * of any size. Under the generic 30s budget these timed out on any real workload
 * while the operation kept running in the background — so the agent was told it had
 * failed, and deploy_template's rollback never triggered, leaving a half-built
 * fleet behind.
 */
export const VERY_SLOW_TOOLS: ReadonlySet<string> = new Set([
  "deploy_template",
  "teardown_deployment",
  "checkout_repo",
]);

export const DEFAULT_IPC_BUDGET_MS = 30_000;
export const SLOW_IPC_BUDGET_MS = 60_000;
export const VERY_SLOW_IPC_BUDGET_MS = 300_000;

/** Headroom for the MCP ceiling over the daemon's budget: transport plus scheduling. */
export const MCP_TIMEOUT_MARGIN_MS = 15_000;

/** How long the daemon gives the fleet to answer for this tool. */
export function daemonBudgetMs(tool: string): number {
  if (VERY_SLOW_TOOLS.has(tool)) return VERY_SLOW_IPC_BUDGET_MS;
  if (SLOW_TOOLS.has(tool)) return SLOW_IPC_BUDGET_MS;
  return DEFAULT_IPC_BUDGET_MS;
}

/**
 * How long the MCP server waits for the daemon. Always strictly greater than
 * `daemonBudgetMs(tool)`, so the daemon's specific error message reaches the agent
 * rather than being pre-empted by the generic client-side one.
 */
export function mcpTimeoutMs(tool: string): number {
  return daemonBudgetMs(tool) + MCP_TIMEOUT_MARGIN_MS;
}
