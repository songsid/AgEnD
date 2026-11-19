#!/usr/bin/env node
// M-3357: the iPhone keyboard regression suite. Each beta fixed one keyboard bug and brought back another, so every
// past case is listed here once: its card or PR, the unit tests and WebKit smokes that pin it, and a "revert" (the fix
// undone in the code as it is now) that must turn its tests red. docs/dev/iphone-keyboard-suite.md is the human view
// (which cases need a real iPhone or the iOS Simulator).
//
//   node scripts/ci/keyboard-suite.mjs --list               the cases, their tests and smokes
//   node scripts/ci/keyboard-suite.mjs --touches [files…]   "true" when a keyboard file changed (files from argv, or the
//                                                           BASE_SHA...HEAD_SHA diff; no diff readable = true); with
//                                                           GITHUB_OUTPUT set, writes run=true|false there
//   node scripts/ci/keyboard-suite.mjs --unit               every listed unit test passes (each one found and run)
//   node scripts/ci/keyboard-suite.mjs --reverts [ids…]     each case's fix undone, alone: at least one of its listed tests
//                                                           fails (the file is always put back, on Ctrl+C or SIGTERM too)
//   node scripts/ci/keyboard-suite.mjs --smokes [files…]    the smokes, one after another, PW_ENGINE as set (CI: webkit in
//                                                           the pinned Playwright image), each on its own port
//
// The manifest's integrity (files, test titles, each revert's text found exactly once) is pinned on every PR by
// tests/keyboard-suite-m3357.test.ts; CI's keyboard-suite job runs --unit, --reverts and the WebKit smokes when a PR
// touches the keyboard's code (KEYBOARD_PATHS).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The keyboard's code: a change to any of these runs the whole suite (and so does a change to the suite itself). */
export const KEYBOARD_PATHS = [
  /^src\/ui\/shared\/app-shell\.js$/,          // the shell's keyboard detector and fit (kb-open, the view, the pan)
  /^src\/ui\/shared\/app\.css$/,               // kb-open / data-kb-closing rules, 100dvh, the dock
  /^src\/ui\/app\.html$/,                      // the viewport meta (interactive-widget)
  /^src\/ui\/shared\/chat-composer\.js$/,      // the composer's box: IME ownership, its height
  /^src\/ui\/panel-chat\.js$/,                 // the Fleet chat's composer
  /^src\/ui\/hub-room-composer\.js$/,          // the Hub's composer
  /^src\/ui\/shared\/text-undo\.js$/,          // document listeners that read the box's selection
  /^src\/ui\/shared\/chat-quote\.js$/,
  /^src\/ui\/shared\/app\.js$/,                // installs text-undo's document listeners, mounts the Shell
  /^src\/ui\/panel-hub\.js$/,                 // the Hub conversation's quote listeners
  /^src\/ui\/chat-workspace\.js$/,            // the desktop panes' quote listeners
  /^scripts\/ci\/keyboard-suite\.mjs$/,
  /^tests\/helpers\/(mini-dom|app-harness)\.ts$/, // the harness every case runs on: a change could make the suite pass for nothing
  /^package(-lock)?\.json$/,                    // vitest, tsx, playwright-core
  /^tests\/(web-keyboard-2478|web-keyboard-fit-3111|web-typing-steady-m3265|web-composer-2478|web-ime-composition-m3356|keyboard-suite-m3357)\.test\.ts$/,
  /^scripts\/manual\/smoke\/(smoke-ime-composition|smoke-phone-kb-steady|smoke-phone-ime-keyboard-m3244|smoke-phone-typing-steady-m3265|smoke-phone-keyboard-motion-m3327)\.mts$/,
  /^scripts\/manual\/smoke-fixture\//,
  /^\.github\/workflows\/ci\.yml$/,
];

const SHELL = "src/ui/shared/app-shell.js", COMPOSER = "src/ui/shared/chat-composer.js";
const T2478 = "tests/web-keyboard-2478.test.ts", T3111 = "tests/web-keyboard-fit-3111.test.ts";
const T3265 = "tests/web-typing-steady-m3265.test.ts", TCOMP = "tests/web-composer-2478.test.ts";
const T3356 = "tests/web-ime-composition-m3356.test.ts";

/**
 * Every past case. `tests`: file → titles (it(...) as written) that pin it; `smokes`: the WebKit smokes (and their
 * cases) that show it in the real app; `revert`: the fix undone, as an exact text swap in today's code — `from` must be
 * found exactly once; with it applied at least one of `tests` fails.
 */
