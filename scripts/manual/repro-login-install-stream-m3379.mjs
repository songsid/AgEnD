/** Run once against a prepared checkout: the base fails, the completion-signal fixture passes. No retries. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(process.argv[2] || fileURLToPath(new URL("../../", import.meta.url)));
const out = resolve(process.env.OUT || join(repo, ".artifacts/login-install-stream-m3379/repro"));
mkdirSync(out, { recursive: true });
const env = { ...process.env, AGEND_TEST_LATE_VERDICT: "1" };
for (const key of ["TMUX", "TMUX_PANE", "AGEND_TMUX"]) delete env[key];
const preload = new URL("./fixtures/login-install-late-frame-m3379.mjs", import.meta.url).href;
env.NODE_OPTIONS = [env.NODE_OPTIONS || "", `--import=${preload}`].join(" ").trim();
const report = join(out, "result.json");
const result = spawnSync(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "tests/login-install-stream-2980.test.ts", "-t", "in a tmux window", "--maxWorkers=2", "--reporter=json", `--outputFile=${report}`], { cwd: repo, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status === null) throw Error(`fixture runner ended by ${result.signal}`);
const summary = JSON.parse(readFileSync(report, "utf8"));
if (summary.numPassedTests + summary.numFailedTests !== 1) throw Error("the intended tmux fixture did not run exactly once");
process.exitCode = result.status;
