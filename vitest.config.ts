import { defineConfig } from "vitest/config";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { scrubEnvironment } = createRequire(import.meta.url)("./tests/support/process-guard.cjs");
scrubEnvironment(process.env);

// Never let tests fall back to the operator's real ~/.agend. Besides config and
// state files, AGEND_HOME namespaces production tmux getters. TmuxManager
// can still have a null socket; the native process guard enforces isolation.
const testAgendHome = mkdtempSync(join(tmpdir(), "agend-vitest-"));
process.once("exit", () => {
  rmSync(testAgendHome, { recursive: true, force: true });
});

export default defineConfig({
  // #1408: the web app's modules import each other by the URLs the server serves them at — /assets/<name> is
  // src/ui/shared/<name> (the fixed asset map, flat names), /ui/js/<name> is src/ui/<name>. Tests resolve them the same.
  resolve: {
    alias: [
      { find: /^\/assets\/([a-z0-9._-]+)$/, replacement: `${fileURLToPath(new URL("./src/ui/shared/", import.meta.url))}$1` },
      { find: /^\/ui\/js\/([a-z0-9_-]+\.js)$/, replacement: `${fileURLToPath(new URL("./src/ui/", import.meta.url))}$1` },
    ],
  },
  // The vendored Preact/htm files end with a sourceMappingURL to maps we do not ship (vendor/vendor.json keeps the
  // files byte-identical); without this, vite logs a missing-map error for each. Tests read the bytes from disk.
  plugins: [{
    name: "vendored-without-source-maps",
    enforce: "pre",
    load(id: string) {
      if (/[\\/]src[\\/]ui[\\/]shared[\\/](preact|preact-hooks|htm)\.module\.js$/.test(id)) return readFileSync(id, "utf8").replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, "\n");
      return null;
    },
  }],
  test: {
    globals: true,
    globalSetup: ["./tests/setup-process-guard-global.ts"],
    setupFiles: ["./tests/setup-process-guard.ts"],
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
      // e2e has its own config (e2e/vitest.config.e2e.ts): 120s timeouts, one file
      // at a time, and it boots real tmux fleets on fixed ports. Swept in here it
      // ran under this config's 10s timeout, in parallel — slow and flaky. Run it
      // deliberately with `npm run test:e2e`.
      "e2e/**",
      // These suites own real tmux/child-process resources. They run in a
      // dedicated, serial invocation so the normal unit suite can stay
      // parallel without scheduler contention making CI nondeterministic.
      "tests/web-terminal-integration.test.ts",
      "tests/mcp-slot-collision.test.ts",
      "tests/cli-env-probe-guard.test.ts",
      "tests/tmux-manager.test.ts",
      "tests/tmux-control-native-1401.test.ts",
      "tests/tmux-kill-window-confirmed.test.ts",
      "tests/view-api.test.ts",
      "tests/web-terminal-socket-cleanup.test.ts",
      "tests/e2e-tri-state.test.ts",
      // Opt-in (AGEND_CODEX_E2E=1): real codex CLI on a private tmux socket.
      "tests/codex-exact-cwd-resume-e2e.test.ts",
      "tests/codex-status-line-e2e.test.ts",
    ],
    env: {
      PATH: process.env.PATH ?? "",
      AGEND_HOME: testAgendHome,
      // Never the operator's kiro stores (#906): its conversation store sits in the same file as the login, and kiro
      // launch planning reads it. Tests that need a store build one under their own scratch directory.
      XDG_DATA_HOME: join(testAgendHome, "xdg-data"),
      KIRO_HOME: join(testAgendHome, "kiro-home"),
      // Test FleetManager.stopAll() calls sdNotify("STOPPING=1"). When tests are
      // launched from an agent inside the production systemd cgroup, inheriting
      // its NOTIFY_SOCKET would tell systemd to stop the real fleet.
      NOTIFY_SOCKET: "",
      AGEND_TEST_GUARD_DIR: testAgendHome,
    },
  },
});
