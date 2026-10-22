/**
 * #2390: the web UI's words go through the locale layer (t() / a register() table with en and zh-TW).
 * - The literal scan: English written in place in src/ui — a text node or a literal aria-label / title / placeholder / alt
 *   / label / message / confirmLabel / subtitle / text attribute in an html`` template, or toast / confirmDialog / alert /
 *   setError / setMsg / setMessage called with a string. `${…}` is a value, not wording. The allowlist is wording that is
 *   not a sentence to translate (example placeholders, names, units), each with why.
 * - Key parity: every register() table in src/ui has the same keys in en and zh-TW (parsed with the TypeScript parser).
 * To clear a finding, put the words in the module's register() table and call t(); a name or an example goes on the list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "src", "ui");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === "vendor" ? [] : files(p)) : /\.js$/.test(n) && !/\.module\.js$/.test(n) ? [p] : [];
});
/** file<TAB>kind<TAB>text — not a sentence to translate. */
const ALLOWED = new Map<string, string>([
  ["shared/identity-color.js\tplaceholder\t#rrggbb", "a colour format"],
  ["shared/app-shell.js\ttext\tEnglish", "the language's own name in the language menu"],
  ["settings-wizard.js\tplaceholder\t/home/you/projects/app", "an example path"],
  ["settings-mods.js\tplaceholder\tmy-look", "an example mod name"],
  ["settings-effects.js\ttext\tKiB ·", "a unit"],
  ["settings-dialogs.js\tplaceholder\te.g. file:prompts/dev.md", "an example value (file: syntax)"],
  ["panel-settings.js\ttext\tcollab", "the config mode's name (channel collab)"],
  ["panel-settings.js\ttext\tClassicBot", "a product name"],
  ["panel-settings.js\tplaceholder\tagend.example.com", "an example hostname"],
  ["panel-fleet.js\tplaceholder\t/path/to/projects", "an example path"],
  ["backend-signin.js\tlabel\tURL", "an acronym, the same in both languages"],
]);

const parse = (code: string, at = "inline.js") => ts.createSourceFile(at, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
/**
 * Each html`…` template's static parts, with every ${…} replaced by "\u0000" — read with the TypeScript parser, so a
 * comment, a string or a regular expression inside ${…} (a backtick in it included) is code, never template text
 * (#2397 review). A template nested in an expression is a template of its own.
 */
function templates(code: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === "html") {
      const tpl = n.template;
      out.push(ts.isNoSubstitutionTemplateLiteral(tpl) ? tpl.text : [tpl.head.text, ...tpl.templateSpans.map((sp) => sp.literal.text)].join("\u0000"));
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(code));
  return out;
}
const english = (s: string) => /[A-Za-z]{3,}/.test(s.replace(/&[a-z]+;/g, ""));