export const CASES = [
  { id: "tabs-over-keyboard", refs: ["#2478"], what: "With the keyboard up, the bottom tabs and the line under the composer sat between the box and the keyboard; innerHeight shrinks with the view on iOS, so it is no measure.",
    tests: { [T2478]: ["innerHeight stays, the visual viewport shrinks — kb-open while typing; back at once on blur",
      "innerHeight shrinks with the view (iOS Safari; Android under resizes-content) — still the keyboard: the old innerHeight − height test saw 0, the strips stayed"] },
    // No smoke: smoke-2478-keyboard measured the tabs in an agent's chat, which M-3115 (#3911) took away; retired (M-3362).
    smokes: [],
    revert: { file: SHELL, from: "if (!held) tallest = Math.max(tallest, window.innerHeight || 0, typing ? 0 : h);", to: "if (!held) tallest = window.innerHeight || 0;" } },
  { id: "candidate-bar-flips-tabs", refs: ["#2517"], what: "An IME's candidate bar crossing the keyboard threshold took the tabs out and back on every keystroke.",
    tests: { [T2478]: ["a compact keyboard (120 px) whose candidate bar (44 px) crosses the threshold: up once, it stays up on every keystroke; blur takes it down",
      "M-3357: the compact keyboard's bar gone for longer than #4011's 300 ms hold (a pause between words): still up"] },
    smokes: [{ file: "smoke-ime-composition.mts", cases: ["compact keyboard"] }],
    revert: { file: SHELL, from: "if (!up && was && typing && h - upLowest <= KEYBOARD_MIN_PX) up = true;", to: "" } },
  { id: "composition-without-end", refs: ["#2517"], what: "A composition that never sent compositionend (the field left or removed) kept the keyboard state frozen.",
    tests: { [T2478]: ["#2517 review: a composition that ends without compositionend (the field left) holds nothing after — focus and the view are heard again",
      "#2517 review: the composing field removed from the page holds nothing after"] },
    smokes: [],
    revert: { file: SHELL, from: "if (composing && composing.isConnected !== false && document.activeElement === composing) { fit(); return; }", to: "if (composing) { fit(); return; }" } },
  { id: "composer-ime-ownership", refs: ["#2517"], what: "Mid-composition the page wrote the box (its value, its height): iOS redrew the candidate bar on every key.",
    tests: { [TCOMP]: ["IME: while composing nothing is written to the box or the composer; compositionend takes the text once"] },
    smokes: [{ file: "smoke-ime-composition.mts" }],
    revert: { file: COMPOSER, from: "const onInput = (e) => { if (composing.current || e.isComposing) return; onValue(e.target.value); };", to: "const onInput = (e) => { onValue(e.target.value); };" } },
  { id: "band-under-composer", refs: ["M-3111", "#3900"], what: "A black band between the composer and the keyboard; the box snapped on the way down. With the keyboard up the shell is the view.",
    tests: { [T3111]: ["up: the view's height at the top; a pan is undone (scrollTo 0), never followed; nothing set before the keyboard"] },
    smokes: [{ file: "smoke-phone-keyboard-motion-m3327.mts" }, { file: "smoke-phone-kb-steady.mts", cases: ["1-typing"] }],
    revert: { file: SHELL, from: "el.style.setProperty(\"height\", `${fitH}px`);", to: "el.style.removeProperty(\"height\");" } },
  { id: "realign-per-key", refs: ["#4011"], what: "beta.4: one reading per key said \"no keyboard\"; the keyboard state went down and up, the page re-aligned on every key.",
    tests: { [T2478]: ["keystrokes with the keyboard up: bars, pans and a one-reading full height — kb-open never drops"],
      [T3111]: ["typing: a keyboard state that dips for a moment leaves the shell as the view (no re-align on a keystroke)"] },
    smokes: [{ file: "smoke-phone-kb-steady.mts", cases: ["1-typing"] }],
    revert: { file: SHELL, from: "if (now() - downSince < DOWN_HOLD_MS) {", to: "if (false) {" } },
  { id: "shell-steady-per-key", refs: ["M-3206", "#4026"], what: "beta.5: the shell followed every per-key reading (the suggestion bar, a few px of pan): the box moved on every key.",
    tests: { [T3111]: ["typing, settled: per-key readings (the suggestion bar on and off, a pan) move nothing; one that holds is taken"],
      [T3265]: ["English: per-key readings (the bar on and off, a pan, one full-height reading) — no change on any key"] },
    smokes: [{ file: "smoke-phone-kb-steady.mts" }, { file: "smoke-phone-typing-steady-m3265.mts", cases: ["en"] }],
    revert: { file: SHELL, from: "const settled = fitH && typingNow && w === fitW && now() >= followUntil;", to: "const settled = false;" } },
  { id: "composer-height-per-key", refs: ["M-3206", "#4026"], what: "The box collapsed and re-measured its height on every key (a write per key).",
    tests: { [TCOMP]: ["M-3206: a key that adds text writes nothing to the box's height; a new line grows it once; a deletion measures again"] },
    smokes: [{ file: "smoke-phone-kb-steady.mts" }],
    revert: { file: COMPOSER, from: "if (grew) {", to: "if (false) {" } },
  { id: "box-under-candidate-bar", refs: ["M-3244", "#4057"], what: "Mid-composition the view got shorter (the keyboard, its candidate bar) and the shell kept its height: the box sat under the keyboard.",
    tests: { [T3111]: ["composing: the keyboard coming up mid-composition — the shell is the view at once, not the whole screen"] },
    smokes: [{ file: "smoke-phone-ime-keyboard-m3244.mts" }],
    revert: { file: SHELL, from: "if (composing && composing.isConnected !== false && document.activeElement === composing) { fit(); return; }", to: "if (composing && composing.isConnected !== false && document.activeElement === composing) { return; }" } },
  { id: "zhuyin-per-character", refs: ["M-3265", "#4089"], what: "注音: every character moved the box twice (up for its bar, down 300 ms after it was chosen).",
    tests: { [T3265]: ["注音, a person's pace (each character chosen after a pause): the first bar is followed once, then nothing per character"] },
    smokes: [{ file: "smoke-phone-typing-steady-m3265.mts", cases: ["zhuyin", "zhuyin-fast", "bar-stays"] }],
    revert: { file: SHELL, from: "const IME_GROW_HOLD_MS = 2000;", to: "const IME_GROW_HOLD_MS = 0;" } },
  { id: "zhuyin-per-key-nudge", refs: ["M-3265", "#4089"], what: "注音: each key while the candidates show nudged the view a few px, and the shell followed every one.",
    tests: { [T3265]: ["the user's case: each 注音 key while the candidates show nudges the view's height — after the first bar, no change per key",
      "a nudge that stays (a few px) is no move while typing; a bar's height is"] },
    smokes: [{ file: "smoke-phone-typing-steady-m3265.mts", cases: ["keys", "keys-pan"] }],
    revert: { file: SHELL, from: "const NUDGE_PX = 12;", to: "const NUDGE_PX = 0;" } },
  { id: "open-header-drop", refs: ["M-3327", "#4171"], what: "Opening: the shell chased iOS's pan with a transform; the header dropped mid-screen over a black band, then snapped back.",
    tests: { [T3111]: ["up: the view's height at the top; a pan is undone (scrollTo 0), never followed; nothing set before the keyboard"] },
    smokes: [{ file: "smoke-phone-keyboard-motion-m3327.mts", cases: ["open (both orders)"] }],
    revert: { file: SHELL, from: "el.style.removeProperty(\"transform\");\n      unpan(top);", to: "el.style.setProperty(\"transform\", `translateY(${top}px)`);" } },
  { id: "close-midair", refs: ["M-3327", "#4171"], what: "Closing: the box hung mid-air over a band for ~350 ms (iOS reports the taller view late), then dropped in one frame.",
    tests: { [T3111]: ["down: leaving the field, the shell takes its full height at once (easing: data-kb-closing), then its stylesheet's",
      "close — the taller view first, focusout 50 ms later: the full height at the focusout (not held 300 ms), not eased"] },
    smokes: [{ file: "smoke-phone-keyboard-motion-m3327.mts", cases: ["close (both orders)"] }],
    revert: { file: SHELL, from: "fitH = gone ? tallest : left ? h : pending ? fitH : h;", to: "fitH = pending ? fitH : h;" } },
  { id: "tap-focused-box", refs: ["M-3327", "#4171"], what: "A tap on a box that already had the focus (no focus event): iOS's keyboard-sized pan was held 300 ms instead of undone.",
    tests: { [T3111]: ["M-3327: a tap on a box that already had the focus (no focus event): a keyboard-sized pan is undone at once, not held"] },
    smokes: [],
    revert: { file: SHELL, from: " && !(top - fitTop > KEYBOARD_MIN_PX)", to: "" } },
  { id: "focus-to-another-field", refs: ["M-3327", "#4171"], what: "Focus moving from the box to another text field is not the keyboard going away.",
    tests: { [T3111]: ["M-3327: focus going from the box to another text field is not the keyboard going away"] },
    smokes: [],
    revert: { file: SHELL, from: "leaving = e?.type === \"focusout\" && !isTextEntry(e.relatedTarget);", to: "leaving = e?.type === \"focusout\";" } },
  { id: "selection-reads-composing", refs: ["M-3356", "#4208"], what: "Typing 注音 flickered iOS's candidate bar: the page's document listeners read the box's selection on every composition key.",
    tests: { [T3356]: ["three 注音 characters: no selection read, no getSelection, no style write on the box between compositionstart and the commit"] },
    smokes: [],
    revert: { file: "src/ui/shared/text-undo.js", from: "if (h.composing || e.isComposing) return;\n    h.last = snap(el);", to: "h.last = snap(el);" } },
  { id: "quote-reads-composing", refs: ["M-3356", "#4208"], what: "The same, from the Quote pill's selectionchange check.",
    tests: { [T3356]: ["three 注音 characters: no selection read, no getSelection, no style write on the box between compositionstart and the commit"] },
    smokes: [],
    revert: { file: "src/ui/shared/chat-quote.js", from: "if (composing) { if (timer) { clearTimeout(timer); timer = null; } return; }\n    soon();", to: "soon();" } },
];

