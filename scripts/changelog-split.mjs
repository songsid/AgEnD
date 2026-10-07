#!/usr/bin/env node
/**
 * The reverse of changelog-assemble.mjs, for a long-lived line landing on main (docs/development.md, "A long-lived
 * line landing on `main`"): turns one release section of docs/CHANGELOG.md and docs/CHANGELOG.zh-TW.md into
 * `changes/` fragment pairs and removes that section from both files.
 *
 *   node scripts/changelog-split.mjs --release 2.2.0 --issue 1262 [--dry-run] [--force]
 *
 * - The section is `## [<release>] …` in both files (their headings differ after the version).
 * - Entries are paired per subsection, in order. It refuses when a subsection is missing on one side, when the
 *   counts differ, or when the two halves of a pair name different issues in their bold summary.
 * - A fragment is `changes/<issue>-<slug>.md` + `.zh-TW.md`: the first `#N` in the English summary (else `--issue`)
 *   and a slug of its first words. The body is the entry verbatim.
 * - It refuses when a target file already exists, unless `--force`.
 * - Every check runs before anything is written: one problem writes nothing. `--dry-run` prints the pairs and stops.
 *
 * Read what it wrote before committing: drop the fragments for entries that only concerned the line itself.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS } from "./changelog-assemble.mjs";

const FILES = { en: "docs/CHANGELOG.md", zh: "docs/CHANGELOG.zh-TW.md" };

/** The section key of a `### …` heading: en "Fixed", zh "修正 (Fixed)". */
function sectionOf(heading, lang) {
  const text = heading.replace(/^###[ \t]+/, "").trim();
  const key = lang === "en" ? text : (/\(([^()]+)\)$/.exec(text)?.[1] ?? "");
  return SECTIONS.includes(key) ? key : null;
}

/**
 * Split one release section of one file. Returns { start, end, subsections: Map<section, entry[]> } or throws.
 * An entry is a top-level `- ` line and everything up to the next top-level line: indented lines, blank lines followed
 * by indented text, and unindented text directly under a non-blank line of it (lazy continuation) — the same entry
 * changelog-assemble.mjs compares.
 */
export function readSection(text, release, lang) {
  const lines = text.replace(/\r/g, "").split("\n");
  const start = lines.findIndex(l => l === `## [${release}]` || l.startsWith(`## [${release}] `));
  if (start < 0) throw new Error(`${FILES[lang]}: no \`## [${release}]\` section`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const subsections = new Map();
  let current = null, entry = null;
  const close = () => { if (entry) { current.push(entry.join("\n").replace(/\n+$/, "")); entry = null; } };
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (line.startsWith("### ")) {
      close();
      const key = sectionOf(line, lang);
      if (!key) throw new Error(`${FILES[lang]}:${i + 1}: unknown subsection ${JSON.stringify(line)}`);
      if (subsections.has(key)) throw new Error(`${FILES[lang]}:${i + 1}: subsection ${key} appears twice`);
      current = [];
      subsections.set(key, current);
    } else if (line.startsWith("- ")) {
      if (!current) throw new Error(`${FILES[lang]}:${i + 1}: an entry before any \`###\` subsection`);
      close();
      entry = [line];
    } else if (line.trim() === "") {
      if (entry) entry.push(line);
    } else if (/^[ \t]/.test(line) && entry) {
      entry.push(line);
    } else if (entry && entry[entry.length - 1].trim() !== "" && !line.startsWith("#")) {
      entry.push(line);                           // Markdown lazy continuation, as changelog-assemble.mjs reads it
    } else {
      throw new Error(`${FILES[lang]}:${i + 1}: a line that is not part of an entry: ${JSON.stringify(line.slice(0, 60))}`);
    }
  }
  close();
  return { lines, start, end, subsections };
}

/** The bold summary of an entry (`- **…**`), else its first line. */
const summaryOf = entry => (/^- \*\*([\s\S]+?)\*\*/.exec(entry)?.[1] ?? entry.split("\n")[0].slice(2)).replace(/\s*\n\s*/g, " ");
/** The issue numbers named in the summary, sorted and de-duplicated. */
export const issuesOf = entry => [...new Set([...summaryOf(entry).matchAll(/#(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
export function slugOf(entry) {
  const words = summaryOf(entry).toLowerCase().replace(/`[^`]*`/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\(#\d+[^)]*\)|#\d+/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, 5).join("-") || "entry";
}

/** Plan the split: returns { fragments: [{ name, section, en, zh }], texts: { en, zh } } or throws. */
export function planSplit(texts, release, fallbackIssue) {
  const en = readSection(texts.en, release, "en");
  const zh = readSection(texts.zh, release, "zh");
  const problems = [];
  const keys = new Set([...en.subsections.keys(), ...zh.subsections.keys()]);
  const fragments = [];
  const used = new Set();
  for (const section of SECTIONS.filter(s => keys.has(s))) {
    const a = en.subsections.get(section), b = zh.subsections.get(section);
    if (!a || !b) { problems.push(`${section}: only in ${a ? FILES.en : FILES.zh}`); continue; }
    if (a.length !== b.length) { problems.push(`${section}: ${a.length} entries in ${FILES.en}, ${b.length} in ${FILES.zh}`); continue; }
    a.forEach((enEntry, i) => {
      const zhEntry = b[i];
      const ia = issuesOf(enEntry), ib = issuesOf(zhEntry);
      if (ia.join() !== ib.join()) {
        problems.push(`${section} #${i + 1}: en names [${ia.map(n => `#${n}`).join(", ")}], zh-TW names [${ib.map(n => `#${n}`).join(", ")}] — `
          + `${JSON.stringify(summaryOf(enEntry).slice(0, 50))} / ${JSON.stringify(summaryOf(zhEntry).slice(0, 30))}`);
        return;
      }
      const issue = ia[0] ?? fallbackIssue;
      if (issue === undefined) { problems.push(`${section} #${i + 1}: names no issue and there is no --issue: ${JSON.stringify(summaryOf(enEntry).slice(0, 50))}`); return; }
      let name = `${issue}-${slugOf(enEntry)}`;
      for (let n = 2; used.has(name); n++) name = `${issue}-${slugOf(enEntry)}-${n}`;
      used.add(name);
      fragments.push({ name, section, en: enEntry, zh: zhEntry });
    });
  }
  if (problems.length) throw new Error(problems.join("\n"));
  const drop = s => {
    const lines = s.lines.slice(0, s.start).concat(s.lines.slice(s.end));
    return lines.join("\n");
  };
  return { fragments, texts: { en: drop(en), zh: drop(zh) } };
}

