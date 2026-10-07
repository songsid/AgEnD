#!/usr/bin/env node
/**
 * Moves CHANGELOG fragments (`changes/<issue>.md` + `changes/<issue>.zh-TW.md`) into docs/CHANGELOG.md and
 * docs/CHANGELOG.zh-TW.md, then deletes them. Each PR adds a fragment instead of editing the CHANGELOG, so two PRs
 * never conflict on it; see docs/development.md, "CHANGELOG fragments".
 *
 *   node scripts/changelog-assemble.mjs                                     into ## [Unreleased]
 *   node scripts/changelog-assemble.mjs --release 2.1.13 [--date 2026-10-08] into ## [2.1.13] - <date>
 *   node scripts/changelog-assemble.mjs --check                             validate only (CI), write nothing
 *
 * A fragment:
 *
 *   ---
 *   section: Fixed
 *   ---
 *   - **One-line summary (#1328).** Explanation…
 *
 * `section` is one of Upgrade Notes, Added, Changed, Fixed, Security, and both languages must name the same one. The
 * body is one or more list items, inserted verbatim. Every fragment is validated before anything is written: one bad
 * fragment writes nothing. Fragments go to the top of their subsection, ordered by issue number, then file name. An
 * entry already present in the target section is not added twice, so a rerun after an interrupted one is harmless.
 *
 * Commit the result with the trailer `Changelog: assemble` (printed at the end): it is how CI tells this commit from
 * a direct CHANGELOG edit (scripts/changelog-guard.mjs).
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECTIONS = ["Upgrade Notes", "Added", "Changed", "Fixed", "Security"];
const ZH_HEADINGS = {
  "Upgrade Notes": "升級注意事項 (Upgrade Notes)",
  Added: "新增 (Added)",
  Changed: "變更 (Changed)",
  Fixed: "修正 (Fixed)",
  Security: "安全 (Security)",
};
export const ASSEMBLE_TRAILER = "Changelog: assemble";
const LANGS = {
  en: { file: "docs/CHANGELOG.md", unreleased: "## [Unreleased]", heading: s => s },
  zh: { file: "docs/CHANGELOG.zh-TW.md", unreleased: "## [未發佈] (Unreleased)", heading: s => ZH_HEADINGS[s] },
};
const FRAGMENT_NAME = /^(\d+)(-[a-z0-9][a-z0-9-]*)?(\.zh-TW)?\.md$/;
const IGNORED = new Set(["README.md"]);

/** Parse one fragment's text. Returns { section, body } or { error }. */
export function parseFragment(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: "no front-matter (a `---` line, `section: …`, a `---` line, then the entry)" };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) return { error: `front-matter line is not \`key: value\`: ${JSON.stringify(line)}` };
    if (kv[1] !== "section") return { error: `unknown front-matter key \`${kv[1]}\` (only \`section\`)` };
    if (Object.hasOwn(fields, kv[1])) return { error: "`section` is given twice" };
    fields[kv[1]] = kv[2];
  }
  if (!fields.section) return { error: "front-matter has no `section`" };
  if (!SECTIONS.includes(fields.section)) return { error: `section \`${fields.section}\` is not one of ${SECTIONS.join(", ")}` };
  const body = m[2].replace(/\r/g, "").replace(/^\s*\n/, "").trimEnd();
  if (body === "") return { error: "the entry is empty" };
  if (!body.startsWith("- ")) return { error: "the entry must be a list item starting with `- `" };
  if (/^#{1,6}[ \t]/m.test(body)) return { error: "the entry contains a heading line; headings come from `section`" };
  return { section: fields.section, body };
}

/**
 * The complete entries in some lines: a top-level `- ` line plus the indented or blank lines that follow it, up to the
 * next top-level line; trailing blank lines dropped. An entry is "already there" only when one of these equals it.
 */
export function entryBlocks(lines) {
  const blocks = [];
  let cur = null;
  const close = () => { if (cur) { blocks.push(cur.join("\n").trimEnd()); cur = null; } };
  for (const line of lines) {
    if (line.startsWith("- ")) { close(); cur = [line]; }
    else if (cur && (line.trim() === "" || /^[ \t]/.test(line))) cur.push(line);
    else close();
  }
  close();
  return blocks;
}