/** The smokes, with the loopback port each boots on in the suite's run (one each). */
export const SMOKES = [
  { file: "smoke-ime-composition.mts", hp: 48848 },
  { file: "smoke-phone-kb-steady.mts", hp: 19661 },
  { file: "smoke-phone-ime-keyboard-m3244.mts", hp: 19671 },
  { file: "smoke-phone-typing-steady-m3265.mts", hp: 19681 },
  { file: "smoke-phone-keyboard-motion-m3327.mts", hp: 49127 },
];

/** Problems with the manifest against the tree at `root` (empty: fine). */
export function check(root = process.cwd()) {
  const errors = [], read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null);
  const ids = new Set();
  for (const c of CASES) {
    if (ids.has(c.id)) errors.push(`${c.id}: two cases with this id`);
    ids.add(c.id);
    if (!c.refs?.length) errors.push(`${c.id}: no card or PR`);
    for (const [file, titles] of Object.entries(c.tests)) {
      const text = read(file);
      if (text == null) { errors.push(`${c.id}: ${file} is missing`); continue; }
      for (const t of titles) if (!text.includes(JSON.stringify(t).slice(1, -1)) && !text.includes(t)) errors.push(`${c.id}: no test "${t}" in ${file}`);
    }
    for (const s of c.smokes) if (!SMOKES.some((k) => k.file === s.file)) errors.push(`${c.id}: smoke ${s.file} is not in SMOKES`);
    const src = read(c.revert.file);
    if (src == null) errors.push(`${c.id}: ${c.revert.file} is missing`);
    else {
      const n = src.split(c.revert.from).length - 1;
      if (n !== 1) errors.push(`${c.id}: its revert's text is found ${n} times in ${c.revert.file} (must be once): the fix moved — update the revert to undo it in the code as it is now`);
    }
  }
  for (const s of SMOKES) if (!existsSync(join(root, "scripts/manual/smoke", s.file))) errors.push(`smoke ${s.file} is missing`);
  if (new Set(SMOKES.map((s) => s.hp)).size !== SMOKES.length) errors.push("two smokes on one port");
  return errors;
}

