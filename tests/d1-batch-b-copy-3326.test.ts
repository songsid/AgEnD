import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getLocale, setLocale, t } from "../src/locale.js";
// @ts-expect-error — browser JS dictionary
import { hostText } from "../src/ui/shared/setup-host-text.js";

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const present = (path: string) => existsSync(new URL(`../src/${path}`, import.meta.url));
const forbidden = /\bagend\s+(?:web|update|hub|attach|reload|quickstart|web-token)\b|tmux\s+(?:-L|attach)|npm rebuild|fleet\.yaml|~\/\.agend|run it on the host|在主機上執行|請在主機/;
const locale = getLocale();
afterEach(() => setLocale(locale));
function catalogue(path: string): Record<string, Record<string, string>> {
  const s = src(path), begin = s.indexOf('\nregister('), end = s.indexOf('\n});', begin) + 4;
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  let table: Record<string, Record<string, string>> = {};
  runInNewContext(s.slice(begin, end), { register: (_name: string, value: typeof table) => { table = value; } });
  return table;
}
const keys = ["web_auth.refusal_host_sign_in", "update.available_stable", "update.failure.shell", "login.web_dashboard_not_installed", "login.web_cleanup_failed", "delivery.outbox_abi", "eventlog.abi", "config.general_missing", "logs.capped_tail"];
const ui = [["ui/settings-strings.js", ["webReadOnlyLead", "webSearchHint"]], ["ui/shared/web-authorize.js", ["reason_no_account", "reason_host_sign_in"]],
  ["ui/accounts-manage.js", ["err_signout_failed"]], ["ui/settings-devices.js", ["notSaved"]]] as const;

describe("#3326 D1 batch B: truthful recovery copy on its current surface", () => {
  it.each(["en", "zh-TW"] as const)("%s: scoped reminders and refusals contain no host-command detour", lang => {
    setLocale(lang);
    const texts = keys.map(key => [key, t(key, "Example", "2.3.5")] as const);
    if (src("locale.ts").includes('"hub.hold.hub-unsealed"')) texts.push(["hub.hold.hub-unsealed", t("hub.hold.hub-unsealed")]);
    for (const [path, fields] of ui) {
      if (!present(path)) continue; // Alpha's account controls do not exist on main.
      const table = catalogue(path);
      for (const key of fields) texts.push([`${path}:${key}`, table[lang]![key]!]);
    }
    expect(texts.length).toBeGreaterThanOrEqual(10);
    for (const [key, text] of texts) {
      expect(text, key).toBeTruthy(); expect(text, key).not.toMatch(forbidden);
      if (lang === "zh-TW") expect(text, key).toMatch(/[一-鿿]/);
    }
    expect(t("update.available_stable", "next", "current")).toContain("/update");
    expect(t("delivery.outbox_abi")).toMatch(/replacing the database will not fix|替換資料庫也無法解決/);
    expect(t("eventlog.abi")).toMatch(/left untouched|原封不動/);
    expect(catalogue("ui/shared/web-authorize.js")[lang]!.reason_no_account).toMatch(/General/);
    expect(catalogue("ui/shared/web-authorize.js")[lang]!.reason_host_sign_in).not.toMatch(/General|owner|operator|擁有者/);
  });
  it("incomplete rollback and non-durable sign-out remain explicit failures without a terminal repair instruction", () => {
    const auth = src("auth-api.ts").match(/export const REVOCATION_NOT_DURABLE_MESSAGE\s*=\s*"([^"]+)"/)![1]!;
    expect(auth).toMatch(/restart may bring the session back/); expect(auth).not.toMatch(forbidden);
    const rollback = [...src("quickstart-api.ts").matchAll(/error: "(setup cleanup failed;[^"]+)"/g)].map(x => x[1]!);
    expect(rollback).toHaveLength(2);
    const table = catalogue("ui/settings-strings.js"); expect(table.en!.webReadOnlyLead).toMatch(/cannot change/);
    for (const text of rollback) {
      expect(text).toMatch(/some saved changes may not have been undone/); expect(text).not.toMatch(forbidden);
      expect(src("ui/shared/setup-host-text.js")).toContain(text);
      const zh = hostText(text, "zh-TW"); expect(zh).toMatch(/部分已儲存的變更可能未能撤銷/); expect(zh).not.toMatch(forbidden);
    }
    expect(src("outbound-handlers.ts")).not.toContain("Use 'agend attach");
    for (const lang of ["en", "zh-TW"]) {
      const old = hostText("setup cleanup failed; inspect configuration on the host", lang);
      expect(old).not.toContain("inspect configuration on the host");
      expect(old).toMatch(/may not have been undone|可能未能撤銷/);
    }
    const warning = t("config.general_missing", "demo");
    expect(src("config-validator.ts")).toContain('t("config.general_missing", id)');
    expect(warning).toContain("Settings → Agents"); expect(warning).toContain("General topic (fleet dispatcher)"); expect(warning).not.toMatch(forbidden);
  });
  it.each(["en", "zh-TW"])("the actual sign-in form localizes a non-durable sign-out once (%s), retaining unrelated notices", lang => {
    const s = src("ui/shared/signin.js"), begin = s.indexOf("const T ="), end = s.indexOf("\n  const lang =", begin);
    const table = runInNewContext(s.slice(begin, end) + "; T;");
    const fn = s.match(/function showForm\(\) \{[\s\S]*?\n  \}/)![0];
    const note = "Signed out for now, but the change could not be saved: legacy host instructions";
    const el = () => ({ hidden: false, textContent: "", focus() {} });
    const elements: Record<string, ReturnType<typeof el>> = {}, remove = vi.fn();
    const run = (value: string) => runInNewContext(fn + "; showForm();", {
      $: (id: string) => elements[id] ??= el(), sessionStorage: { getItem: () => value, removeItem: remove },
      t: (key: string) => table[lang][key], offerResend() {},
    });
    run(note);
    expect(elements.msg!.textContent).toBe(table[lang].signout_unsaved);
    expect(elements.msg!.textContent).toMatch(/restart may bring|重新啟動後/);
    expect(elements.msg!.textContent).not.toContain("legacy host instructions");
    expect(remove).toHaveBeenCalledWith("agend_signout_note");
    run("Unrelated server notice"); expect(elements.msg!.textContent).toBe("Unrelated server notice");
  });
});
