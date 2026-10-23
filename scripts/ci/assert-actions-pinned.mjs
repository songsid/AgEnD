#!/usr/bin/env node
/**
 * Fail if any GitHub Actions `uses:` in .github/workflows or .github/actions
 * is not pinned to a 40-char commit SHA. Local composite paths (`./…`) are
 * allowed; their own `uses:` are checked too. #2528
 *
 *   node scripts/ci/assert-actions-pinned.mjs
 *   node scripts/ci/assert-actions-pinned.mjs --root <dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const github = join(root, ".github");

const LOCAL = /^\.\//;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const USES = /^\s+-?\s*uses:\s*(\S+)/;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".yml") || name.endsWith(".yaml")) acc.push(p);
  }
  return acc;
}

const files = walk(join(github, "workflows")).concat(walk(join(github, "actions")));
if (files.length === 0) {
  console.error(`no workflow/action yaml under ${relative(process.cwd(), github) || ".github"}`);
  process.exit(2);
}

const unpinned = [];
for (const file of files) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const value = m[1];
    if (LOCAL.test(value)) return;
    if (PINNED.test(value)) return;
    unpinned.push(`${rel}:${i + 1}: ${value}`);
  });
}

if (unpinned.length > 0) {
  console.error("Unpinned GitHub Actions `uses:` (need owner/repo@<40-char-sha> # tag):");
  for (const row of unpinned) console.error(`  ${row}`);
  process.exit(1);
}

console.log(`ok: ${files.length} files, every remote uses: is a 40-char SHA`);
