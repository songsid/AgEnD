/**
 * M-3770 slice 1.7 (design #4480): Phase 1's update card in the words people and agents read — the web-dashboard skill's
 * Updating AgEnD section, docs/web-dashboard and docs/configuration (en and zh-TW), tip 132 and General's what's-new line.
 * Nothing lost, and no drift from the product: every button and line the docs quote is the UI's own string (the web
 * card's update-card-ui.js, the chat card's locale.ts), and every `updates.*` key they name is one fleet.yaml takes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TIPS } from "../src/tips.js";
import { AGENT_WHATS_NEW } from "../src/agent-whats-new.js";
import { resolveUpdates } from "../src/update-settings.js";

const read = (p: string) => readFileSync(p, "utf8").replace(/\s+/g, " ");
const SKILL = read("src/general-knowledge/skills/web-dashboard/SKILL.md");
const section = (text: string, head: string, next: string) => { const i = text.indexOf(head); expect(i, head).toBeGreaterThan(-1); const j = text.indexOf(next, i + head.length); return text.slice(i, j < 0 ? undefined : j); };
const UPDATING = section(SKILL, "## Updating AgEnD", "## Look");
const UI = readFileSync("src/ui/shared/update-card-ui.js", "utf8");
const LOCALE = readFileSync("src/locale.ts", "utf8");
/** A web card string, in one language: `key: "…"` inside that language's table. */
const ui = (lang: "en" | "zh-TW", key: string): string => {
  const at = lang === "en" ? UI.indexOf("  en: {") : UI.indexOf('  "zh-TW": {');
  const m = new RegExp(`[\\s,{]${key}: "([^"]*)"`).exec(UI.slice(at));
  expect(m, `${lang} ${key}`).toBeTruthy();
  return m![1]!;
};
const chat = (lang: "en" | "zh-TW", key: string): string => {
  const all = [...LOCALE.matchAll(new RegExp(`"update\\.chatcard\\.${key}": "([^"]*)"`, "g"))].map(m => m[1]!);
  expect(all.length, key).toBe(2);
  return lang === "en" ? all[0]! : all[1]!;
};

describe("M-3770 1.7: the web-dashboard skill's Updating AgEnD", () => {
  it("quotes the web card's own buttons and lines, en and zh-TW", () => {
    for (const key of ["whenIdle", "pickTime", "notNow", "updateNow", "machine", "self", "fixIt", "howToFix", "serviceIt", "serviceGo"]) {
      expect(UPDATING, `en ${key}`).toContain(ui("en", key));
    }
    for (const key of ["whenIdle", "pickTime", "notNow", "updateNow", "cancel", "machine", "fixIt", "howToFix", "pauseTitle", "serviceIt", "serviceGo"]) {
      expect(UPDATING, `zh ${key}`).toContain(ui("zh-TW", key));
    }
    expect(UPDATING).toContain(ui("en", "adminOnly"));
    expect(UPDATING).toContain(ui("en", "stop"));
    expect(UPDATING).toContain(ui("en", "backPhase1").replace("{0}", "*Y*"));
    expect(UPDATING).toContain(ui("zh-TW", "backPhase1").replace("{0}", "Y"));
    expect(UPDATING).toContain(ui("zh-TW", "ready").replace("{0}", "X"));
    expect(UPDATING).toContain(`A${ui("en", "sep")}B${ui("en", "more").replace("{0}", "3")}`);          // "A, B and 3 more"
    expect(UPDATING).toContain(`A${ui("zh-TW", "sep")}B${ui("zh-TW", "more").replace("{0}", "3")}`);    // 「A、B，另有 3 個」
  });
  it("quotes the chat card's buttons", () => {
    for (const lang of ["en", "zh-TW"] as const) {
      for (const key of ["when_idle", "tonight", "not_now"]) expect(UPDATING, `${lang} ${key}`).toContain(chat(lang, key));
    }
  });
  it("says what each part does: one card, a week's Not now, idle and its longest wait, the three outcomes, the fixes, the controls", () => {
    for (const fact of ["One update card per fleet", "General's chat topic", "comes back a week after", "no \"skip this version\"",
      "told privately", "`updates.maxIdleWait`", "(24 h by default)", "within 7 days", "Only a machine where AgEnD can update itself takes a schedule",
      "`sudo loginctl enable-linger <user>`", "`agend install`", "`sudo agend update`", "**Needs you** lists it", "`updates.pause`", "`updates.pin`",
      "**Update now** and `/update` still update at once", "waits for a confirmation", "guests and agents can't update", "`agend rollback <version>`"]) {
      expect(UPDATING, fact).toContain(fact);
    }
    expect(SKILL).toContain("the update card (「AgEnD X 可以更新了。」, Update when idle, Pick a time, Not now)");   // the index row
  });
});

describe("M-3770 1.7: docs", () => {
  it("web-dashboard.md and its zh-TW twin have the section, with the UI's words", () => {
    const en = section(read("docs/web-dashboard.md"), "## Updating AgEnD", "## Reaching it from elsewhere");
    const zh = section(read("docs/web-dashboard.zh-TW.md"), "## 更新 AgEnD", "## 從別的裝置連線");
    for (const key of ["whenIdle", "pickTime", "notNow", "updateNow", "fixIt", "howToFix", "serviceIt"]) {
      expect(en, `en ${key}`).toContain(ui("en", key));
      expect(zh, `zh ${key}`).toContain(ui("zh-TW", key));
    }
    for (const doc of [en, zh]) for (const cmd of ["`/update`", "`agend install`", "`sudo agend update`", "`sudo loginctl enable-linger <user>`", "`updates.*`"]) expect(doc, cmd).toContain(cmd);
    expect(zh).not.toMatch(/代理|艦隊|公司|管理者/);
  });
  it("configuration.md names every updates.* key fleet.yaml takes, with its default, in both languages", () => {
    const keys = Object.keys(resolveUpdates(undefined));
    expect(keys.sort()).toEqual(["maxIdleWait", "mode", "pause", "pin"]);
    for (const p of ["docs/configuration.md", "docs/configuration.zh-TW.md"]) {
      const row = read(p).split("| `updates` |")[1]!.split(" |\n")[0]!;
      for (const k of keys) expect(row, `${p} ${k}`).toContain(`\`${k}`);
      expect(row, p).toContain("`24`");
      expect(row, p).toContain("1–168");
    }
  });
});

describe("M-3770 1.7: tip 132 and General's what's-new", () => {
  it("tip 132 says Update when idle on the card, and that /update is at once, in both languages", () => {
    const tip = TIPS.find(x => x.id === "tip-132")!;
    expect(tip.text_en).toContain(ui("en", "whenIdle"));
    expect(tip.text_zh).toContain(`「${ui("zh-TW", "whenIdle")}」`);
    for (const text of [tip.text_en, tip.text_zh]) expect(text).toContain("`/update`");
    expect(tip.text_en).not.toContain("safe point");
  });
  it("General is told once, in a topic line naming the skill", () => {
    const e = AGENT_WHATS_NEW.find(x => x.id === "2.4-update-card")!;
    expect(e).toBeTruthy();
    expect(e.audience).toEqual(["general"]);
    expect(e.text).toContain("`web-dashboard` skill's Updating AgEnD section");
    for (const word of [ui("en", "whenIdle"), ui("en", "pickTime"), ui("en", "notNow"), ui("en", "machine")]) expect(e.text).toContain(word);
    expect(e.text.length).toBeLessThan(500);
  });
});
