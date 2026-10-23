#!/usr/bin/env node
/**
 * Fail if any GitHub Actions `uses:` in .github/workflows or .github/actions
 * is not pinned to a 40-char commit SHA. Local composite paths (`./…`) are
 * allowed; their own `uses:` are checked too. #2528
 *
 * Parses YAML with the lockfile's js-yaml (4.3.2, package-lock integrity).
 * The actions-pinned job runs npm ci --ignore-scripts first. Load errors and
 * non-string uses values fail closed.
 *
 *   node scripts/ci/assert-actions-pinned.mjs
 *   node scripts/ci/assert-actions-pinned.mjs --root <dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const github = join(root, ".github");

const LOCAL = /^\.\//;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;

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

function collectUses(node, found) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectUses(item, found);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "uses") {
      if (typeof value !== "string") {
        found.push({ value: "", unsupported: true, raw: "uses value is not a string" });
      } else {
        found.push({ value: value.trim() });
      }
    }
    collectUses(value, found);
  }
}

function extractUses(text) {
  const found = [];
  let docs;
  try {
    docs = yaml.loadAll(text);
  } catch (e) {
    found.push({
      line: 1,
      value: "",
      unsupported: true,
      raw: e instanceof Error ? e.message : String(e),
    });
    return found;
  }
  for (const doc of docs) collectUses(doc, found);
  return found;
}

export { extractUses };

function main() {
  const files = walk(join(github, "workflows")).concat(walk(join(github, "actions")));
  if (files.length === 0) {
    console.error(`no workflow/action yaml under ${relative(process.cwd(), github) || ".github"}`);
    process.exit(2);
  }

  const unpinned = [];
  for (const file of files) {
    const rel = relative(root, file);
    const found = extractUses(readFileSync(file, "utf8"));
    for (const hit of found) {
      if (hit.unsupported) {
        unpinned.push(`${rel}: unsupported uses form: ${hit.raw}`);
        continue;
      }
      const value = hit.value;
      if (!value) {
        unpinned.push(`${rel}: empty uses`);
        continue;
      }
      if (LOCAL.test(value)) continue;
      if (PINNED.test(value)) continue;
      unpinned.push(`${rel}: ${value}`);
    }
  }

  if (unpinned.length > 0) {
    console.error("Unpinned GitHub Actions `uses:` (need owner/repo@<40-char-sha> # tag):");
    for (const row of unpinned) console.error(`  ${row}`);
    process.exit(1);
  }

  console.log(`ok: ${files.length} files, every remote uses: is a 40-char SHA`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) main();
