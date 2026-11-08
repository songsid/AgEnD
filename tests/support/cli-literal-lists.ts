/**
 * AGEND-115: finds the places in `src` that write out a list of CLI ids by hand — the thing the CLI registry (src/cli-registry.ts) replaced. A "literal list" is
 * a line, or an array or object literal across lines, that names two or more different CLIs (as quoted strings, or as object keys). It is a heuristic for a
 * review tool, not a parser: it reads text, and it is meant to over-report rather than to miss one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CLI_IDS } from "../../src/cli-capability.js";

const ids = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const id of CLI_IDS) {
    const bare = /^[A-Za-z_$][\w$]*$/.test(id);
    if (text.includes(`"${id}"`) || text.includes(`'${id}'`) || text.includes(`\`${id}\``) || (bare && new RegExp(`\\b${id}\\s*:`).test(text))) found.add(id);
  }
  return found;
};

export interface LiteralList { file: string; line: number; ids: string[]; text: string }

function files(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { if (!["node_modules", "vendor", "dist"].includes(name)) files(path, out); }
    else if (/\.(ts|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Every literal list under `root`, except in the registry's own files and the file generated from it (src/ui/cli-caps.js). */
export function literalLists(root: string): LiteralList[] {
  const lists: LiteralList[] = [];
  for (const path of files(root).sort()) {
    const file = relative(join(root, ".."), path).replaceAll("\\", "/");
    if (/^src\/(?:cli-registry(?:-check)?|cli-capability|cli-caps-module|cli-spec-[a-z-]+)\.ts$/.test(file) || file === "src/ui/cli-caps.js") continue;
    const source = readFileSync(path, "utf8");
    const starts: number[] = [0];
    for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) starts.push(at + 1);
    const lineOf = (index: number): number => {                       // the line of a character index, by binary search over the line starts
      let low = 0, high = starts.length - 1;
      while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid]! <= index) low = mid; else high = mid - 1; }
      return low + 1;
    };
    const seen = new Map<number, LiteralList>();
    const add = (line: number, found: Set<string>, text: string): void => { if (found.size >= 2 && !seen.has(line)) seen.set(line, { file, line, ids: [...found].sort(), text: text.trim().slice(0, 120) }); };
    source.split("\n").forEach((text, index) => add(index + 1, ids(text), text));
    for (const group of source.matchAll(/\[[^\[\]]*\]|\{[^{}]*\}/g)) if (group[0].includes("\n")) add(lineOf(group.index!), ids(group[0]), group[0].split("\n")[0]!);
    lists.push(...seen.values());
  }
  return lists;
}

/** The count per file. */
export function literalListCounts(root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const list of literalLists(root)) counts[list.file] = (counts[list.file] ?? 0) + 1;
  return counts;
}
