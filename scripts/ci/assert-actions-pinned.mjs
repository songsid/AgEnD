#!/usr/bin/env node
/**
 * Fail if any GitHub Actions `uses:` in .github/workflows or .github/actions
 * is not pinned to a 40-char commit SHA. Local composite paths (`./…`) are
 * allowed; their own `uses:` are checked too. #2528
 *
 * Reads mapping keys (bare or quoted) and flow-style `{uses: …}` / `[{uses: …}]`.
 * A `uses` key in a form this scanner cannot take a value from fails closed.
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
const BLOCK_USES = /^\s*-?\s*["']?uses["']?\s*:\s*(.+?)\s*$/;
const FLOW_USES = /(?:^|[\s,{\[])["']?uses["']?\s*:\s*(?:["']([^"']+)["']|([^,}\]\s]+))/g;
const USES_KEY = /["']?uses["']?\s*:/;
const MULTILINE = /^(?:[|>][+-]?)$/;

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

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function extractUses(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = stripComment(raw);
    if (!line.trim()) return;
    const n = i + 1;
    if (/[\{\[]/.test(line) && USES_KEY.test(line)) {
      FLOW_USES.lastIndex = 0;
      let m;
      let nFlow = 0;
      while ((m = FLOW_USES.exec(line))) {
        found.push({ line: n, value: unquote(m[1] || m[2] || "") });
        nFlow++;
      }
      if (nFlow === 0) found.push({ line: n, value: "", unsupported: true, raw: line.trim() });
      return;
    }
    const b = BLOCK_USES.exec(line);
    if (!b) return;
    found.push({ line: n, value: unquote(b[1]) });
  });
  return found;
}

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
      unpinned.push(`${rel}:${hit.line}: unsupported uses form: ${hit.raw}`);
      continue;
    }
    const value = hit.value;
    if (!value) {
      unpinned.push(`${rel}:${hit.line}: empty uses`);
      continue;
    }
    if (MULTILINE.test(value)) {
      unpinned.push(`${rel}:${hit.line}: multiline uses value is unsupported`);
      continue;
    }
    if (LOCAL.test(value)) continue;
    if (PINNED.test(value)) continue;
    unpinned.push(`${rel}:${hit.line}: ${value}`);
  }
}

if (unpinned.length > 0) {
  console.error("Unpinned GitHub Actions `uses:` (need owner/repo@<40-char-sha> # tag):");
  for (const row of unpinned) console.error(`  ${row}`);
  process.exit(1);
}

console.log(`ok: ${files.length} files, every remote uses: is a 40-char SHA`);
