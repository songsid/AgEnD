/**
 * #4447 review (Prism, P2 1): module skew. A browser tab can still hold the PREVIOUS contact-auth-strings.js (cached by URL)
 * when the new Needs you line arrives; words registered there would be missing and the line would print raw keys
 * ("contactAuth.verifyNeedMany"). So the line's words live in its own module (contact-verify-need.js) and must read the same
 * whichever contact-auth-strings.js is loaded: the retained base bytes (tests/fixtures/skew/contact-auth-strings.base-
 * af7517571.js, the file at release af7517571, before this change) or the current one.
 * Node's real ESM linker, in a child process, on the product's own bytes: the entry and everything it statically imports
 * are copied into a scratch directory (browser-only dependencies — the Preact wrapper, icons, the authorize chip — are
 * stubs; i18n is a tiny real register/t), with the contact-auth-strings.js under test swapped in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui"), SHARED = join(UI, "shared");
const BASE_STRINGS = join(__dirname, "fixtures", "skew", "contact-auth-strings.base-af7517571.js");
const NEW_STRINGS = join(UI, "contact-auth-strings.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  "app-html.js": `export const html = () => null; export const useState = (v) => [v, () => {}]; export const useEffect = () => {};`,
  "app-i18n.js": `const tables = { en: {}, "zh-TW": {} }; let cur = "en";
    export function register(ns, by) { for (const l of Object.keys(tables)) for (const [k, v] of Object.entries(by[l] || {})) tables[l][ns + "." + k] = v; }
    export const t = (key, ...v) => String(tables[cur][key] ?? key).replace(/\\{(\\d+)\\}/g, (_, i) => v[i]);
    export const lang = () => cur; export const setLang = (l) => { cur = l; };`,
  "ui-icons.js": `export const Icon = () => null;`,
  "web-authorize.js": `export const AuthorizeChip = () => null;`,
};
const IMPORT = /\bfrom\s+["']((?:\.\/|\/assets\/)[^"']+\.js)["']/g;

/** Copy `entry` and its static imports into a scratch dir; `strings` replaces contact-auth-strings.js (always placed). */
function scratch(entryPath: string, strings: string): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-skew-3710-")); dirs.push(dir);
  const seen = new Set<string>();
  const place = (src: string, name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    let text: string;
    if (STUBS[name]) text = STUBS[name]!;
    else if (name === "contact-auth-strings.js") text = readFileSync(strings, "utf8");
    else {
      const found = [src, join(SHARED, name), join(UI, name)].find((p) => existsSync(p));
      if (!found) throw new Error(`cannot place ${name}`);
      text = readFileSync(found, "utf8");
    }
    const flat = text.replace(/(["'])\/assets\//g, "$1./");
    writeFileSync(join(dir, name), flat);
    for (const m of flat.matchAll(IMPORT)) place(join(dirname(src), m[1]!.replace(/^\.\//, "")), m[1]!.replace(/^\.\//, ""));
  };
  place(join(UI, "contact-auth-strings.js"), "contact-auth-strings.js");   // there for any module that imports it
  const entry = entryPath.split("/").pop()!;
  place(entryPath, entry);
  return { dir, entry };
}
function run(dir: string, entry: string, probe: string): unknown {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(dir, entry)).href)}); const i18n = await import("./app-i18n.js"); ${probe}`;
  try { return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: dir })); }
  catch (err) { return String((err as { stderr?: string }).stderr ?? err); }
}
const WORDS = `const say = () => [m.verifyNeedTitle(1), m.verifyNeedTitle(2), m.verifyNeedBody()];
  const en = say(); i18n.setLang("zh-TW"); console.log(JSON.stringify([en, say()]));`;
const EXPECTED = [
  ["1 contact request needs a verified browser", "2 contact requests need a verified browser", "Authorize this browser to see who is asking, and to approve or decline."],
  ["有 1 個聯絡申請需要已驗證的瀏覽器", "有 2 個聯絡申請需要已驗證的瀏覽器", "授權這個瀏覽器後，才能看到是誰提出，並核准或拒絕。"],
];

describe("#4447 review: the Needs you line's words, whichever contact-auth-strings.js the tab holds", () => {
  it.each([["the RETAINED base", BASE_STRINGS], ["the current", NEW_STRINGS]])("%s contact-auth-strings.js: en and zh-TW words, never a raw key", (_label, strings) => {
    const { dir, entry } = scratch(join(UI, "contact-verify-need.js"), strings);
    expect(run(dir, entry, WORDS)).toEqual(EXPECTED);
  });
  it("the harness sees the failure: words looked up in the base contact-auth-strings.js come back as raw keys (the control)", () => {
    const { dir } = scratch(join(UI, "contact-verify-need.js"), BASE_STRINGS);
    writeFileSync(join(dir, "probe.js"), `import { ca } from "./contact-auth-strings.js"; export const verifyNeedTitle = (n) => ca(n === 1 ? "verifyNeedOne" : "verifyNeedMany", n); export const verifyNeedBody = () => ca("verifyNeedBody");`);
    expect(run(dir, "probe.js", WORDS)).toEqual([["contactAuth.verifyNeedOne", "contactAuth.verifyNeedMany", "contactAuth.verifyNeedBody"], ["contactAuth.verifyNeedOne", "contactAuth.verifyNeedMany", "contactAuth.verifyNeedBody"]]);
  });
  it("the line's module imports nothing from contact-auth-strings.js (its words are its own)", () => {
    expect(readFileSync(join(UI, "contact-verify-need.js"), "utf8")).not.toMatch(/\bfrom\s+["'][^"']*contact-auth-strings/);
  });
});
