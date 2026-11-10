/**
 * PR #3553 review (round 2, P2): the words of "Revoke other devices' authorization" must show whatever settings-access-strings.js the
 * tab holds. That file already exists on the release base and search-dialog.js / settings-registry.js import it, so a tab that opened
 * search before the upgrade keeps the OLD dictionary (modules are cached by URL) and a key added to it would read as the raw
 * `settings.vaRevokeOthers…` key when the new Settings card is opened — in both languages. The words are in a file of their own
 * (settings-revoke-strings.js: a new URL), imported by every module that prints them.
 *   - Skew: the base settings-access-strings.js (tests/fixtures/skew/…base-d5e2a3c87.js, the bytes at upstream d5e2a3c87) stands in for
 *     the cached module (vi.doMock at its URL, as the browser would hand it back); importing the card, the search registry and the
 *     search dialog still gives every word, in both languages, and the search label.
 *   - Control: with the current dictionary the same holds.
 *   - Ownership: the file has the same keys in en and zh-TW with the same {n} placeholders, none of them also lives in another
 *     strings module, and every src/ui module that prints one imports it.
 * The expected words are written out here (not read from the file under test) so a missing file fails the test instead of skipping it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const UI = join(__dirname, "..", "src", "ui");
const FILE = "settings-revoke-strings.js";
const LANGS = ["en", "zh-TW"] as const;
const WORDS: Record<(typeof LANGS)[number], Record<string, string>> = {
  en: {
    vaRevokeOthers: "Revoke other devices' authorization",
    vaRevokeOthersTitle: "Revoke other devices' authorization?",
    vaRevokeOthersConfirm: "Every other device's authorization ends, and every authority given from the web so far reads as none. Nobody is signed out, and this does not end any session's ability to confirm Settings changes: to make a session stop working, use Sign out everywhere or /web revoke.",
    vaRevokeAffected: "These devices lose their authorization: {0}.", vaRevokeNoOthers: "No other device is authorized now.", vaRevokeKept: "This device (you) stays authorized.",
    vaRevokeOwnerOnly: "Only a verified owner can revoke.", vaRevokedOthers: "Other devices' authorization is revoked. This device stays authorized.",
    vaRevokedAll: "Web authority given so far is revoked, this device's included.",
  },
  "zh-TW": {
    vaRevokeOthers: "撤銷其他裝置的授權", vaRevokeOthersTitle: "撤銷其他裝置的授權？",
    vaRevokeOthersConfirm: "其他裝置的授權都會結束，到目前為止從網頁給出的授權也都視為無。不會登出任何人，也不會讓任何 session 失去確認設定變更的能力：要讓某個 session 失效，請用「全部登出」或 /web revoke。",
    vaRevokeAffected: "這些裝置會失去授權：{0}。", vaRevokeNoOthers: "目前沒有其他已授權的裝置。", vaRevokeKept: "這台裝置（你）會保留授權。",
    vaRevokeOwnerOnly: "只有已驗證擁有者能撤銷。", vaRevokedOthers: "已撤銷其他裝置的授權，這台裝置仍保有授權。", vaRevokedAll: "已撤銷到目前為止的網頁授權，包含這台裝置。",
  },
};
const KEYS = Object.keys(WORDS.en);
const BASE_ACCESS = "./fixtures/skew/settings-access-strings.base-d5e2a3c87.js";
const ACCESS_URL = "../src/ui/settings-access-strings.js";

describe("PR #3553 review: a tab that already holds the BASE settings-access-strings.js still shows every word", () => {
  let p: AppPage;
  beforeAll(() => { p = page({ url: "http://127.0.0.1:19285/settings", storage: { agend_tour_done: "1" } }); });
  afterAll(() => { p.restore(); });
  beforeEach(() => { vi.resetModules(); vi.doUnmock(ACCESS_URL); });

  const STALE = async () => { vi.doMock(ACCESS_URL, async () => { await import(BASE_ACCESS); return {}; }); };
  const IMPORTERS = { "the Web authority card (settings-web-authority.js)": () => import("/ui/js/settings-web-authority.js"), "the search registry (settings-registry.js)": () => import("/ui/js/settings-registry.js"),
    "the search dialog (search-dialog.js)": () => import("/ui/js/search-dialog.js"), "the Settings page (panel-settings.js)": () => import("/ui/js/panel-settings.js") } as const;

  it.each(Object.entries(IMPORTERS))("stale dictionary — %s: every key, both languages, is the translated word (never the raw key)", async (_label, load) => {
    await STALE();
    const i18n = await import("/assets/app-i18n.js");
    await load();
    for (const lang of LANGS) for (const k of KEYS) {
      const got = i18n.tIn(lang, `settings.${k}`);
      expect(got, `${lang} settings.${k}`).toBe(WORDS[lang][k]);
      expect(got, `${lang} settings.${k} is not the raw key`).not.toBe(`settings.${k}`);
    }
  });

  it("stale dictionary — the search result's label for the revoke button is the word, in both languages", async () => {
    await STALE();
    const registry = await import("/ui/js/settings-registry.js");
    const entry = registry.SETTINGS_REGISTRY.find((e: { id?: string; 0?: string }) => (e.id ?? e[0]) === "access.authority-revoke")!;
    expect(entry).toBeTruthy();
    expect([registry.settingLabel(entry, "en"), registry.settingLabel(entry, "zh-TW")]).toEqual([WORDS.en.vaRevokeOthers, WORDS["zh-TW"].vaRevokeOthers]);
  });

  it("control — the current dictionary: the same words, the same label", async () => {
    const i18n = await import("/assets/app-i18n.js");
    const registry = await import("/ui/js/settings-registry.js");
    await import("/ui/js/settings-web-authority.js");
    for (const lang of LANGS) for (const k of KEYS) expect(i18n.tIn(lang, `settings.${k}`), `${lang} settings.${k}`).toBe(WORDS[lang][k]);
    const entry = registry.SETTINGS_REGISTRY.find((e: { id?: string; 0?: string }) => (e.id ?? e[0]) === "access.authority-revoke")!;
    expect(registry.settingLabel(entry, "en")).toBe(WORDS.en.vaRevokeOthers);
  });
});

describe("PR #3553 review: one home for each word, and every reader imports it", () => {
  const registerBlock = (file: string): Record<(typeof LANGS)[number], string[]> => {
    const src = readFileSync(join(UI, file), "utf8"), out: Record<(typeof LANGS)[number], string[]> = { en: [], "zh-TW": [] };
    for (const m of src.matchAll(/register\("settings",\s*(\{[\s\S]*?\n\})\)/g)) {
      const t = new Function(`return (${m[1]})`)() as Record<string, Record<string, string>>;
      for (const lang of LANGS) out[lang].push(...Object.keys(t[lang] ?? {}));
    }
    return out;
  };
  const table = (file: string) => {
    const src = readFileSync(join(UI, file), "utf8"), out: Record<(typeof LANGS)[number], Record<string, string>> = { en: {}, "zh-TW": {} };
    for (const m of src.matchAll(/register\("settings",\s*(\{[\s\S]*?\n\})\)/g)) {
      const t = new Function(`return (${m[1]})`)() as Record<string, Record<string, string>>;
      for (const lang of LANGS) Object.assign(out[lang], t[lang] ?? {});
    }
    return out;
  };
  it("the file holds exactly these keys, the same in en and zh-TW, with the same {n} placeholders and these words", () => {
    const t = table(FILE);
    for (const lang of LANGS) expect(t[lang], lang).toEqual(WORDS[lang]);
    const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(",");
    for (const k of KEYS) expect(ph(t["zh-TW"][k]!), k).toBe(ph(t.en[k]!));
  });
  it("a key is in this file only: not in settings-strings.js, settings-layout.js or settings-access-strings.js (the base copy of the last is untouched)", () => {
    for (const other of ["settings-strings.js", "settings-access-strings.js"]) for (const lang of LANGS) expect(registerBlock(other)[lang].filter((k) => KEYS.includes(k)), `${other} ${lang}`).toEqual([]);
    expect(readFileSync(join(UI, "settings-access-strings.js"), "utf8")).toBe(readFileSync(join(__dirname, "fixtures", "skew", "settings-access-strings.base-d5e2a3c87.js"), "utf8"));
  });
  const modules = (d = UI): string[] => readdirSync(d).flatMap((n) => {
    const q = join(d, n);
    return statSync(q).isDirectory() ? (n === "vendor" || n === "web-terminal" ? [] : modules(q)) : /\.js$/.test(n) && !/-strings\.js$/.test(n) ? [q] : [];
  });
  it("every module under src/ui that prints one of the words imports the file (and the card, registry and search dialog are among them)", () => {
    const prints = (src: string) => KEYS.some((k) => new RegExp(`["'\`]${k}["'\`]|settings\\.${k}\\b`).test(src));
    const readers = modules().filter((f) => prints(readFileSync(f, "utf8"))).map((f) => relative(UI, f));
    expect(readers).toEqual(expect.arrayContaining(["settings-web-authority.js", "settings-registry.js"]));
    for (const f of [...readers, "search-dialog.js"]) expect(readFileSync(join(UI, f), "utf8"), `${f} imports ./${FILE}`).toContain(`import "./${FILE}"`);
  });
});
