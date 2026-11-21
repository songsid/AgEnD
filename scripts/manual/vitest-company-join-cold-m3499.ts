/** Fault control: delay the real cold transform; never changes the test/hook budgets. */
import { defineConfig } from "vitest/config";
import { unitTestConfig } from "../../vitest.config.js";
const base = unitTestConfig("");
export default defineConfig({ ...base, plugins: [{ name: "company-join-cold-transform-control", enforce: "pre", async transform(_source, id) {
  if (id.split("?")[0].endsWith("/src/hub/member/pairing-api.ts")) await new Promise(resolve => setTimeout(resolve, 11_000));
  return null;
} }], test: { ...base.test, include: ["tests/hub-company-join-restart.test.ts"], fileParallelism: false, maxWorkers: 1 } });
