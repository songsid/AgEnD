import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = name => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
const integration = read("vitest.config.integration.ts");
const unit = read("vitest.config.ts");

// Every suite that owns a real tmux server or child process. Each must be in
// the serial config AND out of the parallel one: a file listed in both runs
// twice, in parallel with itself, which is the contention this pool exists to
// remove — and it would look like a flake, not like a config mistake.
const required = [
  "tests/web-terminal-integration.test.ts",
  "tests/mcp-slot-collision.test.ts",
  "tests/cli-env-probe-guard.test.ts",
  "tests/tmux-manager.test.ts",
  "tests/tmux-kill-window-confirmed.test.ts",
  "tests/view-api.test.ts",
  "tests/web-terminal-socket-cleanup.test.ts",
];

const problems = [];
for (const file of required) {
  const quoted = `"${file}"`;
  if (!integration.includes(quoted)) problems.push(`${file} is missing from the integration config's include`);
  if (!unit.includes(quoted)) problems.push(`${file} is missing from the unit config's exclude, so it also runs in parallel`);
}
if (!integration.includes("fileParallelism: false")) problems.push("fileParallelism: false is missing from the integration config");

if (problems.length > 0) {
  console.error(problems.map(p => `  - ${p}`).join("\n"));
  process.exit(1);
}
