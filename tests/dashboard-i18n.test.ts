// The app's words (#1408 §4): every key the app, chat and fleet namespaces use exists in English and zh-TW, keeps the
// same {0} placeholders, and every t("…") call site names a key that is registered. Was the dashboard's inline
// dictionary (tests/dashboard-i18n.test.ts before #1408 step 1); the same zh-TW intent, now on the modules that own it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const UI = join(process.cwd(), "src", "ui");
const SHARED = join(UI, "shared");
const read = (file: string) => readFileSync(file, "utf8");
// The modules register their namespaces when they load. Run them in one realm: drop the imports, keep register() and
// the dictionary it fills (app-i18n.js), then each module's own register("…") call.
const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");

const ctx = vm.createContext({ navigator: { language: "en" } });
vm.runInContext(strip(read(join(SHARED, "app-i18n.js"))), ctx);
vm.runInContext(strip(read(join(UI, "chat-strings.js"))), ctx);
vm.runInContext(strip(read(join(UI, "panel-fleet.js"))), ctx);
const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
const NAMESPACES = ["app", "chat", "fleet"];
const keys = (lang: "en" | "zh-TW") => Object.keys(tables[lang]).filter(k => NAMESPACES.includes(k.split(".")[0]!));

describe("the app's dictionary: English and zh-TW", () => {
  it("every app, chat and fleet key exists in both languages", () => {
    expect(keys("en").length).toBeGreaterThan(50);
    expect(keys("en").filter(k => !(k in tables["zh-TW"]))).toEqual([]);
    expect(keys("zh-TW").filter(k => !(k in tables.en))).toEqual([]);
  });

  it("no zh-TW string is empty, and each keeps the {n} placeholders its English string has", () => {
    const placeholders = (s: string) => (s.match(/\{\d\}/g) ?? []).join(",");
    for (const k of keys("en")) {
      const zh = tables["zh-TW"][k];
      expect(zh, k).toBeTruthy();
      expect(placeholders(zh!), k).toBe(placeholders(tables.en[k]!));
    }
  });

  it.each([
    ["fleet.topicRequired", "目錄留空時必須填寫名稱"],
    ["fleet.deleteSchedule", "確定刪除此排程嗎？"],
    ["fleet.deleteTeam", "確定刪除 team「{0}」嗎？"],
    ["fleet.teamFieldsRequired", "必須填寫名稱並選擇至少一名成員"],
    ["fleet.scheduleCreated", "排程已建立"],
    ["chat.disconnected", "已斷線"],
    ["chat.loadFailed", "載入失敗"],
  ])("zh-TW %s reads %s", (key, zh) => {
    expect(tables["zh-TW"][key]).toBe(zh);
  });

  it("every t(\"…\") call site in the app names a registered key, in both languages", () => {
    const files = [
      ...readdirSync(UI).filter(f => f.endsWith(".js")).map(f => join(UI, f)),
      ...readdirSync(SHARED).filter(f => f.endsWith(".js") && !f.endsWith(".module.js")).map(f => join(SHARED, f)),
    ];
    const used = new Set<string>();
    for (const file of files) for (const m of read(file).matchAll(/\bt\(\s*"((?:app|chat|fleet)\.[\w.]+)"/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(50);
    for (const key of used) {
      expect(tables.en[key], `${key} (en)`).toBeDefined();
      expect(tables["zh-TW"][key], `${key} (zh-TW)`).toBeDefined();
    }
  });

  it("the call sites that used the old strings still use them: delete confirmations, the success toast, the validation toasts", () => {
    const fleet = read(join(UI, "panel-fleet.js"));
    // #1408 step 5: asked in the app's own dialog, with the same strings.
    expect(fleet).toContain('confirmDialog({ message: t("fleet.deleteSchedule")');
    expect(fleet).toContain('confirmDialog({ message: t("fleet.deleteTeam", name)');
    expect(fleet).toContain('done: t("fleet.scheduleCreated")');
    expect(fleet).toContain('toast(t("fleet.teamFieldsRequired"), false)');
    expect(fleet).toContain('toast(t("fleet.topicRequired"), false)');
  });

  it("the stored language is the one every panel has used (agend_lang), else the device's", () => {
    expect(read(join(SHARED, "app-i18n.js"))).toContain('localStorage.getItem("agend_lang")');
  });
});
