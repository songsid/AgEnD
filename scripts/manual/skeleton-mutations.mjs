// Run only in an owned clean scratch checkout: REPO=<scratch worktree> node scripts/manual/skeleton-mutations.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const repo = resolve(process.env.REPO || "");
if (!process.env.REPO || spawnSync("git", ["diff", "--quiet"], { cwd: repo }).status !== 0) throw new Error("set REPO to a clean owned scratch checkout");
const out = join(repo, ".artifacts/skeleton-mutations"); mkdirSync(out, { recursive: true });
const mutations = [
  ["decorative-bars", "src/ui/shared/ui-states.js", '<div aria-hidden="true">', "<div>"],
  ["content-rows", "src/ui/shared/ui-states.js", 'variant === "rows" || variant === "cards"', "false"],
  ["needs-first-read", "src/ui/panel-needs.js", "(!ready || needsLoaded === false) && !items.length", "false"],
  ["notice-read-failure", "src/ui/shared/app-store.js", '.catch(() => { store.set({ noticesError: true }); return false; })', ".catch(() => false)"],
  ["cancelled-search", "src/ui/shared/app-shell.js", '(m) => { if (mine === searchOpen && shellStore.get().dialog?.Component === SearchLoading) showDialog', '(m) => { if (true) showDialog'],
];
const results = [];
for (const [name, path, before, after] of mutations) {
  const file = join(repo, path), original = readFileSync(file, "utf8");
  if (original.split(before).length !== 2) throw new Error(`${name}: mutation seam is not unique`);
  try {
    writeFileSync(file, original.replace(before, after));
    const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (syntax.status !== 0) throw new Error(`${name}: invalid mutant ${syntax.stderr}`);
    const json = join(out, `${name}.json`);
    const run = spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "tests/skeleton-loading-3290.test.ts", "--maxWorkers=2", "--reporter=json", `--outputFile=${json}`], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(out, `${name}.log`), run.stdout + run.stderr);
    const report = JSON.parse(readFileSync(json, "utf8"));
    const failed = report.testResults.flatMap(x => x.assertionResults).filter(x => x.status === "failed");
    const caught = run.status !== 0 && failed.some(x => x.failureMessages.some(m => /AssertionError|expected/.test(m)));
    results.push({ name, syntax: "PASS", caught, failed: failed.map(x => x.fullName) });
    console.log(`${name}: ${caught ? "CAUGHT" : "SURVIVED / INVALID FAILURE"}`);
  } finally { writeFileSync(file, original); }
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
if (spawnSync("git", ["diff", "--quiet"], { cwd: repo }).status !== 0) throw new Error("scratch source was not restored");
if (results.some(x => !x.caught)) process.exitCode = 1;
