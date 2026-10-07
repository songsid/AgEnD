#!/usr/bin/env node
/**
 * CI guard for CHANGELOG fragments (run on pull requests by ci.yml):
 *
 *   node scripts/changelog-guard.mjs --base <base sha> --head <head sha>
 *
 * A PR adds `changes/<issue>.md` + `changes/<issue>.zh-TW.md` (scripts/changelog-assemble.mjs) and leaves
 * docs/CHANGELOG*.md alone. Only the assemble commit, marked with the trailer `Changelog: assemble`, edits them.
 * Everything is counted from the merge-base, so what a merge-sync brought in from main is not the PR's change.
 *
 * When the PR changes either CHANGELOG:
 *   1. every non-merge commit of the PR that edits them is marked;
 *   2. every entry the PR adds to or removes from them (a complete `- ` entry, compared from the merge-base to the
 *      head) comes from a marked commit: one whose own content differs from a parent's by that entry. A merge does
 *      not have to be marked to sync, but an entry that appears or disappears only in a merge (an edit slipped into
 *      it, or a conflict resolved to one side that dropped the other side's entries) is refused unless that merge is
 *      marked.
 * Whatever the PR does to the CHANGELOG:
 *   3. every fragment the PR deletes has its entry in the head's CHANGELOG (same language), so a merge that resolved
 *      the CHANGELOG back to main's after the assemble commit cannot lose the entries it moved.
 *
 * This is judged on content, not on merge topology: a long-lived line whose old merge-syncs combined both sides'
 * CHANGELOG changes passes once its files equal main's and its entries are fragments (docs/development.md).
 *
 * Exit 0 when allowed, 1 with the reason when not, 2 on bad arguments or a git failure.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSEMBLE_TRAILER, entryBlocks, parseFragment } from "./changelog-assemble.mjs";

export const CHANGELOG_FILES = ["docs/CHANGELOG.md", "docs/CHANGELOG.zh-TW.md"];
const SHA = /^[0-9a-f]{7,64}$/;

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const lines = out => out.split("\n").filter(Boolean);

/** True when a commit message has the assemble trailer on a line of its own. */
export function hasAssembleTrailer(message) {
  return message.split(/\r?\n/).some(line => line.trim() === ASSEMBLE_TRAILER);
}

/** The complete entries of a file at a commit; empty when the file does not exist there. */
function blocksAt(cwd, commit, file) {
  let text;
  try { text = git(cwd, ["show", `${commit}:${file}`]); } catch (err) {
    // A missing path is "no entries"; any other git failure is a failure.
    if (/does not exist in|exists on disk, but not in/.test(String(err.stderr ?? ""))) return new Set();
    throw err;
  }
  return new Set(entryBlocks(text.replace(/\r/g, "").split("\n")));
}

const firstLine = block => block.split("\n")[0].slice(0, 80);

/** Returns { ok: true } or { ok: false, reason }. Throws on a git failure. */
export function checkChangelogEdits(cwd, base, head) {
  const mb = git(cwd, ["merge-base", base, head]).trim();
  const changed = lines(git(cwd, ["diff", "--name-only", `${mb}`, head, "--", ...CHANGELOG_FILES]));
  const deleted = lines(git(cwd, ["diff", "--name-only", "--no-renames", "--diff-filter=D", mb, head, "--", "changes/"]))
    .filter(f => /\.md$/.test(f) && !f.endsWith("/README.md"));
  if (changed.length === 0 && deleted.length === 0) return { ok: true };
  const marked = sha => hasAssembleTrailer(git(cwd, ["log", "-1", "--format=%B", sha]));
  const problems = [];

  if (changed.length) {
    // 1. Direct edits.
    const edits = lines(git(cwd, ["rev-list", "--no-merges", `${base}..${head}`, "--", ...CHANGELOG_FILES]));
    const unmarked = edits.filter(sha => !marked(sha));
    if (unmarked.length) problems.push(`commits editing it directly: ${unmarked.map(s => s.slice(0, 12)).join(", ")}`);
    // 2. Every entry added or removed comes from a marked commit (merges included, judged against all parents).
    const sources = lines(git(cwd, ["rev-list", `${base}..${head}`])).filter(marked)
      .map(sha => ({ sha, parents: git(cwd, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1) }));
    for (const file of changed) {
      const atHead = blocksAt(cwd, head, file), atBase = blocksAt(cwd, mb, file);
      const explainedAdd = new Set(), explainedRemove = new Set();
      // A marked commit vouches for every difference from each of its parents (a marked merge: its resolution).
      for (const { sha, parents } of sources) {
        const mine = blocksAt(cwd, sha, file);
        for (const p of parents) {
          const before = blocksAt(cwd, p, file);
          for (const b of mine) if (!before.has(b)) explainedAdd.add(b);
          for (const b of before) if (!mine.has(b)) explainedRemove.add(b);
        }
      }
      const added = [...atHead].filter(b => !atBase.has(b) && !explainedAdd.has(b));
      const removed = [...atBase].filter(b => !atHead.has(b) && !explainedRemove.has(b));
      if (added.length) problems.push(`${file}: added by no "${ASSEMBLE_TRAILER}" commit: ${added.slice(0, 3).map(firstLine).join(" | ")}`);
      if (removed.length) problems.push(`${file}: removed by no "${ASSEMBLE_TRAILER}" commit (a merge resolved it away?): ${removed.slice(0, 3).map(firstLine).join(" | ")}`);
    }
  }

  // 3. A deleted fragment's entry is in the head's CHANGELOG.
  const headBlocks = { en: blocksAt(cwd, head, CHANGELOG_FILES[0]), zh: blocksAt(cwd, head, CHANGELOG_FILES[1]) };
  for (const file of deleted) {
    const parsed = parseFragment(git(cwd, ["show", `${mb}:${file}`]));
    if (parsed.error) continue;                   // was never a valid fragment; --check reported it when it landed
    const have = headBlocks[file.endsWith(".zh-TW.md") ? "zh" : "en"];
    if (!entryBlocks(parsed.body.split("\n")).every(b => have.has(b))) {
      problems.push(`${file} is deleted but its entry is not in the CHANGELOG: ${firstLine(parsed.body)}`);
    }
  }

  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `${problems.join("; ")}. Add changes/<issue>.md and changes/<issue>.zh-TW.md instead of editing the CHANGELOG`
      + ` (docs/development.md, "CHANGELOG fragments"); only the assemble commit, with the trailer "${ASSEMBLE_TRAILER}", edits it.`,
  };
}

export function main(argv, cwd = process.cwd()) {
  let base = null, head = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--head") head = argv[++i];
    else { console.error(`changelog-guard: unknown argument ${argv[i]}`); return 2; }
  }
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) { console.error("changelog-guard: --base and --head take commit SHAs"); return 2; }
  let result;
  try { result = checkChangelogEdits(cwd, base, head); } catch (err) {
    console.error(`changelog-guard: git failed: ${(err.stderr || err.message || "").toString().trim()}`);
    return 2;
  }
  if (result.ok) { console.log("changelog-guard: OK"); return 0; }
  console.log(`::error::${result.reason}`);
  console.error(`changelog-guard: ${result.reason}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