export function main(argv) {
  const opts = { release: null, issue: undefined, dryRun: false, force: false, root: resolve(dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--release") opts.release = argv[++i];
    else if (a === "--issue") opts.issue = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--root") opts.root = resolve(argv[++i]);
    else { console.error(`changelog-split: unknown argument ${a}`); return 2; }
  }
  if (!/^\d+\.\d+\.\d+$/.test(opts.release ?? "")) { console.error("changelog-split: --release X.Y.Z is required"); return 2; }
  if (opts.issue !== undefined && !/^[1-9]\d*$/.test(opts.issue)) { console.error("changelog-split: --issue takes an issue number"); return 2; }
  const fallback = opts.issue === undefined ? undefined : Number(opts.issue);

  let plan;
  try {
    const texts = { en: readFileSync(join(opts.root, FILES.en), "utf8"), zh: readFileSync(join(opts.root, FILES.zh), "utf8") };
    plan = planSplit(texts, opts.release, fallback);
  } catch (err) {
    for (const line of String(err.message).split("\n")) console.error(`changelog-split: ${line}`);
    return 1;
  }
  const targets = plan.fragments.flatMap(f => [`changes/${f.name}.md`, `changes/${f.name}.zh-TW.md`]);
  const existing = targets.filter(t => existsSync(join(opts.root, t)));
  if (existing.length && !opts.force) {
    for (const t of existing) console.error(`changelog-split: ${t} already exists (--force overwrites)`);
    return 1;
  }
  for (const f of plan.fragments) {
    console.log(`${opts.dryRun ? "would write" : "wrote"} changes/${f.name}.md + .zh-TW.md  [${f.section}]  ${summaryOf(f.en).slice(0, 70)}`);
  }
  if (opts.dryRun) {
    console.log(`changelog-split: ${plan.fragments.length} pair(s); would remove ## [${opts.release}] from both CHANGELOGs (dry run: nothing written)`);
    return 0;
  }
  for (const f of plan.fragments) {
    writeFileSync(join(opts.root, "changes", `${f.name}.md`), `---\nsection: ${f.section}\n---\n${f.en}\n`);
    writeFileSync(join(opts.root, "changes", `${f.name}.zh-TW.md`), `---\nsection: ${f.section}\n---\n${f.zh}\n`);
  }
  writeFileSync(join(opts.root, FILES.en), plan.texts.en);
  writeFileSync(join(opts.root, FILES.zh), plan.texts.zh);
  console.log(`changelog-split: ${plan.fragments.length} pair(s) written; ## [${opts.release}] removed from both CHANGELOGs. Drop the fragments for line-only entries, then run changelog-assemble.mjs --check.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
