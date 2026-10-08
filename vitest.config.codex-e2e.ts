import { defineConfig } from "vitest/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This runner intentionally permits the real Codex CLI. It is never selected
// by unit/integration/CI; both the command and the opt-in flag are required.
if (process.env.AGEND_CODEX_E2E !== "1") {
  throw new Error("Real Codex tests require AGEND_CODEX_E2E=1 npm run test:codex-e2e");
}
for (const key of Object.keys(process.env)) {
  if (/(?:_TOKEN$|_BOT_)/i.test(key)) delete process.env[key];
}
const testHome = mkdtempSync(join(tmpdir(), "agend-vitest-codex-e2e-"));
process.once("exit", () => rmSync(testHome, { recursive: true, force: true }));

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    include: [
      "tests/codex-exact-cwd-resume-e2e.test.ts",
      "tests/codex-status-line-e2e.test.ts",
    ],
    exclude: ["**/node_modules/**", "dist/**", ".worktrees/**", ".claude/worktrees/**"],
    env: {
      PATH: process.env.PATH ?? "",
      AGEND_HOME: testHome,
      NOTIFY_SOCKET: "",
    },
  },
});
