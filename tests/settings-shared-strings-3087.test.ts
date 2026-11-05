/**
 * #3087 review: the words Shared agent settings added or reworded live in src/ui/settings-shared-strings.js, not in
 * settings-strings.js. A tab opened before an upgrade has already run the old settings-strings.js, and the browser hands
 * the same module back when the new Settings page imports that URL again, so a key that only the new settings-strings.js
 * had would read as the raw `settings.…` key there. The new file's URL is new: no tab holds an old copy of it.
 *   - Ownership: a key is in one of the two files, never both; the new file has the same keys and {n} placeholders in en and zh-TW.
 *   - Readers: every module that prints one of the words imports the new file (after settings-strings.js).
 *   - Load: importing any of those modules into a tab whose settings table is the old one gives every new word, and the new
 *     wording of one that was reworded.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const UI = join(__dirname, "..", "src", "ui");
const NEW_FILE = "settings-shared-strings.js";
const LANGS = ["en", "zh-TW"] as const;
type Table = Record<(typeof LANGS)[number], Record<string, string>>;

/** The words of every register("settings", {…}) call in one file, merged the way register() merges them (a later call wins). */
function settingsWords(file: string): Table {
  const sf = ts.createSourceFile(file, readFileSync(join(UI, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Table = { en: {}, "zh-TW": {} };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "register" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "settings") {
      const tables = new Function(`return (${n.arguments[1]!.getText()})`)() as Table;
      for (const lang of LANGS) Object.assign(out[lang], tables[lang] ?? {});
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const OLD = settingsWords("settings-strings.js");
const NEW = settingsWords(NEW_FILE);
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(",");

/** Every module of src/ui that is not a strings table. */
const modules = (d = UI): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === "vendor" || n === "web-terminal" ? [] : modules(p)) : /\.js$/.test(n) && !/-strings\.js$/.test(n) && !/\.module\.js$/.test(n) ? [p] : [];
});
/** The keys built from a prefix at run time (`opt_${kind}_${v}`, `settings.sec_${section}`): the prefixes whose keys are in the new file. */
const PREFIXES = ["sec_", "opt_", "seg_", "dashboardShort_"].filter((pre) => Object.keys(NEW.en).some((k) => k.startsWith(pre)));
const prints = (src: string, key: string) => new RegExp(`["'\`]${key.replace(/[-]/g, "\\-")}["'\`]|settings\\.${key.replace(/[-]/g, "\\-")}\\b`).test(src);
/** Modules that draw settings.* words: the ones that import the settings table or build a `settings.<key>` lookup. */
const drawsSettingsWords = (src: string) => /import "\.\/settings-strings\.js"|`settings\.\$\{|t\(`settings\./.test(src);
/** The modules that print a word of the new file, found by scanning the source. */
const readers = () => modules().filter((f) => {
  const src = readFileSync(f, "utf8");
  return drawsSettingsWords(src) && (Object.keys(NEW.en).some((k) => prints(src, k)) || PREFIXES.some((pre) => src.includes(`${pre}\${`)));
}).map((f) => relative(UI, f));
/** The five modules that must carry the new words, whatever the scan finds (the page, its draw code, the dialogs it borrows, the two search paths). */
const REQUIRED = ["settings-shared.js", "panel-settings.js", "settings-dialogs.js", "settings-registry.js", "search-dialog.js", "settings-layout.js"];

describe("#3087 review: one home for each word", () => {
  it("the new file has words, the same keys in en and zh-TW, and the same {n} placeholders", () => {
    expect(Object.keys(NEW.en).length).toBeGreaterThan(60);
    expect(Object.keys(NEW["zh-TW"]).sort()).toEqual(Object.keys(NEW.en).sort());
    for (const k of Object.keys(NEW.en)) expect(placeholders(NEW["zh-TW"][k]!), k).toBe(placeholders(NEW.en[k]!));
    for (const lang of LANGS) for (const [k, v] of Object.entries(NEW[lang])) expect(v.trim(), `${lang} ${k}`).not.toBe("");
  });

  it("a key is moved, not copied: none of them is also in settings-strings.js", () => {
    for (const lang of LANGS) expect(Object.keys(NEW[lang]).filter((k) => k in OLD[lang])).toEqual([]);
  });

  it("holds the words this page added and the ones it reworded (the two cases a tab with the old file gets wrong)", () => {
    // added: the group heading and a plain-words option the review's probe printed as raw keys; reworded: keys the old file had
    for (const k of ["sharedGroupAgents", "opt_tool_set_worker", "tipHang", "backendNotInstalledHost", "defaultMarkTip", "usagePartly"]) expect(NEW.en, k).toHaveProperty(k);
    for (const k of ["sec_agent-defaults", "hangEnabled", "changeInDefaults", "updateDefaults"]) expect(NEW["zh-TW"], k).toHaveProperty(k);
    expect(NEW.en["sec_agent-defaults"]).toBe("Shared agent settings");
  });
});

describe("#3087 review: every module that prints one of the words imports the file", () => {
  it("the five modules (and the layout that prints the section's title) import it, each after settings-strings.js", () => {
    for (const f of REQUIRED) {
      const src = readFileSync(join(UI, f), "utf8");
      const strings = src.indexOf('import "./settings-strings.js"'), shared = src.indexOf(`import "./${NEW_FILE}"`);
      expect(shared, `${f} imports ./${NEW_FILE}`).toBeGreaterThanOrEqual(0);
      expect(strings, `${f} imports ./settings-strings.js`).toBeGreaterThanOrEqual(0);
      expect(strings, `${f}: ${NEW_FILE} comes after settings-strings.js, so a reworded word wins`).toBeLessThan(shared);
    }
  });

  it("a scan of src/ui finds no other module that prints one of the words without importing the file", () => {
    const found = readers();
    expect(found).toEqual(expect.arrayContaining(REQUIRED));
    for (const f of found) expect(readFileSync(join(UI, f), "utf8"), `${f} prints a word of ${NEW_FILE}`).toContain(`import "./${NEW_FILE}"`);
  });
});

describe("#3087 review: a tab that already holds the old settings table", () => {
  let p: AppPage;
  beforeAll(() => { p = page({ url: "http://127.0.0.1:19284/settings", storage: { agend_tour_done: "1" } }); });
  afterAll(() => { p.restore(); });

  const IMPORTERS = ["settings-shared.js", "panel-settings.js", "settings-dialogs.js", "settings-registry.js", "search-dialog.js"] as const;
  const load: Record<(typeof IMPORTERS)[number], () => Promise<unknown>> = {
    "settings-shared.js": () => import("/ui/js/settings-shared.js"), "panel-settings.js": () => import("/ui/js/panel-settings.js"),
    "settings-dialogs.js": () => import("/ui/js/settings-dialogs.js"), "settings-registry.js": () => import("/ui/js/settings-registry.js"),
    "search-dialog.js": () => import("/ui/js/search-dialog.js"),
  };

  it.each(IMPORTERS)("%s: importing it gives every word of the new file, in both languages, over an older wording", async (file) => {
    vi.resetModules();
    const i18n = await import("/assets/app-i18n.js");
    // What an open tab holds: an old settings-strings.js that has already run (its URL will not run again). It has none of the
    // added keys and the old wording of a reworded one — an old wording stands in for every key of the new file here.
    i18n.register("settings", Object.fromEntries(LANGS.map((lang) => [lang, Object.fromEntries(Object.keys(NEW[lang]).map((k) => [k, `OLD WORDING ${k}`]))])));
    // The module now loads (its settings-strings.js is this checkout's, which no longer has these keys) and imports the new file:
    // whatever the tab held for these keys, the new file's words are the ones that stand.
    await load[file]();
    for (const lang of LANGS) for (const [k, v] of Object.entries(NEW[lang])) expect(i18n.tIn(lang, `settings.${k}`), `${file}: ${lang} settings.${k}`).toBe(v);
  });
});
