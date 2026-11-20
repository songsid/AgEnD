import { afterEach, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const pages: AppPage[] = [];
const realFetch = globalThis.fetch;
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } globalThis.fetch = realFetch; });
const item = { id: "contact-suggest:room-demo", type: "contact", reason: "contact_restricted_suggestion", instance: "room-demo", contactSuggestion: { instance: "room-demo" } };
it.each([
  ["en", 403, "verification-required", "Verify your administrator identity", "Later"],
  ["zh-TW", 403, "verification-required", "驗證管理員身分", "稍後"],
  ["en", 403, "forbidden", "administrator for this room", "Later"],
  ["zh-TW", 503, "unavailable", "主機的可用空間", "稍後"],
  ["en", 404, "missing", "Refresh this page", "Later"],
  ["en", 401, "expired", "Sign in again", "Later"],
  ["en", 403, "Write rejected — missing or wrong CSRF token (reload the page)", "write verification failed", "Later"],
])("%s: Later explains HTTP %s (%s) and how to recover", async (lang, status, code, expected, label) => {
  const p = page({ url: "http://127.0.0.1:19280/ui/needs" }); pages.push(p);
  globalThis.fetch = (async (_url: string, init?: RequestInit) => ({ ok: init?.method !== "POST", status: init?.method === "POST" ? status : 200,
    json: async () => init?.method === "POST" ? { error: code, code } : {} })) as any;
  const i18n = await import("/assets/app-i18n.js" as string); i18n.setLang(lang, { store: false });
  try {
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js" as string);
    const { Toasts } = await import("/assets/ui-toast.js" as string);
    await p.mount(h("div", null, h(ContactNeedsItem, { item }), h(Toasts, null))); await settle(5);
    const later = [...p.root.querySelectorAll("button")].find(b => b.textContent === label)!;
    fire(later, "click"); await settle(8);
    expect(p.document.body.textContent).toContain(expected);
    expect(p.root.querySelector(".contact-need")).not.toBeNull();
  } finally { i18n.setLang("en", { store: false }); }
});
