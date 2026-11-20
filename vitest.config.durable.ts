import { defineConfig } from "vitest/config";
import { unitTestConfig } from "./vitest.config.js";
import { DURABLE_CI_SUITES } from "./tests/support/durable-ci-suites.js";

/** Keep real FULL/WAL, fsync, crypto and listeners; change only their CI scheduling. */
export function durableTestConfig() {
  const base = unitTestConfig("");
  return defineConfig({ ...base, test: { ...base.test,
    include: [...DURABLE_CI_SUITES], fileParallelism: false, maxWorkers: 1,
  } });
}
export default durableTestConfig();
