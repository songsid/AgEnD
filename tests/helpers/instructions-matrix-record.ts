// Records tests/fixtures/instructions-matrix.json after a reviewed instruction-contract change. Preserve the parameter
// axes and verify the intended text delta first: npx tsx tests/helpers/instructions-matrix-record.ts > tests/fixtures/instructions-matrix.json
import { createHash } from "node:crypto";
import { buildFleetInstructions, buildNativeFleetInstructions } from "../../src/instructions.js";
import { matrixCases } from "./instructions-matrix.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const golden: Record<string, string> = {};
for (const { key, params } of matrixCases()) {
  golden[`fleet|${key}`] = sha(buildFleetInstructions(params));
  golden[`native|${key}`] = sha(buildNativeFleetInstructions(params, false));
  golden[`native-general|${key}`] = sha(buildNativeFleetInstructions(params, true));
}
process.stdout.write(JSON.stringify(golden, null, 0) + "\n");