export function touches(files) { return files.some((f) => KEYBOARD_PATHS.some((re) => re.test(f))); }

// KEYBOARD_SUITE_VITEST: another runner in vitest's place (tests/keyboard-suite-m3357.test.ts: one that waits to be stopped).
const VITEST = [process.env.KEYBOARD_SUITE_VITEST || "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2"];
/** The vitest run in progress (for a stop to end it with the rest). */
let running = null;
/** Run vitest on `files`; per test title, its status ("passed", "failed", "skipped" …); null when vitest gave no report. */
async function vitest(root, files) {
  const dir = mkdtempSync(join(tmpdir(), "kb-suite-")), out = join(dir, "report.json");
  try {
    running = spawn(process.execPath, [...VITEST, "--reporter=json", `--outputFile=${out}`, ...files], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: process.env });
    await new Promise((done) => { running.on("close", done); running.on("error", done); });
    running = null;
    if (!existsSync(out)) return null;
    const report = JSON.parse(readFileSync(out, "utf8")), seen = new Map();
    for (const f of report.testResults ?? []) for (const a of f.assertionResults ?? []) {
      const key = `${f.name.slice(f.name.indexOf("tests/"))}\u0000${a.title}`;
      if (!seen.has(key) || a.status === "failed") seen.set(key, a.status);
    }
    return seen;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const statusOf = (seen, file, title) => seen?.get(`${file}\u0000${title}`);

export async function runUnit(root = process.cwd()) {
  const files = [...new Set(CASES.flatMap((c) => Object.keys(c.tests)))];
  const seen = await vitest(root, files), bad = [];
  if (!seen) return ["vitest gave no report"];
  for (const c of CASES) for (const [f, titles] of Object.entries(c.tests)) for (const t of titles) {
    const s = statusOf(seen, f, t);
    if (s !== "passed") bad.push(`${c.id}: "${t}" (${f}) ${s ?? "did not run"}`);
  }
  return bad;
}

/**
 * Each case's fix undone alone, its tests run. The source file is written in place and always put back: after the run,
 * on an error, and on Ctrl+C or a SIGTERM (#4210 review: a stop must never leave a fix undone in someone's checkout) —
 * the run in progress is stopped, the file put back, and the exit is 130 / 143.
 */
export async function runReverts(root = process.cwd(), only = []) {
  const bad = [];
  let restore = null;
  const stop = (signal) => {
    try { running?.kill(signal); } catch { /* already gone */ }
    if (restore) { restore(); restore = null; }
    console.error(`keyboard suite: stopped (${signal}); every source file is as it was`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (const c of CASES.filter((k) => !only.length || only.includes(k.id))) {
      const path = join(root, c.revert.file), before = readFileSync(path, "utf8");
      if (before.split(c.revert.from).length !== 2) { bad.push(`${c.id}: its revert does not apply (see --list / the manifest test)`); continue; }
      let seen;
      restore = () => writeFileSync(path, before);
      try { writeFileSync(path, before.replace(c.revert.from, () => c.revert.to)); seen = await vitest(root, Object.keys(c.tests)); }
      finally { if (restore) { restore(); restore = null; } }
      const failed = Object.entries(c.tests).flatMap(([f, ts]) => ts.filter((t) => statusOf(seen, f, t) === "failed"));
      console.log(`${failed.length ? "red  " : "GREEN"} ${c.id} (${c.refs.join(", ")}): ${failed.length} of its tests failed with the fix undone`);
      if (!failed.length) bad.push(`${c.id}: its fix undone, none of its tests failed — the suite no longer pins it`);
    }
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  return bad;
}

export function runSmokes(root = process.cwd(), only = []) {
  const bad = [];
  for (const s of SMOKES.filter((k) => !only.length || only.includes(k.file))) {
    console.log(`::group::${s.file} (${process.env.PW_ENGINE || "chromium"}, HP ${s.hp})`);
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", join("scripts/manual/smoke", s.file)], { cwd: root, stdio: "inherit", env: { ...process.env, HP: String(s.hp) } });
    console.log("::endgroup::");
    if (r.status !== 0) bad.push(`${s.file} failed (exit ${r.status ?? r.signal})`);
  }
  return bad;
}

function changedFiles() {
  const base = process.env.BASE_SHA, head = process.env.HEAD_SHA;
  if (process.env.EVENT_NAME && process.env.EVENT_NAME !== "pull_request") return null;
  if (!base || !head) return null;
  const r = spawnSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const files = r.stdout.split("\n").filter(Boolean);
  return files.length ? files : null;
}

async function main(argv) {
  const [mode, ...rest] = argv, root = process.cwd();
  const fail = (list) => { for (const e of list) console.error(`::error title=keyboard suite::${e}`); return list.length ? 1 : 0; };
  if (mode === "--list") {
    for (const c of CASES) {
      console.log(`${c.id}  [${c.refs.join(", ")}]  ${c.what}`);
      for (const [f, ts] of Object.entries(c.tests)) for (const t of ts) console.log(`    unit   ${f}: ${t}`);
      for (const s of c.smokes) console.log(`    smoke  ${s.file}${s.cases ? ` (${s.cases.join(", ")})` : ""}`);
      console.log(`    revert ${c.revert.file}`);
    }
    return fail(check(root));
  }
  if (mode === "--touches") {
    const files = rest.length ? rest : changedFiles();
    const run = files == null ? true : touches(files);
    console.log(String(run));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
    return 0;
  }
  const errors = check(root);
  if (errors.length) return fail(errors);
  if (mode === "--unit") return fail(await runUnit(root));
  if (mode === "--reverts") return fail(await runReverts(root, rest));
  if (mode === "--smokes") return fail(runSmokes(root, rest));
  console.error("usage: keyboard-suite.mjs --list | --touches [files…] | --unit | --reverts [ids…] | --smokes [files…]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
