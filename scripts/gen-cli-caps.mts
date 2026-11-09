/**
 * Regenerates `src/ui/cli-caps.js` from the CLI registry (src/cli-registry.ts): `npx tsx scripts/gen-cli-caps.mts`. Run it after changing a spec; tests/cli-registry-ui-caps.test.ts
 * fails while the file is out of date. `--check` only compares (exit 1 when it differs), for a pre-commit or CI step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCliCapsModule } from "../src/cli-caps-module.js";

const target = fileURLToPath(new URL("../src/ui/cli-caps.js", import.meta.url));
const wanted = renderCliCapsModule();
let current = "";
try { current = readFileSync(target, "utf8"); } catch { /* not written yet */ }
if (process.argv.includes("--check")) {
  if (current !== wanted) { console.error("src/ui/cli-caps.js is out of date: run `npx tsx scripts/gen-cli-caps.mts`."); process.exit(1); }
  console.log("src/ui/cli-caps.js is up to date.");
} else if (current === wanted) {
  console.log("src/ui/cli-caps.js is already up to date.");
} else {
  writeFileSync(target, wanted);
  console.log("Wrote src/ui/cli-caps.js.");
}