/** Read and validate every fragment under <root>/changes. Returns { fragments, errors, orphans }. */
export function readFragments(root) {
  const dir = join(root, "changes");
  const errors = [];
  const byKey = new Map();
  const names = existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith(".") && !IGNORED.has(n)).sort() : [];
  for (const name of names) {
    const m = FRAGMENT_NAME.exec(name);
    if (!m) { errors.push(`changes/${name}: the name must be <issue>.md or <issue>-<slug>.md (and .zh-TW.md for zh)`); continue; }
    const key = `${m[1]}${m[2] ?? ""}`;
    const lang = m[3] ? "zh" : "en";
    const parsed = parseFragment(readFileSync(join(dir, name), "utf8"));
    if (parsed.error) { errors.push(`changes/${name}: ${parsed.error}`); continue; }
    const entry = byKey.get(key) ?? { key, issue: Number(m[1]), files: [] };
    entry[lang] = parsed;
    entry.files.push(join(dir, name));
    byKey.set(key, entry);
  }
  const fragments = [];
  const orphans = [];
  for (const entry of byKey.values()) {
    if (!entry.en || !entry.zh) {
      const has = entry.en ? `${entry.key}.md` : `${entry.key}.zh-TW.md`;
      const missing = entry.en ? `${entry.key}.zh-TW.md` : `${entry.key}.md`;
      // A half that failed to parse was already reported; do not report its pair as missing too.
      if (!errors.some(e => e.startsWith(`changes/${missing}:`))) {
        errors.push(`changes/${has}: no changes/${missing} (every entry is written in en and zh-TW)`);
        orphans.push({ lang: entry.en ? "en" : "zh", file: entry.files[0], name: has, body: (entry.en ?? entry.zh).body, error: errors.length - 1 });
      }
      continue;
    }
    if (entry.en.section !== entry.zh.section) {
      errors.push(`changes/${entry.key}: en says \`${entry.en.section}\`, zh-TW says \`${entry.zh.section}\``);
      continue;
    }
    fragments.push(entry);
  }
  fragments.sort((a, b) => a.issue - b.issue || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { fragments, errors, orphans };
}

/**
 * Insert entries into one CHANGELOG text. `target` is null for [Unreleased], else { version, date }.
 * `entries` is [{ section, body }] in insertion order. Pure; returns the new text.
 */
