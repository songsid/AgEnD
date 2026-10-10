/**
 * Builds manifest.json: for each backend, every piece of text AgEnD's detectors match in that CLI's pane, read from the
 * source with the TypeScript parser (sources.json says where). precheck.py counts each one in an old and a new release.
 *
 *   npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts           # write manifest.json
 *   npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts --check   # exit 1 if manifest.json is stale
 *
 * Kept: string literals, template literal parts and the literal text runs of regexes (and of `new RegExp("…")`), when
 * they read like screen text (letters and a space; see `prose`/`regexRuns`). Never kept: AgEnD's own fields of a
 * dialog/error entry (description, message, …), the arguments of t(), logger calls and Error constructors.
 * tests/cli-upstream-precheck.test.ts fails when manifest.json no longer matches the source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SURFACES = ["dialog", "approval", "trust", "onboarding", "resume", "error", "idle-busy", "input-box", "exit", "other"] as const;
export type Surface = typeof SURFACES[number];
export interface ManifestLiteral { text: string; kind: "string" | "template" | "regex"; surface: Surface; file: string; line: number; symbol: string }
export interface Manifest { format: 1; source: string; backends: Record<string, { literals: ManifestLiteral[] }> }
interface SourceEntry { file: string; symbols?: string[]; exclude?: string[]; surfaces?: Record<string, Surface> }

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..", "..");
export const MANIFEST_PATH = join(HERE, "manifest.json");

/** AgEnD's own fields in a dialog / error / transient entry: what it says or presses, never what the CLI shows. */
const OWN_FIELDS = new Set(["description", "message", "formatMessage", "postDismissNotice", "fatal", "keys", "autoResolutionKey", "what"]);
/** Calls whose string arguments are AgEnD's own text. */
const OWN_CALLS = new Set(["t", "Error", "TypeError", "RangeError", "warn", "info", "debug", "error", "log", "trace", "fatal"]);

/** Screen text: 6–200 characters with a word of three letters, a space, and more letters (predlits.py's rule). */
export function prose(s: string): boolean {
  return s.length >= 6 && s.length <= 200 && /[A-Za-z]{3}.*\s.*[A-Za-z]{2}/s.test(s) && !/^[a-z_]+(\.[a-z_]+)+$/.test(s);
}

/**
 * The literal text runs of a regex source: the characters between its operators, at least 6 with a space. An escaped
 * punctuation character is itself; a class (\\s, \\d, [..]), an anchor, a group or an alternation ends the run; a
 * character a quantifier makes optional (?, *, {0,…}) is left out, so every run is text the match really contains.
 */
export function regexRuns(source: string): string[] {
  const out: string[] = [];
  let run = "";
  // Trimmed of the punctuation at either end: "Resume from summary (" is "Resume from summary" — what the CLI stores.
  const end = () => { const r = run.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""); if (r.length >= 6 && /[A-Za-z]{3}/.test(r) && / /.test(r)) out.push(r); run = ""; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      const d = source[i + 1] ?? "";
      i++;
      if (/[sSdDwWbBnrtfv0-9cpPkK]/.test(d)) { end(); if (/[pPk]/.test(d) && source[i + 1] === "{") i = source.indexOf("}", i) < 0 ? source.length : source.indexOf("}", i); continue; }
      if (d === "x") { end(); i += 2; continue; }
      if (d === "u") { end(); i += source[i + 1] === "{" ? source.indexOf("}", i) - i : 4; continue; }
      run += d;
      continue;
    }
    if (c === "[") { end(); for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++; continue; }
    if (c === "(") { end(); if (source[i + 1] === "?") { i++; if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") i = source.indexOf(">", i); else i += source[i + 1] === "<" ? 2 : 1; } continue; }
    if (c === "?" || c === "*") { run = run.slice(0, -1); end(); continue; }
    if (c === "{") {
      const m = /^\{(\d+)(,\d*)?\}/.exec(source.slice(i));
      if (m) { if (m[1] === "0") run = run.slice(0, -1); end(); i += m[0].length - 1; continue; }
    }
    if (")|^$.+".includes(c)) { end(); continue; }
    run += c;
  }
  end();
  return out;
}

/** The surface a declaration's name says, when sources.json does not say it. */
export function surfaceOf(names: string[], overrides: Record<string, Surface> = {}): Surface {
  for (let i = names.length - 1; i >= 0; i--) if (overrides[names[i]!]) return overrides[names[i]!]!;
  const n = names.join(".").toLowerCase();
  const rules: Array<[RegExp, Surface]> = [
    [/trust/, "trust"],
    [/bypass|dangerous|permission|approv|consent|allow|danger/, "approval"],
    [/login|onboard|theme|oauth|apikey|security ?notes|terminalsetup|auth/, "onboarding"],
    [/resume|continue|session|noconversation|conversation/, "resume"],
    [/error|retry|rate|limit|overload|crash|fail|disconnect|quota|unavailable/, "error"],
    [/exit|quit|background/, "exit"],
    [/inputbox|input|paste|queue|composer|placeholder|draft|separator|statusbar|footer|box/, "input-box"],
    [/ready|busy|idle|spinner|status|working|thinking|interrupt|livetail|tick|redraw|context|progress/, "idle-busy"],
    [/dialog|prompt|modal|menu|confirm|question|choice|picker|selection|survey/, "dialog"],
  ];
  for (const [re, s] of rules) if (re.test(n)) return s;
  return "other";
}

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name) {
    const n = node.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  }
  return null;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Every kept literal of one source entry. */
