import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { getLocale, setLocale } from "../src/locale.js";
import { settingsSummaryCases } from "./helpers/settings-summary-cases-3416.js";
const originalLocale = getLocale();
let shell: any, app: any, words: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); shell = await import("/assets/app-shell.js"); app = await import("/assets/app-store.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } app.appStore.set({ pendingChanges: [] }); words.setLang("en", { store: false }); setLocale(originalLocale); });
it.each([["zh-TW", "fingerprint", "指紋"], ["en", "指紋", "fingerprint"]])("%s page renders the generic summary independently of the fleet locale", async (language, sourceWord, expected) => {
  const p = page({ storage: { agend_lang: language } }); pages.push(p); words.setLang(language, { store: false });
  const line = `key: ${sourceWord} abcdef → 123456`, applyNow = () => {};
  const pending = { id: "a".repeat(32), state: "pending", summary: [line], summary_i18n: [{ v: 1, fallback: line, parts: ["key: ", { key: "settings_confirm.summary.fingerprint", args: [] }, " abcdef → 123456"] }],
    deadline: Date.now() + 60000, confirmation: { kind: "web", code: "same-operation" }, applyNow };
  app.appStore.set({ pendingChanges: [pending] }); await p.mount(h(shell.PendingChanges, { inline: true })); await settle();
  expect(p.root.querySelector(".pending-summary").textContent).toBe(`key: ${expected} abcdef → 123456`);
  expect(app.appStore.get().pendingChanges[0]).toBe(pending); expect(pending.summary).toEqual([line]); expect(pending.applyNow).toBe(applyNow);
});

it("uses the current page language on a later render without rewriting the pending record", async () => {
  const p = page(); pages.push(p); words.setLang("en", { store: false });
  const line = "fingerprint", pending = { id: "b".repeat(32), state: "rejected", summary: [line], summary_i18n: [{ v: 1, fallback: line, parts: [{ key: "settings_confirm.summary.fingerprint", args: [] }] }] };
  app.appStore.set({ pendingChanges: [pending] }); await p.mount(h(shell.PendingChanges, {}));
  expect(p.root.querySelector(".pending-summary").textContent).toBe("fingerprint");
  words.setLang("zh-TW", { store: false }); app.appStore.set({ pendingChanges: [pending] }); await settle();
  expect(p.root.querySelector(".pending-summary").textContent).toBe("指紋"); expect(pending.summary).toEqual(["fingerprint"]);
});

it.each([undefined, { v: 2, fallback: "original", parts: ["changed"] }, { v: 1, fallback: "foreign", parts: ["changed"] }, { v: 1, fallback: "original", parts: [] },
  { v: 1, fallback: "original", parts: [{ key: "__proto__", args: [] }] }, { v: 1, fallback: "original", parts: [{ key: "unknown", args: [] }] },
  { v: 1, fallback: "original", parts: [{ key: { toString: 5 }, args: [] }] },
  { v: 1, fallback: "original", parts: [{ key: "settings_confirm.summary.fingerprint", args: ["extra"] }] },
  { v: 1, fallback: "original", parts: [{ key: "settings_confirm.summary.in_effect", args: [{}] }] },
  { v: 1, fallback: "original", parts: ["x".repeat(8193)] },
])("keeps the original line and action for absent or unsupported display metadata (%j)", async descriptor => {
  const p = page(); pages.push(p); words.setLang("zh-TW", { store: false }); const applyNow = vi.fn(async () => ({ ok: true }));
  const pending = { id: "c".repeat(32), state: "pending", summary: ["original"], summary_i18n: [descriptor], applyNow,
    deadline: Date.now() + 60000, confirmation: { kind: "web", code: "exact" } };
  app.appStore.set({ pendingChanges: [pending] }); await p.mount(h(shell.PendingChanges, {}));
  expect(p.root.querySelector(".pending-summary").textContent).toBe("original"); expect(pending.applyNow).toBe(applyNow);
});

it.each(["en", "zh-TW"])("all generic producer forms render in %s without exposing keys or changing canonical records", async language => {
  const p = page(); pages.push(p); words.setLang(language, { store: false }); setLocale(language === "en" ? "zh-TW" : "en");
  const diffs = settingsSummaryCases.filter(c => !c.name.endsWith("limit") && c.name !== "unsupported").map(c => settingsChangeDiff(c.before, c.after, { operation: `PATCH ${c.name}`, ...c.options }));
  const pendings = diffs.filter(Boolean).map((diff, i) => ({ id: String(i).padStart(32, "a"), state: "rejected", ...diff }));
  const canonical = JSON.stringify(pendings.map(p => p.summary));
  app.appStore.set({ pendingChanges: pendings }); await p.mount(h(shell.PendingChanges, {}));
  const text = p.root.querySelector(".pending-stack").textContent;
  expect(text).not.toContain("pendingSummary."); expect(text).toContain(language === "en" ? "fingerprint" : "指紋");
  expect(text).toContain(language === "en" ? "agent(s) inherit it" : "繼承此設定");
  expect(text).toContain(language === "en" ? "Classic admin" : "Classic 管理員");
  expect(JSON.stringify(pendings.map(p => p.summary))).toBe(canonical);
});

it("retained Hub summary fallback still works when a future descriptor is unknown", async () => {
  const p = page(); pages.push(p); words.setLang("zh-TW", { store: false });
  const line = "Connect this Fleet to Hub https://hub.example.test using your company account. Agent sharing stays separate.";
  app.appStore.set({ pendingChanges: [{ id: "e".repeat(32), state: "rejected", summary: [line], summary_i18n: [{ v: 2, fallback: line, parts: ["future"] }] }] });
  await p.mount(h(shell.PendingChanges, {})); expect(p.root.querySelector(".pending-summary").textContent).toContain("以公司帳號");
});

it("renders escaped identities as text instead of interpreting markup", async () => {
  const p = page(); pages.push(p); words.setLang("zh-TW", { store: false });
  const identity = "<img src=x onerror=bad()>[at]everyone", line = "original identity";
  const pending = { id: "d".repeat(32), state: "rejected", summary: [line], summary_i18n: [{ v: 1, fallback: line, parts: [{ key: "settings_confirm.summary.inherit", args: [2, identity] }] }] };
  app.appStore.set({ pendingChanges: [pending] }); await p.mount(h(shell.PendingChanges, {}));
  expect(p.root.querySelector(".pending-summary").textContent).toContain(identity); expect(p.root.querySelector(".pending-summary img")).toBeNull();
});

it.each([{}, { 0: { v: 1, fallback: "original", parts: ["changed"] } }, [{ v: 1, fallback: "original", parts: ["changed"] }, null]])("ignores a non-parallel presentation container (%j)", async presentation => {
  const p = page(); pages.push(p); words.setLang("zh-TW", { store: false });
  app.appStore.set({ pendingChanges: [{ id: "f".repeat(32), state: "rejected", summary: ["original"], summary_i18n: presentation }] });
  await p.mount(h(shell.PendingChanges, {})); expect(p.root.querySelector(".pending-summary").textContent).toBe("original");
});
