/**
 * Hub UX U3 (spec 1.4): every string a UI module registers with app-i18n — `register("ns", { en: {…}, "zh-TW": {…} })` — read
 * from the source with the TypeScript parser (nothing is executed). Plain strings, template literals without
 * substitutions, and "a" + "b" concatenations of those are read; anything else is reported as `unread` so a gate never
 * passes by skipping a value it could not see.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";

export interface UiString { file: string; ns: string; lang: string; key: string; text: string }
export interface UiDictionaries { strings: UiString[]; unread: string[] }

const text = (n: ts.Expression): string | null => {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { const a = text(n.left), b = text(n.right); return a !== null && b !== null ? a + b : null; }
  if (ts.isParenthesizedExpression(n)) return text(n.expression);
  return null;
};
const name = (p: ts.PropertyName): string | null => ts.isIdentifier(p) || ts.isStringLiteral(p) || ts.isNumericLiteral(p) ? p.text : null;

export function uiDictionaries(file: string): UiDictionaries {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const strings: UiString[] = [], unread: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "register" && node.arguments.length >= 2) {
      const [nsArg, dict] = node.arguments;
      const ns = nsArg && text(nsArg as ts.Expression);
      // #3700 r1 (Fable): a namespace or a dictionary that is not a literal is reported, never skipped.
      if (ns === null || ns === undefined) unread.push(`${file}: register() with a namespace that is not a literal string`);
      else if (!dict || !ts.isObjectLiteralExpression(dict)) unread.push(`${file}: ${ns}: register() with a dictionary that is not an object literal`);
      if (ns !== null && ns !== undefined && dict && ts.isObjectLiteralExpression(dict)) {
        for (const langProp of dict.properties) {
          if (!ts.isPropertyAssignment(langProp) || !ts.isObjectLiteralExpression(langProp.initializer)) { unread.push(`${file}: ${ns}: a language entry that is not an object`); continue; }
          const lang = name(langProp.name) ?? "?";
          for (const p of langProp.initializer.properties) {
            const key = ts.isPropertyAssignment(p) ? name(p.name) : null;
            const value = ts.isPropertyAssignment(p) ? text(p.initializer) : null;
            if (key === null || value === null) { unread.push(`${file}: ${ns}.${lang}.${key ?? "?"}`); continue; }
            strings.push({ file, ns, lang, key, text: value });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { strings, unread };
}
