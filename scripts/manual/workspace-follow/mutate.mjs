// Each semantic mutant must compile and fail an assertion. Restore the exact source after every probe/signal.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const unit = "tests/workspace-follow-3160.test.ts", stream = "tests/workspace-follow-stream-3160.test.ts", ui = "tests/workspace-follow-panel-3160.test.ts", route = "tests/workspace-follow-route-3160.test.ts";
const cases = [
  ["ordered-tools", "src/transcript-sources.ts", "for (const observation of codexFollowRecords(entry))", "if (false) for (const observation of codexFollowRecords(entry))", stream],
  ["search-option-values", "src/workspace-follow-parse.ts", 'if (!w.includes("=") && ++i >= words.length) return null;', 'if (false) return null;', unit],
  ["shell-cwd", "src/workspace-follow.ts", 'const cwd = s.cwd === undefined ? ws.root : resolve(ws.root, s.cwd);', 'const cwd = ws.root;', unit],
  ["launch-scope", "src/workspace-follow.ts", 'turn !== this.turnNo || (scope !== undefined && scope !== this.scope)', 'turn !== this.turnNo', stream],
  ["same-daemon", "src/web-api.ts", '(op === "follow" && ctx.daemons.get(instance) !== daemon)', 'false', route],
  ["session-recheck", "src/web-api.ts", 'if (localAdmin()?.handle !== who.handle) { json(res, 403, { error: "workspace_needs_a_local_admin" }); return; }', '/* session recheck removed */', route],
  ["backend-gate", "src/web-api.ts", 'const supported = backend === "claude-code" || backend === "codex";', 'const supported = true;', route],
  ["secret-hidden", "src/workspace-follow.ts", 'hidden: isHiddenPath(place.rel)', 'hidden: false && isHiddenPath(place.rel)', unit],
  ["exact-edit-lines", "src/workspace-follow.ts", 'step.kind === "edit" && event.editLines ?', 'step.kind === "read" && event.editLines ?', stream],
  ["manual-race", "src/ui/workspace-panel.js", 'if (!valid(mine, automatic)) return;\n    const hl =', '/* stale automatic response accepted */\n    const hl =', ui],
  ["default-off", "src/ui/workspace-panel.js", 'if (follow === "off") return undefined;', 'if (false && follow === "off") return undefined;', ui],
  ["hidden-poll", "src/ui/workspace-panel.js", 'if (stopped || busy || (typeof document !== "undefined" && document.hidden)) return;', 'if (stopped || busy) return;', ui],
  ["launch-recheck", "src/web-api.ts", 'frame.supported && frame.running && frame.scope && live?.workspaceFollow?.(0).scope !== frame.scope', 'false', route],
  ["unproven-copy", "src/transcript-monitor.ts", 'if (event[0] === "workspace_follow" && this.historyBefore > 0 && !Number.isFinite(at)) return;', '/* unproven copied file activity accepted */', stream],
  ["search-pattern-sentinel", "src/workspace-follow-parse.ts", 'const explicitPattern = ["-e", "-f", "--regexp", "--file"].some(flag => options.has(flag));', 'const explicitPattern = args.some(w => w.startsWith("-e") || w.startsWith("--regexp"));', unit],
  ["search-files-sentinel", "src/workspace-follow-parse.ts", 'const filesOnly = options.has("--files");', 'const filesOnly = args.includes("--files");', unit],
];
const out = ".artifacts/workspace-follow-mutations"; mkdirSync(out, { recursive: true });
const selected = process.argv.length > 2 ? cases.filter(([name]) => process.argv.slice(2).includes(name)) : cases;
if (!selected.length) throw Error("No selected mutants");
const previous = process.argv.length > 2 && existsSync(`${out}/results.json`) ? JSON.parse(readFileSync(`${out}/results.json`, "utf8")) : [];
const results = []; let restore = () => {};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { restore(); process.exit(143); });
for (const [name, file, before, after, test] of selected) {
  const original = readFileSync(file, "utf8");
  if (original.split(before).length !== 2) throw Error(`${name}: expected exactly one target`);
  restore = () => writeFileSync(file, original);
  try {
    writeFileSync(file, original.replace(before, after));
    const compile = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8", timeout: 120000 });
    const syntax = file.endsWith(".js") ? spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }) : { status: 0, stdout: "", stderr: "" };
    writeFileSync(`${out}/${name}.compile.log`, (compile.stdout || "") + (compile.stderr || "") + (syntax.stdout || "") + (syntax.stderr || ""));
    let status = "INVALID_BUILD";
    if (compile.status === 0 && syntax.status === 0 && !compile.error) {
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", test, "--maxWorkers=1"], { encoding: "utf8", timeout: 120000 });
      const log = (run.stdout || "") + (run.stderr || ""); writeFileSync(`${out}/${name}.test.log`, log);
      status = !run.error && run.status !== null && run.status !== 0 && /AssertionError/.test(log) && !/Transform failed|No test files found/.test(log) ? "KILLED" : "SURVIVED_OR_INVALID";
    }
    results.push({ name, status }); console.log(JSON.stringify(results.at(-1)));
  } finally {
    restore(); restore = () => {};
    const merged = new Map(previous.map(r => [r.name, r])); for (const r of results) merged.set(r.name, r);
    writeFileSync(`${out}/results.json`, JSON.stringify([...merged.values()], null, 2) + "\n");
  }
}
if (results.length !== selected.length || results.some(r => r.status !== "KILLED")) process.exitCode = 1;
