/**
 * Refs #3061, review of #3165 (P2 3): the words Access & security added to settings-strings.js and settings-layout.js live in
 * src/ui/settings-access-strings.js. Fleet and search import those two modules; a tab that visited either before an upgrade has
 * already run the old copies, and the browser hands the same module back when the new Settings page imports that URL again — so a
 * key only the new file had read as the raw `settings.webLoginQr` / `settingsLayout.revAuthorityRule` key, in both languages.
 * The new file's URL is new: no tab holds an old copy of it. (The pattern is settings-shared-strings.js, #3087.)
 *   - Ownership: a key is in one file, never two; same keys and {n} placeholders in en and zh-TW.
 *   - Readers: every module that prints one of the words imports the new file.
 *   - Load: importing any of them into a tab whose tables are the old ones (they lack the key) gives every word, in both languages.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const UI = join(__dirname, "..", "src", "ui");
const NEW_FILE = "settings-access-strings.js";
const LANGS = ["en", "zh-TW"] as const;
type Table = Record<(typeof LANGS)[number], Record<string, string>>;

/** The words of every register("<ns>", {…}) call in one file, merged the way register() merges them (a later call wins). */
function words(file: string, ns: string): Table {
  const sf = ts.createSourceFile(file, readFileSync(join(UI, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Table = { en: {}, "zh-TW": {} };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "register" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === ns) {
      const tables = new Function(`return (${n.arguments[1]!.getText()})`)() as Table;
      for (const lang of LANGS) Object.assign(out[lang], tables[lang] ?? {});
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const NAMESPACES = [{ ns: "settings", old: "settings-strings.js" }, { ns: "settingsLayout", old: "settings-layout.js" }] as const;
const NEW = Object.fromEntries(NAMESPACES.map(({ ns }) => [ns, words(NEW_FILE, ns)])) as Record<string, Table>;
const OLD = Object.fromEntries(NAMESPACES.map(({ ns, old }) => [ns, words(old, ns)])) as Record<string, Table>;
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(",");

/** The words this review found missing in a stale tab (the review's probe printed the first two as raw keys). */
const KEYS = { settings: ["webLoginQr", "webLoginQrHint"], settingsLayout: ["revAuthorityBriefWeb", "revAuthorityEnabledWeb", "revAuthorityRule"] } as const;

const modules = (d = UI): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === "vendor" || n === "web-terminal" ? [] : modules(p)) : /\.js$/.test(n) && !/-strings\.js$/.test(n) && !/\.module\.js$/.test(n) ? [p] : [];
});
const printsKey = (src: string, key: string) => new RegExp(`["'\`]${key}["'\`]|settings\\.${key}\\b`).test(src);
/** Modules that print one of the words, found by scanning the source (settings-layout.js defines the lookup; it prints none of them). */
const readers = () => modules().filter((f) => {
  const src = readFileSync(f, "utf8");
  return Object.values(KEYS).flat().some((k) => printsKey(src, k)) && !f.endsWith("settings-layout.js");
}).map((f) => relative(UI, f));
/** What must carry the words whatever the scan finds: the page, the two search paths, and the Web authorization card. */
const REQUIRED = ["panel-settings.js", "settings-registry.js", "search-dialog.js", "settings-web-authority.js"];

describe("#3061 review: one home for each word", () => {
  it("the new file has the words, the same keys in en and zh-TW, and the same {n} placeholders", () => {
    for (const ns of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
      expect(Object.keys(NEW[ns]!.en).sort(), ns).toEqual([...KEYS[ns]].sort());
      expect(Object.keys(NEW[ns]!["zh-TW"]).sort(), ns).toEqual(Object.keys(NEW[ns]!.en).sort());
      for (const k of Object.keys(NEW[ns]!.en)) expect(placeholders(NEW[ns]!["zh-TW"][k]!), k).toBe(placeholders(NEW[ns]!.en[k]!));
      for (const lang of LANGS) for (const [k, v] of Object.entries(NEW[ns]![lang])) expect(v.trim(), `${lang} ${ns}.${k}`).not.toBe("");
    }
  });

  it("a key is moved, not copied: none of them is also in settings-strings.js or settings-layout.js", () => {
    for (const { ns } of NAMESPACES) for (const lang of LANGS) expect(Object.keys(NEW[ns]![lang]).filter((k) => k in OLD[ns]![lang]), `${ns} ${lang}`).toEqual([]);
  });

  it("holds what the reference wording says (the QR switch and the Web authorization card on a fleet with no chat connection)", () => {
    expect(NEW.settings!.en.webLoginQr).toBe("Show a QR code when a new device signs in with another device");
    expect(NEW.settings!["zh-TW"].webLoginQr).toBe("新裝置用其他裝置登入時顯示 QR Code");
    expect(NEW.settingsLayout!.en.revAuthorityEnabledWeb).toBe("Allow web authorization by a verified owner");
    expect(NEW.settingsLayout!["zh-TW"].revAuthorityRule).toContain("裝置登入與擁有者授權分開判斷");
  });
});

describe("#3061 review: every module that prints one of the words imports the file", () => {
  it("the page, the search paths and the Web authorization card import it", () => {
    for (const f of REQUIRED) expect(readFileSync(join(UI, f), "utf8"), `${f} imports ./${NEW_FILE}`).toContain(`import "./${NEW_FILE}"`);
  });

  it("a scan of src/ui finds no other module that prints one of the words without importing the file", () => {
    const found = readers();
    expect(found).toEqual(expect.arrayContaining(["panel-settings.js", "settings-registry.js", "settings-web-authority.js"]));
    for (const f of found) expect(readFileSync(join(UI, f), "utf8"), `${f} prints a word of ${NEW_FILE}`).toContain(`import "./${NEW_FILE}"`);
  });
});

describe("#3061 review: a tab that already holds the old settings and layout tables", () => {
  let p: AppPage;
  beforeAll(() => { p = page({ url: "http://127.0.0.1:19284/settings", storage: { agend_tour_done: "1" } }); });
  afterAll(() => { p.restore(); });

  // The tab's old settings-strings.js and settings-layout.js have already run and will not run again; they lack these keys. What
  // the checkout serves for both modules lacks them too (they moved), so importing a reader is exactly what that tab does.
  const IMPORTERS = ["panel-settings.js", "settings-registry.js", "search-dialog.js", "settings-web-authority.js"] as const;
  const load: Record<(typeof IMPORTERS)[number], () => Promise<unknown>> = {
    "panel-settings.js": () => import("/ui/js/panel-settings.js"), "settings-registry.js": () => import("/ui/js/settings-registry.js"),
    "search-dialog.js": () => import("/ui/js/search-dialog.js"), "settings-web-authority.js": () => import("/ui/js/settings-web-authority.js"),
  };

  it.each(IMPORTERS)("%s: importing it gives every word, in both languages (not the raw key)", async (file) => {
    vi.resetModules();
    const i18n = await import("/assets/app-i18n.js");
    await load[file]();
    for (const ns of Object.keys(KEYS) as Array<keyof typeof KEYS>) for (const lang of LANGS) for (const [k, v] of Object.entries(NEW[ns]![lang])) {
      const got = i18n.tIn(lang, `${ns}.${k}`);
      expect(got, `${file}: ${lang} ${ns}.${k}`).toBe(v);
      expect(got, `${file}: ${lang} ${ns}.${k} is not the raw key`).not.toBe(`${ns}.${k}`);
    }
  });
});
