import { readdirSync } from "node:fs";
import { join } from "node:path";
import { processGuard } from "./support/process-guard.js";

/** Catch collection-only/skipped suites and late child failures after hooks. */
export default function setup(project: { config: { env: Record<string, string> } }) {
  const directory = project.config.env.AGEND_TEST_GUARD_DIR;
  return () => {
    const violations = processGuard.takeViolations().concat(readdirSync(directory).filter(file => file.startsWith("worker-") && file.endsWith(".log"))
      .flatMap(file => processGuard.drainJournal(join(directory, file))));
    if (violations.length) {
      // Vitest may print a teardown error yet exit zero for an all-skipped
      // file. A collection-only native violation must still fail the run.
      process.exitCode = 1;
      throw new Error(violations.join("\n"));
    }
  };
}