/** The complete entries already in the target section (empty when a --release section does not exist yet). */
export function targetBlocks(text, lang, target) {
  const L = LANGS[lang];
  const lines = text.replace(/\r/g, "").split("\n");
  const start = target === null ? lines.findIndex(line => line === L.unreleased)
    : lines.findIndex(line => line === `## [${target.version}]` || line.startsWith(`## [${target.version}] `));
  if (start < 0) return [];
  let end = lines.findIndex((line, n) => n > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  return entryBlocks(lines.slice(start + 1, end));
}

export function insertEntries(text, lang, target, entries) {
  const L = LANGS[lang];
  const lines = text.replace(/\r/g, "").split("\n");
  const isRelease = line => line.startsWith("## ");
  const unreleasedAt = lines.findIndex(line => line === L.unreleased);
  if (unreleasedAt < 0) throw new Error(`${L.file}: no \`${L.unreleased}\` line`);
  const endOf = start => { const i = lines.findIndex((line, n) => n > start && isRelease(line)); return i < 0 ? lines.length : i; };

  let start;
  if (target === null) start = unreleasedAt;
  else {
    start = lines.findIndex(line => line === `## [${target.version}]` || line.startsWith(`## [${target.version}] `));
    if (start < 0) {
      // A new release goes right under [Unreleased], above the previous release.
      const at = endOf(unreleasedAt);
      lines.splice(at, 0, `## [${target.version}] - ${target.date}`, "");
      start = at;
    }
  }

  for (const section of SECTIONS) {
    const mine = entries.filter(e => e.section === section);
    if (mine.length === 0) continue;
    const end = endOf(start);
    // Already there means every entry of the fragment is a complete entry of this release, not a substring of one.
    const present = new Set(entryBlocks(lines.slice(start + 1, end)));
    const fresh = mine.filter(e => !entryBlocks(e.body.split("\n")).every(block => present.has(block)));
    if (fresh.length === 0) continue;
    const heading = `### ${L.heading(section)}`;
    const body = fresh.map(e => e.body).join("\n").split("\n");
    const at = lines.findIndex((line, n) => n > start && n < end && line === heading);
    if (at >= 0) { lines.splice(at + 1, 0, ...body); continue; }
    // A new subsection goes in its canonical place: right before the first later subsection, else after the last
    // non-blank line of the release (the blank lines that separated it from the next release stay after it).
    const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1).map(s => `### ${L.heading(s)}`);
    const before = lines.findIndex((line, n) => n > start && n < end && later.includes(line));
    if (before >= 0) { lines.splice(before, 0, heading, ...body, ""); continue; }
    let last = end;
    while (last - 1 > start && lines[last - 1] === "") last--;
    lines.splice(last, 0, "", heading, ...body);
    // No blank line separated it from the next release: keep one.
    const next = last + 2 + body.length;
    if (last === end && next < lines.length) lines.splice(next, 0, "");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { check: false, release: null, date: null, root: resolve(dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--release") opts.release = argv[++i];
    else if (a === "--date") opts.date = argv[++i];
    else if (a === "--root") opts.root = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.release !== null && !/^\d+\.\d+\.\d+$/.test(opts.release ?? "")) throw new Error("--release takes X.Y.Z");
  if (opts.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date ?? "")) throw new Error("--date takes YYYY-MM-DD");
  if (opts.date !== null && opts.release === null) throw new Error("--date goes with --release");
  return opts;
}

export function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { console.error(`changelog-assemble: ${err.message}`); return 2; }
  const { fragments, errors, orphans } = readFragments(opts.root);
  const target = opts.release === null ? null : { version: opts.release, date: opts.date ?? new Date().toISOString().slice(0, 10) };
  // A run interrupted between deleting the two halves of a pair leaves one half whose entry is already in the target
  // release. Assembling again (same target) finishes that cleanup; --check still reports it, so CI says to rerun.
  const leftovers = [];
  if (!opts.check) {
    for (const o of orphans) {
      let blocks;
      try { blocks = targetBlocks(readFileSync(join(opts.root, LANGS[o.lang].file), "utf8"), o.lang, target); } catch { continue; }
      const have = new Set(blocks);
      if (entryBlocks(o.body.split("\n")).every(block => have.has(block))) { leftovers.push(o); errors[o.error] = null; }
    }
  }
  const problems = errors.filter(e => e !== null);
  if (problems.length) {
    for (const e of problems) console.error(`changelog-assemble: ${e}`);
    if (opts.check && orphans.length) console.error("changelog-assemble: a half left by an interrupted assemble is removed by running the assembler again");
    return 1;
  }
  if (opts.check) { console.log(`changelog-assemble: ${fragments.length} fragment(s) OK`); return 0; }
  for (const o of leftovers) { unlinkSync(o.file); console.log(`changelog-assemble: removed changes/${o.name}, left by an interrupted run (its entry is already in the CHANGELOG)`); }
  if (fragments.length === 0) { console.log("changelog-assemble: no fragments"); return 0; }
  const out = {};
  try {
    for (const lang of Object.keys(LANGS)) {
      const path = join(opts.root, LANGS[lang].file);
      out[path] = insertEntries(readFileSync(path, "utf8"), lang, target, fragments.map(f => f[lang]));
    }
  } catch (err) { console.error(`changelog-assemble: ${err.message}`); return 1; }
  for (const [path, text] of Object.entries(out)) writeFileSync(path, text);
  for (const f of fragments) for (const file of f.files) unlinkSync(file);
  const where = target ? `[${target.version}]` : "[Unreleased]";
  console.log(`changelog-assemble: ${fragments.length} fragment(s) moved into ${where}. Commit with the trailer:\n\n${ASSEMBLE_TRAILER}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
