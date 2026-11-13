import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadavg } from "node:os";
import { createHash } from "node:crypto";
const path = "src/hub/catalog.ts", original = readFileSync(path, "utf8"), out = ".artifacts/group-label-3824";
mkdirSync(out, { recursive: true });
const hash = s => createHash("sha256").update(s).digest("hex");
const mutants = [
  ["M1-projection", "groupGrantName(g.subject_label ?? g.subject)", "(g.subject_label ?? g.subject)"],
  ["M2-utf8", 'new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex.replaceAll("\\\\", ""), "hex"))', "hex"],
  ["M3-control", '!/[\\u0000-\\u001f\\u007f]/.test(name)', "true"],
  ["M4-person", 'n?.display_name ?? "", subjectLogin:', 'groupGrantName(n?.display_name ?? ""), subjectLogin:'],
];
const receipt = { original: hash(original), cases: [] };
try {
  for (const [id, before, after] of mutants) {
    if (loadavg()[0] > 10) throw Error("host load above10");
    if (original.split(before).length !== 2) throw Error(id + " replacement is not unique");
    const mutated = original.replace(before, after); writeFileSync(path, mutated);
    const types = spawnSync("./node_modules/@typescript/native/bin/tsc", ["--noEmit"], { encoding: "utf8" });
    writeFileSync(`${out}/${id}-types.log`, types.stdout + types.stderr); if (types.status !== 0) throw Error(id + " does not compile");
    const run = spawnSync("./node_modules/.bin/vitest", ["run", "--no-file-parallelism", "tests/hub-grant-subjects-m3016.test.ts",
      "-t", "projects group label|keeps a person's display name", "--reporter=json", "--outputFile", `${out}/${id}.json`], { encoding: "utf8" });
    writeFileSync(`${out}/${id}.log`, run.stdout + run.stderr);
    const result = JSON.parse(readFileSync(`${out}/${id}.json`, "utf8"));
    const failures = result.testResults.flatMap(t => t.assertionResults).filter(t => t.status === "failed");
    if (run.status !== 1 || !failures.length || result.testResults.some(t => t.message && !t.assertionResults.length)) throw Error(id + " did not fail semantically");
    receipt.cases.push({ id, mutated: hash(mutated), typeExit: types.status, testExit: run.status, failed: failures.map(t => t.fullName),
      passed: result.numPassedTests, failedCount: result.numFailedTests, pending: result.numPendingTests });
    writeFileSync(path, original);
  }
} finally {
  writeFileSync(path, original); receipt.restored = hash(readFileSync(path, "utf8")) === receipt.original;
  writeFileSync(`${out}/mutations.json`, JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt));
