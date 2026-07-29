import { defineConfig } from "vitest/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never let tests fall back to the operator's real ~/.agend. Besides config and
// state files, AGEND_HOME also namespaces the tmux session/socket, so one
// per-run directory isolates every destructive lifecycle path.
const testAgendHome = mkdtempSync(join(tmpdir(), "agend-vitest-"));
process.once("exit", () => {
  rmSync(testAgendHome, { recursive: true, force: true });
});

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: [
      "**/node_modules/**",
      // dist is a build artifact. Its copies of the test files don't change
      // when src does, so leaving them in means every suite runs 26 duplicate
      // tests and, eventually, someone chases a "dist fails but src passes"
      // ghost. Test the source.
      "dist/**",
      ".worktrees/**",
      ".claude/worktrees/**",
    ],
    env: {
      PATH: process.env.PATH ?? "",
      AGEND_HOME: testAgendHome,
      // Test FleetManager.stopAll() calls sdNotify("STOPPING=1"). When tests are
      // launched from an agent inside the production systemd cgroup, inheriting
      // its NOTIFY_SOCKET would tell systemd to stop the real fleet.
      NOTIFY_SOCKET: "",
    },
  },
});
