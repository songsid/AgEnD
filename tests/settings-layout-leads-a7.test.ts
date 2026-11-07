/**
 * alpha.6 feedback (#3): Settings → Notifications showed its page lead as the raw key "settingsLayout.lead_notifications" —
 * the section was added without its lead. Every section the Settings list offers has its lead in English and in zh-TW
 * (SettingsPageHead prints settingsLayout.lead_<section> for each one except Runtime, which draws its own head).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
// The browser module, read as data (it has no type declarations).
const { SETTINGS_SECTIONS } = (await import(join(__dirname, "..", "src", "ui", "shared", "app-route.js"))) as { SETTINGS_SECTIONS: readonly string[] };

const file = join(__dirname, "..", "src", "ui", "settings-layout.js");
/** Every key of every register("settingsLayout", { en: {…}, "zh-TW": {…} }) table, per language. */
function leadKeys(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = { en: new Set(), "zh-TW": new Set() };
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const name = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : "");
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "register" && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "settingsLayout" && ts.isObjectLiteralExpression(n.arguments[1])) {
      for (const lang of n.arguments[1].properties) if (ts.isPropertyAssignment(lang) && Object.hasOwn(out, name(lang.name)) && ts.isObjectLiteralExpression(lang.initializer))
        for (const p of lang.initializer.properties) if (ts.isPropertyAssignment(p)) out[name(lang.name)]!.add(name(p.name));
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe("Settings page leads (alpha.6 feedback #3)", () => {
  it("every section in the Settings list has its lead in en and zh-TW", () => {
    const keys = leadKeys();
    const missing = SETTINGS_SECTIONS.filter((s: string) => s !== "runtimes").flatMap((s: string) => ["en", "zh-TW"].filter((l) => !keys[l]!.has(`lead_${s}`)).map((l) => `${l}:lead_${s}`));
    expect(missing).toEqual([]);
  });
});
