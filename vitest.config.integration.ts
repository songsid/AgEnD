import { defineConfig } from "vitest/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real-resource suites are deliberately kept in one worker. Running them
// beside one another makes tmux/child-process scheduling part of the test
// result, while the normal unit suite remains file-parallel.
const testAgendHome = mkdtempSync(join(tmpdir(), "agend-vitest-integration-"));
process.once("exit", () => {
  rmSync(testAgendHome, { recursive: true, force: true });
});

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    include: [
      "tests/web-terminal-integration.test.ts",
      "tests/mcp-slot-collision.test.ts",
      "tests/cli-env-probe-guard.test.ts",
      "tests/tmux-manager.test.ts",
    ],
    exclude: ["**/node_modules/**", "dist/**", ".worktrees/**", ".claude/worktrees/**"],
    env: {
      PATH: process.env.PATH ?? "",
      AGEND_HOME: testAgendHome,
      NOTIFY_SOCKET: "",
    },
  },
});
