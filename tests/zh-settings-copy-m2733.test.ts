/**
 * M-2733: zh-TW Settings copy — what the M-2731 captures showed.
 * - The tool-progress and cross-Agent visibility selects say their config words (off/standard/verbose,
 *   full/summary/hidden) in the page's language; the value saved stays the config word. English reads as before.
 * - A backend select shows the product name ("Claude Code"), never the id; the value stays the id.
 * - The zh-TW strings say 網頁儀表板, 後端, 鏡像主題, Agent / Fleet — no "Dashboard 權限", "backend", "Mirror Topic"
 *   or a "——" in the search box.
 * - The page says its language from the start (<html lang="zh-Hant">), so `:lang(zh-Hant)` rules — no upper-cased
 *   "整個 FLEET" — apply when the language comes from this browser and not from the host's prefs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { backendChoices } from "/ui/js/settings-catalog.js";

const ROOT = join(import.meta.dirname, "..");
let pg: AppPage | null = null;
afterEach(async () => {
  if (pg) { (await import("/assets/app-i18n.js")).setLang("en", { store: false }); pg.restore(); pg = null; }
});
async function lang(l: "en" | "zh-TW") {
  pg = page({ url: "http://127.0.0.1:19280/settings/agent-defaults", storage: { agend_tour_done: "1" } });
  (await import("/assets/app-i18n.js")).setLang(l, { store: false });
}

describe("M-2733: config words in the page's language", () => {
  it("zh-TW: tool progress and visibility say Chinese words; the values are the config words", async () => {
    await lang("zh-TW");
    const { choiceLabel, choiceOptions, valueText } = await import("/ui/js/settings-dialogs.js");
    expect(choiceOptions("tool_progress", ["off", "standard", "verbose"])).toEqual([
      { value: "off", label: "關閉" }, { value: "standard", label: "標準" }, { value: "verbose", label: "詳細" }]);
    expect(choiceOptions("cross_instance_visibility", ["full", "summary", "hidden"])).toEqual([
      { value: "full", label: "完整" }, { value: "summary", label: "摘要" }, { value: "hidden", label: "隱藏" }]);
    // The inherited line ("目前生效：…") says the same words.
    expect(valueText("summary", "cross_instance_visibility")).toBe("摘要");
    expect(valueText("off", "tool_progress")).toBe("關閉");
    // A word this page has none for (a newer host's) shows as itself, never as a key.
    expect(choiceLabel("tool_progress", "chatty")).toBe("chatty");
  });

  it("English reads as before", async () => {
    await lang("en");
    const { choiceOptions, valueText } = await import("/ui/js/settings-dialogs.js");
    expect(choiceOptions("tool_progress", ["off", "standard", "verbose"]).map((o: any) => o.label)).toEqual(["off", "standard", "verbose"]);
    expect(choiceOptions("cross_instance_visibility", ["full", "summary", "hidden"]).map((o: any) => o.label)).toEqual(["full", "summary", "hidden"]);
    expect(valueText("hidden", "cross_instance_visibility")).toBe("hidden");
  });

  it("a backend option shows its product name; the value is the id", async () => {
    const { backendLabel } = await import("/assets/instance-nav.js");
    const words = { notInstalled: "未安裝", notSignedIn: "未登入", tooOld: (v: string) => `需要 ${v}`, unchecked: "尚未檢查", removed: (v: string) => `${v}（已移除）`, name: backendLabel };
    const got = backendChoices(["claude-code", "codex", "kiro-cli"], [{ name: "claude-code", state: "usable" }, { name: "codex", state: "not_installed" }], "claude-code", words);
    expect(got).toEqual([
      { value: "claude-code", label: "Claude Code", disabled: false },
      { value: "codex", label: "Codex — 未安裝", disabled: true },
      { value: "kiro-cli", label: "Kiro CLI", disabled: false },   // no row: nothing said
    ]);
    // Without a name function (an older caller) the id is the label, as before.
    expect(backendChoices(["claude-code"], [], "claude-code", { ...words, name: undefined })[0].label).toBe("claude-code");
  });
});

describe("M-2733: the zh-TW strings", () => {
  it("say 網頁儀表板 / 後端 / 鏡像主題 / Agent / Fleet, and the search box has no dash", async () => {
    await lang("zh-TW");
    const { t } = await import("/assets/app-i18n.js");
    await import("/ui/js/settings-strings.js");
    const s = (k: string) => t(`settings.${k}`);
    expect(s("dashboardAccess")).toBe("網頁儀表板權限");
    for (const k of ["dashboardAccessHint", "dashboardDefaultsHint"]) {
      expect(s(k)).toContain("網頁儀表板");
      expect(s(k)).not.toMatch(/dashboard|\bagent\b/);
    }
    expect(s("dashboardInherit")).toBe("跟 Fleet 預設（{0}）");
    expect(s("dashboard_office_packs")).toContain("整個 Fleet");
    expect(s("crossInstanceVisibilityHint")).toBe("完整：整則訊息 · 摘要：一行 · 隱藏：不顯示。訊息一律照常送達，鏡像主題也照常顯示。");
    expect(s("searchSettings")).toBe("搜尋設定：語言、金鑰…");
    for (const k of ["wizardAgentExistingNote", "backendUnavailable", "classicBackend", "help3"]) expect(s(k)).not.toMatch(/backend|model/i);
  });

  it("the search finds the dashboard field by its new and its Chinese words", async () => {
    await lang("zh-TW");
    const { searchSettings } = await import("/ui/js/settings-registry.js");
    for (const q of ["網頁儀表板權限", "儀表板"]) expect(searchSettings(q).map((h: any) => h.id)).toContain("defaults.dashboard");
  });

  it("Chinese headings are never upper-cased (the Settings groups too)", () => {
    const css = readFileSync(join(ROOT, "src/ui/shared/app.css"), "utf8");
    const rule = css.split("\n").find((l) => l.startsWith(":lang(zh-Hant) .card h3"))!;
    expect(rule).toContain(":lang(zh-Hant) .s-nav-head");
    expect(rule).toContain(":lang(zh-Hant) .s-group-head");
    expect(rule).toContain("text-transform: none");
  });
});

describe("M-2733: the page says its language from the start", () => {
  it("a zh-TW choice kept in this browser marks <html lang> before any change", async () => {
    pg = page({ url: "http://127.0.0.1:19280/settings", storage: { agend_lang: "zh-TW" } });
    (pg.document.documentElement as any).lang = "en";   // what the host writes when its prefs name no language
    vi.resetModules();
    const fresh = await import("/assets/app-i18n.js");
    expect(fresh.lang()).toBe("zh-TW");
    expect((pg.document.documentElement as any).lang).toBe("zh-Hant");
  });
});
