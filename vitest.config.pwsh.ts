import { defineConfig } from "vitest/config";
import { unitTestConfig } from "./vitest.config.js";
import { PWSH_CI_SUITES } from "./tests/support/pwsh-ci-suites.js";

/** Dedicated runner: keep private guards/environment and existing case budgets. */
export function pwshTestConfig() {
  const base = unitTestConfig("");
  return defineConfig({
    ...base,
    test: {
      ...base.test,
      include: [...PWSH_CI_SUITES],
      fileParallelism: false,
      maxWorkers: 1,
    },
  });
}
export default pwshTestConfig();