export function literalsOf(entry: SourceEntry): ManifestLiteral[] {
  const path = join(ROOT, entry.file);
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ManifestLiteral[] = [];
  const want = entry.symbols ? new Set(entry.symbols) : null;
  const skip = new Set(entry.exclude ?? []);
  const add = (t: string, kind: ManifestLiteral["kind"], at: ts.Node, names: string[]) => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    out.push({ text: t, kind, surface: surfaceOf(names, entry.surfaces), file: entry.file, line, symbol: names.join(".") || "(top level)" });
  };
  const visit = (node: ts.Node, names: string[], own: boolean, inScope: boolean) => {
    const n = nameOf(node);
    if (n !== null) {
      if (skip.has(n)) return;
      if (OWN_FIELDS.has(n) && ts.isPropertyAssignment(node)) own = true;
      names = [...names, n];
      if (want && want.has(n)) inScope = true;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))) {
      const callee = calleeName(node);
      if (callee && OWN_CALLS.has(callee)) own = true;
      // new RegExp("…") / RegExp("…"): its string argument is a regex source.
      if (callee === "RegExp" && node.arguments?.length && ts.isStringLiteralLike(node.arguments[0]!) && inScope && !own) {
        for (const r of regexRuns(node.arguments[0]!.text)) add(r, "regex", node.arguments[0]!, names);
        node.arguments.slice(1).forEach((a) => visit(a, names, own, inScope));
        return;
      }
    }
    if (ts.isThrowStatement(node)) own = true;
    if (inScope && !own) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (prose(node.text)) add(node.text, ts.isStringLiteral(node) ? "string" : "template", node, names);
      } else if (ts.isTemplateExpression(node)) {
        for (const part of [node.head, ...node.templateSpans.map((s) => s.literal)]) if (prose(part.text)) add(part.text, "template", part, names);
      } else if (ts.isRegularExpressionLiteral(node)) {
        const src = node.text.slice(1, node.text.lastIndexOf("/"));
        for (const r of regexRuns(src)) add(r, "regex", node, names);
      }
    }
    ts.forEachChild(node, (c) => visit(c, names, own, inScope));
  };
  visit(sf, [], false, want === null);
  return out;
}

/** The manifest the sources produce now: one entry per (backend, text), at its first place in the source. */
export function buildManifest(): Manifest {
  const sources = JSON.parse(readFileSync(join(HERE, "sources.json"), "utf8")) as { backends: Record<string, SourceEntry[]> };
  const backends: Manifest["backends"] = {};
  for (const [backend, entries] of Object.entries(sources.backends)) {
    const seen = new Map<string, ManifestLiteral>();
    for (const e of entries) for (const l of literalsOf(e)) if (!seen.has(l.text)) seen.set(l.text, l);
    backends[backend] = { literals: [...seen.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line) || (a.text < b.text ? -1 : 1)) };
  }
  return { format: 1, source: relative(ROOT, join(HERE, "sources.json")), backends };
}

export function manifestJson(m: Manifest): string { return JSON.stringify(m, null, 1) + "\n"; }

/**
 * What the drift check compares: every literal with its surface, kind and declaration — not its line, which moves
 * with any edit above it (the line in manifest.json is where to look, refreshed whenever the manifest is rebuilt).
 */
export function manifestKeys(m: Manifest): string[] {
  const out: string[] = [];
  for (const [b, { literals }] of Object.entries(m.backends)) for (const l of literals) out.push(JSON.stringify([b, l.text, l.kind, l.surface, l.file, l.symbol]));
  return out.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = buildManifest();
  const json = manifestJson(m);
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(MANIFEST_PATH, "utf8"); } catch { /* missing */ }
    let stale = true;
    try { stale = JSON.stringify(manifestKeys(JSON.parse(current))) !== JSON.stringify(manifestKeys(m)); } catch { /* unreadable: stale */ }
    if (stale) { console.error("manifest.json is stale: run npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts"); process.exit(1); }
    console.log("manifest.json is current");
  } else {
    writeFileSync(MANIFEST_PATH, json);
    for (const [b, { literals }] of Object.entries(m.backends)) console.log(`${b}: ${literals.length} literals`);
  }
}
