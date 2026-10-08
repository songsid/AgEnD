import { afterAll, afterEach } from "vitest";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { processGuard, scrubTestEnvironment } from "./support/process-guard.js";

scrubTestEnvironment(process.env);
// Worker-private journal also catches a violation swallowed by a Node child.
process.env.AGEND_TEST_GUARD_LOG = join(process.env.AGEND_TEST_GUARD_DIR!, `worker-${process.pid}-${threadId}.log`);
function assertNoUnsafeProcesses(): void {
  const violations = processGuard.takeViolations();
  if (violations.length) throw new Error(violations.join("\n"));
}
afterEach(assertNoUnsafeProcesses);
afterAll(assertNoUnsafeProcesses); // includes import/collection and final cleanup
