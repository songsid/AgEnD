// Run only in an owned clean scratch checkout: REPO=<scratch worktree> node scripts/manual/skeleton-mutations.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const repo = resolve(process.env.REPO || "");
if (!process.env.REPO || spawnSync("git", ["diff", "--quiet"], { cwd: repo }).status !== 0) throw new Error("set REPO to a clean owned scratch checkout");
const out = join(repo, ".artifacts/skeleton-mutations"); mkdirSync(out, { recursive: true });
const mutations = [
  ["hub-session-first-read", "src/ui/panel-hub.js", "let body = tab === \"ask\" ? roomParam() ? html`<${HubRoomLoading} />`\n    : html`<${PanelHeader} title=${hc(\"chats\")} /><div class=\"hub-home\"><${Skeleton} variant=\"rows\" lines=${4} /></div>`\n    : html`<${Skeleton} variant=\"rows\" lines=${4} />`;", "let body = null;"],
  ["room-history-first-read", "src/ui/hub-chat-store.js", 'loaded: false, error: null, pending:', 'loaded: true, error: null, pending:'],
  ["refresh-keeps-activity", "src/ui/panel-hub.js", 'setData((old) => ({ ...old, error }))', 'setData({ error })'],
  ["unknown-membership", "src/ui/settings-hub-membership.js", 'html`<${Skeleton} variant="rows" lines=${2} label=${copy("loading")} />`', 'html`<p>Loading</p>`'],
  ["pairing-failure-ends", "src/ui/settings-hub.js", 'if (!p) body = readError ?', 'if (!p) body = false ?'],
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
    const run = spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "tests/skeleton-hub-3290.test.ts", "--maxWorkers=2", "--reporter=json", `--outputFile=${json}`], { cwd: repo, encoding: "utf8" });
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
