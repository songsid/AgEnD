#!/usr/bin/env node
// M-3287: the UI gate's smokes, found on their own. A smoke under scripts/manual/smoke/ joins the gate with one line in
// its own file — no edit to .github/workflows/ci.yml (every new smoke used to be a hand-added step there, and four PRs
// in one day conflicted on that list):
//
//   // ui-gate: {"name": "Phone image viewer swipes", "hp": 19671}
//
//   name  what the run calls it (1–100 characters; a step's name before)
//   hp    the loopback port its fixture boots on (HP) — one per smoke, as each step had its own before
//
// Each runs as its own step did: tsx (`npx tsx <file>`) from the repo with PW_DIR / REPO (default: the checkout), OUT and
// FONTCONFIG_FILE as given, HP set; one after another, every one even when one before it failed; any failure fails the
// run. Fails closed: a marker that does not parse, an unknown key, a missing name or port, two smokes on one port, or no
// smoke at all is an error before anything runs.
//
//   node scripts/ci/ui-gate-smokes.mjs            run them all (CI: the ui-gate job's "UI gate smokes" step)
//   node scripts/ci/ui-gate-smokes.mjs --list     print what would run (name, port, file), run nothing
//   node scripts/ci/ui-gate-smokes.mjs --only smoke-chat-pins-m3271.mts [more…]   just those (by file name)
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const SMOKE_DIR = "scripts/manual/smoke";
const MARK = /^\/\/ ui-gate: (.*)$/;
const KEYS = new Set(["name", "hp"]);
// `npx tsx <file>`, as each step ran it: tsx's own CLI, from this checkout's devDependency (never a download).
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

/** Every smoke that declares itself, checked; or throws naming the file and what is wrong. Sorted by port, then file. */
export function discover(root = process.cwd()) {
  const dir = join(root, SMOKE_DIR), found = [], errors = [];
  for (const f of readdirSync(dir).filter((n) => /\.(mts|mjs|ts|js)$/.test(n)).sort()) {
    const file = join(SMOKE_DIR, f), lines = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => MARK.test(l));
    if (!lines.length) continue;
    if (lines.length > 1) { errors.push(`${file}: more than one "// ui-gate:" line`); continue; }
    let m;
    try { m = JSON.parse(MARK.exec(lines[0])[1]); } catch { errors.push(`${file}: the "// ui-gate:" line is not JSON`); continue; }
    if (!m || typeof m !== "object" || Array.isArray(m)) { errors.push(`${file}: the "// ui-gate:" line is not an object`); continue; }
    const extra = Object.keys(m).filter((k) => !KEYS.has(k));
    if (extra.length) { errors.push(`${file}: unknown key(s) ${extra.join(", ")} (name, hp)`); continue; }
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 100) { errors.push(`${file}: "name" must be 1–100 characters`); continue; }
    if (!Number.isInteger(m.hp) || m.hp < 1024 || m.hp > 65534) { errors.push(`${file}: "hp" must be a whole port number from 1024 to 65534`); continue; }
    found.push({ file, name: m.name.trim(), hp: m.hp });
  }
  // One port each (they run one after another, each fixture closed before the next boots, so neighbours may be adjacent).
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
    const a = found[i], b = found[j];
    if (a.hp === b.hp) errors.push(`${a.file} and ${b.file} both use hp ${a.hp}`);
  }
  if (!errors.length && !found.length) errors.push(`no smoke under ${SMOKE_DIR} has a "// ui-gate:" line`);
  if (errors.length) throw new Error(`ui-gate smokes:\n  ${errors.join("\n  ")}`);
  return found.sort((a, b) => a.hp - b.hp || (a.file < b.file ? -1 : 1));
}

function main(argv) {
  const root = process.cwd();
  let smokes;
  try { smokes = discover(root); } catch (err) { console.error(`::error title=UI gate smokes::${String(err.message).replace(/\n\s*/g, " · ")}`); console.error(err.message); return 2; }
  if (argv[0] === "--list") { for (const s of smokes) console.log(`${String(s.hp).padEnd(6)} ${s.name}  (${s.file})`); return 0; }
  if (argv[0] === "--only") {
    const want = new Set(argv.slice(1)), unknown = [...want].filter((w) => !smokes.some((s) => basename(s.file) === w));
    if (!want.size || unknown.length) { console.error(`--only: ${unknown.length ? `not a ui-gate smoke: ${unknown.join(", ")}` : "name at least one smoke file"}`); return 2; }
    smokes = smokes.filter((s) => want.has(basename(s.file)));
  } else if (argv.length) { console.error(`unknown argument ${argv[0]} (--list, --only <file>…)`); return 2; }
  const rows = [];
  for (const s of smokes) {
    console.log(`::group::${s.name} (${basename(s.file)}, HP ${s.hp})`);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [TSX, s.file], { cwd: root, stdio: "inherit",
      env: { ...process.env, PW_DIR: process.env.PW_DIR || root, REPO: process.env.REPO || root, HP: String(s.hp) } });
    const secs = Math.round((performance.now() - t0) / 1000), ok = r.status === 0;
    console.log("::endgroup::");
    if (!ok) console.log(`::error title=UI gate: ${s.name}::${s.file} ${r.signal ? `was killed (${r.signal})` : `exited ${r.status}`}`);
    console.log(`${ok ? "PASS" : "FAIL"} ${s.name} (${secs} s)`);
    rows.push({ ...s, ok, secs });
  }
  const failed = rows.filter((r) => !r.ok);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### UI gate smokes: ${rows.length - failed.length}/${rows.length} passed`, "",
        "| | Smoke | File | HP | Time |", "|---|---|---|---|---|",
        ...rows.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name.replace(/\|/g, "\\|")} | \`${basename(r.file)}\` | ${r.hp} | ${r.secs} s |`), ""].join("\n") + "\n");
    } catch { /* the summary is a convenience */ }
  }
  console.log(`ui-gate smokes: ${rows.length - failed.length}/${rows.length} passed${failed.length ? ` — failed: ${failed.map((r) => r.name).join("; ")}` : ""}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
export { main };
