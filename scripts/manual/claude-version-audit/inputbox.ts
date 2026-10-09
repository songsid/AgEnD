import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
const b = new ClaudeCodeBackend("/nonexistent-audit");
function walk(p: string): string[] { return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(f => walk(join(p, f))) : [p]; }
for (const f of process.argv.slice(2).flatMap(walk)) {
  const box = b.readInputRow?.(readFileSync(f, "utf8"));
  console.log(f.split("/cap/")[1].replace(/^29[24]-/, "").replace(/\/29[24]\//, "/").padEnd(34), JSON.stringify(box));
}
