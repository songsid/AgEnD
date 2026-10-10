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
 * A machine code a detector matches as one word: UNAUTHENTICATED, RESOURCE_EXHAUSTED, invalid_api_key,
 * ExpiredTokenException. (A single English word is not one: it is everywhere and says nothing.)
 */
export function machineToken(s: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(s) && s.length >= 6
    || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s) && s.length >= 8
    || /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+(?:Exception|Error)$/.test(s);
}

/** What a literal must be to be kept: screen text or a machine code. */
export function kept(s: string): boolean { return prose(s) || machineToken(s); }

/**
 * The literal text runs of a regex source: the characters between its operators, kept when they read as screen text
 * (with a space) or are a machine code. An escaped punctuation character is itself; whitespace that must be there
 * (\\s, \\s+, [ \\t]+, a space) is one space; a class, an anchor, a group or an alternation ends the run; a character
 * a quantifier makes optional (?, *, {0,…}) is left out — so every run is text the match really contains.
 */
export function regexRuns(source: string): string[] {
  const out: string[] = [];
  let run = "";
  // Trimmed of the punctuation at either end: "Resume from summary (" is "Resume from summary" — what the CLI stores.
  const end = () => {
    const r = run.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if ((r.length >= 6 && /[A-Za-z]{3}/.test(r) && / /.test(r)) || machineToken(r)) out.push(r);
    run = "";
  };
  /** Whitespace that is required (no ?, * or {0,…} after it) is one space in the text; optional whitespace ends the run. */
  const space = (next: number): number => {
    const q = source[next];
    if (q === "+") { run += " "; return next; }
    if (q === "?" || q === "*") { end(); return next; }
    if (q === "{") { const m = /^\{(\d+)(,\d*)?\}/.exec(source.slice(next)); if (m) { if (m[1] === "0") end(); else run += " "; return next + m[0].length - 1; } }
    run += " ";
    return next - 1;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      const d = source[i + 1] ?? "";
      i++;
      if (d === "s") { i = space(i + 1); continue; }
      if (/[SdDwWbBnrtfv0-9cpPkK]/.test(d)) { end(); if (/[pPk]/.test(d) && source[i + 1] === "{") i = source.indexOf("}", i) < 0 ? source.length : source.indexOf("}", i); continue; }
      if (d === "x") { end(); i += 2; continue; }
      if (d === "u") { end(); i += source[i + 1] === "{" ? source.indexOf("}", i) - i : 4; continue; }
      run += d;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      for (; j < source.length && source[j] !== "]"; j++) if (source[j] === "\\") j++;
      const body = source.slice(i + 1, j);
      i = j;
      if (body && !body.startsWith("^") && /^(?:[ \t]|\\s|\\t)+$/.test(body)) { i = space(i + 1); continue; }   // [ \t] is whitespace
      end();
      continue;
    }
    if (c === " ") { i = space(i + 1); continue; }
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
  return [...new Set(out.map((r) => r.replace(/ {2,}/g, " ")))];
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

/** A parameter of AgEnD's own helper that carries AgEnD's words (a dialog's name, its key, its description). */
const OWN_PARAMS = new Set(["description", "message", "name", "key", "label", "what", "reason", "notice"]);
/** Regex syntax in a string: it is a regex source kept in a string (passed to RegExp later), read as one too. */
const REGEX_SYNTAX = /\|.*\S|\\[sdwb]|\[\^?[^\]]*\]|\(\?:/;

/** The names of every declaration in a file (functions, classes, methods, variables, object keys). */
export function declarationNames(file: string): Set<string> {
  const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Set<string>();
  const visit = (node: ts.Node) => { const n = nameOf(node); if (n !== null) out.add(n); ts.forEachChild(node, visit); };
  visit(sf);
  return out;
}

/** Every kept literal of one source entry. */
export function literalsOf(entry: SourceEntry, source?: string): ManifestLiteral[] {
  const path = join(ROOT, entry.file);
  const text = source ?? readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ManifestLiteral[] = [];
  const want = entry.symbols ? new Set(entry.symbols) : null;
  const skip = new Set(entry.exclude ?? []);
  // The file's own functions: which of their parameters hold AgEnD's words (claudeConfirmDialogEntries(pattern, name, …)).
  const ownParams = new Map<string, Set<number>>();
  const collect = (node: ts.Node) => {
    let fname: string | null = null, params: ts.NodeArray<ts.ParameterDeclaration> | null = null;
    if (ts.isFunctionDeclaration(node) && node.name) { fname = node.name.text; params = node.parameters; }
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      fname = node.name.text; params = node.initializer.parameters;
    }
    if (fname && params) {
      const at = new Set<number>();
      params.forEach((p, i) => { if (ts.isIdentifier(p.name) && OWN_PARAMS.has(p.name.text)) at.add(i); });
      if (at.size) ownParams.set(fname, at);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const add = (t: string, kind: ManifestLiteral["kind"], at: ts.Node, names: string[]) => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    out.push({ text: t, kind, surface: surfaceOf(names, entry.surfaces), file: entry.file, line, symbol: names.join(".") || "(top level)" });
  };
  const isStringRaw = (n: ts.Node): n is ts.TaggedTemplateExpression =>
    ts.isTaggedTemplateExpression(n) && ts.isPropertyAccessExpression(n.tag) && ts.isIdentifier(n.tag.expression) && n.tag.expression.text === "String" && n.tag.name.text === "raw";
  /** One piece of text: as a regex source inside RegExp(…) (or when it is plainly one), else as screen text. */
  const piece = (t: string, kind: ManifestLiteral["kind"], at: ts.Node, names: string[], asRegex: boolean) => {
    if (asRegex) { for (const r of regexRuns(t)) add(r, "regex", at, names); return; }
    if (kept(t)) add(t, kind, at, names);
    if (REGEX_SYNTAX.test(t)) for (const r of regexRuns(t)) add(r, "regex", at, names);
  };
  const visit = (node: ts.Node, names: string[], own: boolean, inScope: boolean, asRegex: boolean) => {
    const n = nameOf(node);
    if (n !== null) {
      if (skip.has(n)) return;
      if (OWN_FIELDS.has(n) && ts.isPropertyAssignment(node)) own = true;
      names = [...names, n];
      if (want && want.has(n)) inScope = true;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeName(node);
      if (callee && OWN_CALLS.has(callee)) own = true;
      const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      if (callee === "RegExp" && args.length) {
        // new RegExp(…): every string in its first argument — concatenated, templated, String.raw — is regex source.
        visit(args[0]!, names, own, inScope, true);
        args.slice(1).forEach((a) => visit(a, names, own, inScope, false));
        visit(node.expression, names, own, inScope, false);
        return;
      }
      const ownAt = callee ? ownParams.get(callee) : undefined;
      if (ownAt) {
        visit(node.expression, names, own, inScope, asRegex);
        args.forEach((a, i) => visit(a, names, own || ownAt.has(i), inScope, asRegex));
        return;
      }
    }
    if (ts.isThrowStatement(node)) own = true;
    if (inScope && !own) {
      if (isStringRaw(node)) {
        const tpl = node.template;
        const parts = ts.isNoSubstitutionTemplateLiteral(tpl) ? [tpl] : [tpl.head, ...tpl.templateSpans.map((sp) => sp.literal)];
        for (const part of parts) piece(part.rawText ?? part.text, "template", part, names, asRegex);
        if (!ts.isNoSubstitutionTemplateLiteral(tpl)) tpl.templateSpans.forEach((sp) => visit(sp.expression, names, own, inScope, asRegex));
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        piece(node.text, ts.isStringLiteral(node) ? "string" : "template", node, names, asRegex);
      } else if (ts.isTemplateExpression(node)) {
        for (const part of [node.head, ...node.templateSpans.map((sp) => sp.literal)]) piece(part.text, "template", part, names, asRegex);
      } else if (ts.isRegularExpressionLiteral(node)) {
        const src = node.text.slice(1, node.text.lastIndexOf("/"));
        for (const r of regexRuns(src)) add(r, "regex", node, names);
      }
    }
    ts.forEachChild(node, (c) => visit(c, names, own, inScope, asRegex));
  };
  visit(sf, [], false, want === null, false);
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