/** English written in place in one module's source: text nodes and literal attributes of its html`` templates, and the calls. */
function literalsIn(code: string, at: string): string[] {
  const out: string[] = [];
  for (const body of templates(code)) {
    for (const t of body.matchAll(/>([^<>]*)</g)) for (const piece of t[1]!.split("\u0000")) { const text = piece.trim(); if (text && english(text)) out.push(`${at}\ttext\t${text}`); }
    for (const a of body.matchAll(/\b(aria-label|title|placeholder|alt|label|message|confirmLabel|subtitle|text)="([^"\u0000]*)"/g)) if (english(a[2]!)) out.push(`${at}\t${a[1]}\t${a[2]}`);
  }
  for (const c of code.matchAll(/\b(toast|confirmDialog|alert|setError|setMsg|setMessage)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) if (english(c[2]!)) out.push(`${at}\t${c[1]}\t${c[2]}`);
  return out;
}
export function uiLiterals(root = ROOT): string[] {
  return files(root).filter((f) => !/-strings\.js$/.test(f)).flatMap((f) => literalsIn(readFileSync(f, "utf8"), relative(root, f)));
}

const LANGS = ["en", "zh-TW"] as const;
/**
 * Every register("ns", {…}) call in one module: its gaps — a key one language has and the other lacks, a language whose
 * table is missing, or a call whose tables this check cannot read (#2397 review: such a call is a finding, never
 * skipped). `tables` counts the calls read in full.
 */
function registerGaps(code: string, at: string): { tables: number; gaps: string[] } {
  const sf = parse(code, at), gaps: string[] = [];
  let tables = 0;
  const keysOf = (o: ts.Expression): string[] | null => (ts.isObjectLiteralExpression(o)
    && o.properties.every((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
    ? o.properties.map((p) => ((p as ts.PropertyAssignment).name as ts.Identifier | ts.StringLiteral).text) : null);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "register") {
      const where = `${at}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      const [nsArg, byLangArg] = n.arguments;
      if (n.arguments.length !== 2 || !nsArg || !ts.isStringLiteral(nsArg) || !byLangArg || !ts.isObjectLiteralExpression(byLangArg)) { gaps.push(`${where}: register() this check cannot read`); return; }
      const byLang = new Map<string, ts.Expression>();
      for (const p of byLangArg.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) byLang.set(p.name.text, p.initializer);
        else gaps.push(`${where} ${nsArg.text}: a language table this check cannot read`);
      }
      for (const l of byLang.keys()) if (!(LANGS as readonly string[]).includes(l)) gaps.push(`${where} ${nsArg.text}: unknown language ${l}`);
      const keys = new Map<string, string[]>();
      for (const l of LANGS) {
        const table = byLang.get(l);
        if (!table) { gaps.push(`${where} ${nsArg.text}: no ${l} table`); continue; }
        const k = keysOf(table);
        if (!k) { gaps.push(`${where} ${nsArg.text}: the ${l} table is not plain key: "text" entries`); continue; }
        keys.set(l, k);
      }
      const en = keys.get("en"), zh = keys.get("zh-TW");
      if (en && zh) {
        tables++;
        gaps.push(...en.filter((k) => !zh.includes(k)).map((k) => `${where} ${nsArg.text}.${k}: no zh-TW`));
        gaps.push(...zh.filter((k) => !en.includes(k)).map((k) => `${where} ${nsArg.text}.${k}: no en`));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { tables, gaps };
}

describe("#2390 the web UI's words go through the locale layer", () => {
  it("no English written in place in src/ui (allowlist: names, examples, units)", () => {
    expect(uiLiterals().filter((l) => !ALLOWED.has(l))).toEqual([]);
  });

  it("the allowlist is still needed: every entry is wording the scan finds", () => {
    const found = new Set(uiLiterals());
    expect([...ALLOWED.keys()].filter((a) => !found.has(a))).toEqual([]);
  });

  it("every register() call in src/ui has an en and a zh-TW table with the same keys", () => {
    const all = files(ROOT).map((f) => registerGaps(readFileSync(f, "utf8"), relative(ROOT, f)));
    expect(all.reduce((n, r) => n + r.tables, 0)).toBeGreaterThanOrEqual(26);
    expect(all.flatMap((r) => r.gaps)).toEqual([]);
  });

  it("the scan sees each shape, through code that only looks like a template (so a pass means something)", () => {
    expect(templates('html`<p>${tn("x")}</p>`')).toEqual(["<p>\u0000</p>"]);
    expect(templates("html`<a>${ok ? html`<b>Done</b>` : null}</a>`")).toEqual(["<a>\u0000</a>", "<b>Done</b>"]);
    const after = '</p><button title="Translate me">Save now</button>`;';
    // #2397 review: a backtick in a comment or a regular expression inside ${…} must not hide the static English after it.
    for (const code of [
      'const v = html`<p>${ t("ok") }' + after,                                  // control
      'const v = html`<p>${ /* ` code sample */ t("ok") }' + after,
      'const v = html`<p>${ /`/.test(value) ? t("yes") : t("no") }' + after,
      'const v = html`<p>${ "`" + t("ok") }' + after,
    ]) expect(literalsIn(code, "x.js"), code).toEqual(["x.js\ttext\tSave now", "x.js\ttitle\tTranslate me"]);
    expect(literalsIn('const v = html`<p>${t("a")}</p><button title=${t("b")}>${t("c")}</button>`;', "x.js")).toEqual([]);
    expect(literalsIn('toast("Saved"); toast(t("saved"));', "x.js")).toEqual(['x.js\ttoast\t"Saved"']);
  });

  it("parity reads every register() call: a language missing whole is a finding, never a skip", () => {
    expect(registerGaps('register("demo", { en: { hello: "Hello" }, "zh-TW": { hello: "你好" } });', "x.js")).toEqual({ tables: 1, gaps: [] });
    expect(registerGaps('register("demo", { en: { hello: "Hello" } });', "x.js").gaps).toEqual(["x.js:1 demo: no zh-TW table"]);
    expect(registerGaps('register("demo", { "zh-TW": { hello: "你好" } });', "x.js").gaps).toEqual(["x.js:1 demo: no en table"]);
    expect(registerGaps('register("demo", { en: { a: "A", b: "B" }, "zh-TW": { a: "甲" } });', "x.js").gaps).toEqual(["x.js:1 demo.b: no zh-TW"]);
    expect(registerGaps('register("demo", { en: { a: "A" }, "zh-TW": { a: "甲" }, fr: { a: "A" } });', "x.js").gaps).toEqual(["x.js:1 demo: unknown language fr"]);
    expect(registerGaps('register("demo", { en: { ...base, a: "A" }, "zh-TW": { a: "甲" } });', "x.js").gaps).toEqual(['x.js:1 demo: the en table is not plain key: "text" entries']);
    expect(registerGaps("register(name, tables);", "x.js").gaps).toEqual(["x.js:1: register() this check cannot read"]);
  });
});
