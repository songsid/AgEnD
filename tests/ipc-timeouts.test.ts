import { describe, expect, it } from "vitest";
import {
  DEFAULT_IPC_BUDGET_MS,
  SLOW_IPC_BUDGET_MS,
  SLOW_TOOLS,
  VERY_SLOW_IPC_BUDGET_MS,
  VERY_SLOW_TOOLS,
  daemonBudgetMs,
  mcpTimeoutMs,
} from "../src/channel/ipc-timeouts.js";

// Every tool call has two independent timers: the MCP server arms one BEFORE
// sending, the daemon arms its own ON RECEIPT. With both at 30s the outer one always
// fired first, so every specific daemon message ("Schedule operation timed out
// after 30s", "Cross-instance operation timed out after 30s", …) was unreachable and
// the agent only ever saw the generic "IPC request timed out after 30000ms".

describe("the MCP ceiling is strictly above the daemon budget", () => {
  const tools = [
    "reply",                 // default
    ...SLOW_TOOLS,           // window + CLI spawn
    ...VERY_SLOW_TOOLS,      // unbounded work
    "some_unknown_future_tool",
  ];

  it.each(tools)("%s: mcpTimeoutMs > daemonBudgetMs", tool => {
    expect(mcpTimeoutMs(tool)).toBeGreaterThan(daemonBudgetMs(tool));
  });

  it("leaves enough headroom for transport and scheduling", () => {
    for (const tool of tools) {
      expect(mcpTimeoutMs(tool) - daemonBudgetMs(tool)).toBeGreaterThanOrEqual(10_000);
    }
  });
});

describe("budgets by tool class", () => {
  it("gives an ordinary tool the default budget", () => {
    // reply moved to SLOW_TOOLS (Discord rate-limit stalls exceed 30s while the
    // send still succeeds — the timeout-then-retry made duplicate replies).
    expect(daemonBudgetMs("react")).toBe(DEFAULT_IPC_BUDGET_MS);
  });

  it("gives instance-spawning tools the slow budget", () => {
    for (const tool of SLOW_TOOLS) {
      expect(daemonBudgetMs(tool)).toBe(SLOW_IPC_BUDGET_MS);
    }
  });

  it("gives deployment and worktree tools the very-slow budget", () => {
    // deploy_template creates instances serially, each spawning a CLI; checkout_repo
    // runs `git worktree add` on a repo of any size. Under the default budget these
    // timed out on any real workload while the work kept running — the agent was
    // told it failed and deploy_template's rollback never fired, leaving a
    // half-built fleet.
    for (const tool of ["deploy_template", "teardown_deployment", "checkout_repo"]) {
      expect(daemonBudgetMs(tool)).toBe(VERY_SLOW_IPC_BUDGET_MS);
    }
  });

  it("orders the three classes", () => {
    expect(DEFAULT_IPC_BUDGET_MS).toBeLessThan(SLOW_IPC_BUDGET_MS);
    expect(SLOW_IPC_BUDGET_MS).toBeLessThan(VERY_SLOW_IPC_BUDGET_MS);
  });

  it("treats an unknown tool as ordinary rather than throwing", () => {
    expect(daemonBudgetMs("tool_added_next_year")).toBe(DEFAULT_IPC_BUDGET_MS);
    expect(mcpTimeoutMs("tool_added_next_year")).toBeGreaterThan(DEFAULT_IPC_BUDGET_MS);
  });

  it("keeps the two tool classes disjoint", () => {
    for (const tool of SLOW_TOOLS) expect(VERY_SLOW_TOOLS.has(tool)).toBe(false);
  });
});
