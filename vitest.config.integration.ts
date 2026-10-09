import { defineConfig } from "vitest/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { scrubEnvironment } = createRequire(import.meta.url)("./tests/support/process-guard.cjs");
scrubEnvironment(process.env);

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
    globalSetup: ["./tests/setup-process-guard-global.ts"],
    setupFiles: ["./tests/setup-process-guard.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    include: [
      "tests/web-terminal-integration.test.ts",
      "tests/mcp-slot-collision.test.ts",
      "tests/cli-env-probe-guard.test.ts",
      "tests/tmux-manager.test.ts",
      "tests/tmux-control-native-1401.test.ts",
      // Each of these starts a real tmux SERVER, not just a client call:
      // `new-session` on an isolated socket, or TmuxTerminalBackend.start().
      // A file moves here whole, because fileParallelism is per file — the
      // unit tests that share the file come along, which is cheaper than
      // splitting them out and losing the context they sit in.
      "tests/tmux-kill-window-confirmed.test.ts",
      "tests/view-api.test.ts",
      "tests/web-terminal-socket-cleanup.test.ts",
      "tests/e2e-tri-state.test.ts",
    ],
    exclude: [
      "**/node_modules/**", "dist/**", ".worktrees/**", ".claude/worktrees/**",
      // Deliberate real-backend tests have a separate, explicit opt-in runner.
      "tests/codex-exact-cwd-resume-e2e.test.ts",
      "tests/codex-status-line-e2e.test.ts",
    ],
    env: {
      PATH: process.env.PATH ?? "",
      AGEND_HOME: testAgendHome,
      NOTIFY_SOCKET: "",
      AGEND_TEST_GUARD_DIR: testAgendHome,
    },
  },
});
