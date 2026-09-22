import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("../vitest.config.integration.ts", import.meta.url));
const config = readFileSync(configPath, "utf8");
const required = [
  "tests/web-terminal-integration.test.ts",
  "tests/mcp-slot-collision.test.ts",
  "tests/cli-env-probe-guard.test.ts",
  "tests/tmux-manager.test.ts",
];
const missing = required.filter(file => !config.includes(`\"${file}\"`));
if (!config.includes("fileParallelism: false")) missing.push("fileParallelism: false");
if (missing.length > 0) {
  console.error(`integration test config is missing: ${missing.join(", ")}`);
  process.exit(1);
}
