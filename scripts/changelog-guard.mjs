#!/usr/bin/env node
/**
 * CI guard for CHANGELOG fragments (run on pull requests by ci.yml):
 *
 *   node scripts/changelog-guard.mjs --base <base sha> --head <head sha>
 *
 * A PR adds `changes/<issue>.md` + `changes/<issue>.zh-TW.md` (scripts/changelog-assemble.mjs) and leaves
 * docs/CHANGELOG*.md alone. If the PR's change (merge-base...head, so what a merge-sync brought in from main is not
 * counted) touches either CHANGELOG, every commit of the PR that changes them must carry the trailer
 * `Changelog: assemble`, and there must be at least one: that is the assemble commit a release PR makes. A clean
 * merge-sync is not such a commit (git's history simplification drops a merge whose CHANGELOG equals one parent's);
 * a merge that changes the CHANGELOG itself (a conflict resolution, or an edit slipped into it) is, and needs the
 * trailer in its message like any other.
 *
 * Exit 0 when allowed, 1 with the reason when not, 2 on bad arguments or a git failure.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSEMBLE_TRAILER } from "./changelog-assemble.mjs";

export const CHANGELOG_FILES = ["docs/CHANGELOG.md", "docs/CHANGELOG.zh-TW.md"];
const SHA = /^[0-9a-f]{7,64}$/;

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** True when a commit message has the assemble trailer on a line of its own. */
export function hasAssembleTrailer(message) {
  return message.split(/\r?\n/).some(line => line.trim() === ASSEMBLE_TRAILER);
}

/** Returns { ok: true } or { ok: false, reason }. Throws on a git failure. */
export function checkChangelogEdits(cwd, base, head) {
  const changed = git(cwd, ["diff", "--name-only", `${base}...${head}`, "--", ...CHANGELOG_FILES]).split("\n").filter(Boolean);
  if (changed.length === 0) return { ok: true };
  const commits = git(cwd, ["rev-list", `${base}..${head}`, "--", ...CHANGELOG_FILES]).split("\n").filter(Boolean);
  const unmarked = commits.filter(sha => !hasAssembleTrailer(git(cwd, ["log", "-1", "--format=%B", sha])));
  if (commits.length > 0 && unmarked.length === 0) return { ok: true };
  const list = unmarked.length ? ` Commits editing it directly: ${unmarked.map(s => s.slice(0, 12)).join(", ")}.` : "";
  return {
    ok: false,
    reason: `${changed.join(" and ")} changed by this PR.${list} Add changes/<issue>.md and changes/<issue>.zh-TW.md instead`
      + ` (docs/development.md, "CHANGELOG fragments"); only the assemble commit, with the trailer "${ASSEMBLE_TRAILER}", edits the CHANGELOG.`,
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
