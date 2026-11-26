/**
 * S-257 step 1 (M-3828): Hub notifications reach a person only while a Hub tab or the installed app is open. The first
 * time Notify goes on on this device, the app's own notice says what keeps them coming once every Hub window is
 * closed: install the Hub as an app and leave it running, or start it at sign-in. Once per device; off asks nothing.
 */
import { afterEach, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });

async function rig(installed: boolean | string = false) {
  const pg = page(); pages.push(pg);
  class Notification { static permission = "granted"; static requestPermission = async () => "granted"; }
  vi.stubGlobal("Notification", Notification); vi.stubGlobal("isSecureContext", true);
  const i18n = await import("/assets/app-i18n.js") as any; i18n.setLang("en", { store: false });
  const install = await import("/assets/app-install.js") as any; install.installStore.set({ state: typeof installed === "string" ? installed : installed ? "installed" : "none" });
  const notify = await import("/ui/js/hub-notify-keep.js") as any; notify.forgetKeepHint();
  const asked: string[] = []; (globalThis as any).confirm = (m: string) => { asked.push(m); return true; };
  return { notify, asked, install };
}

it("the first time Notify goes on in a browser tab: install the app and leave it running, or start it at sign-in; then never again", async () => {
  const { notify, asked } = await rig();
  try {
    await expect(notify.setHubNotify(true)).resolves.toBe("on"); await settle(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("closing every Hub tab stops them");
    expect(asked[0]).toContain("install the Hub as an app (the button beside the bell) and leave it running");
    expect(asked[0]).toContain("Start app when you sign in");
    await notify.setHubNotify(false); await notify.setHubNotify(true); await settle(2);
    expect(asked).toHaveLength(1);
  } finally { (globalThis as any).confirm = undefined; }
});
it("in the installed app the words are about leaving the app running", async () => {
  const { notify, asked } = await rig(true);
  try {
    localStorage.removeItem("agend_hub_notify_kept");
    await notify.setHubNotify(true); await settle(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("quitting it stops them");
    expect(asked[0]).not.toContain("install the Hub as an app");
  } finally { (globalThis as any).confirm = undefined; }
});
it("turning it off, or a refusal by the browser, says nothing", async () => {
  const { notify, asked } = await rig();
  try {
    localStorage.removeItem("agend_hub_notify_kept");
    await notify.setHubNotify(false); await settle(2);
    class Blocked { static permission = "denied"; static requestPermission = async () => "denied"; }
    vi.stubGlobal("Notification", Blocked);
    await expect(notify.setHubNotify(true)).resolves.toBe("denied"); await settle(2);
    expect(asked).toEqual([]);
  } finally { (globalThis as any).confirm = undefined; }
});
it("a Hub this browser can't install (an untrusted certificate): keep a tab open, and why the app isn't offered", async () => {
  const { notify, asked } = await rig("untrusted");
  try {
    localStorage.removeItem("agend_hub_notify_kept");
    await notify.setHubNotify(true); await settle(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Keep a Hub tab open");
    expect(asked[0]).toContain("can't be installed as an app yet");
    expect(asked[0]).not.toContain("install the Hub as an app (the button beside the bell) and leave it running");
  } finally { (globalThis as any).confirm = undefined; }
});
it.each(["en", "zh-TW"] as const)("%s: the words are this module's own (a tab holding an older room dictionary still reads them), never raw keys", async (locale) => {
  const { notify, asked } = await rig();
  const i18n = await import("/assets/app-i18n.js") as any; i18n.setLang(locale, { store: false });
  try {
    localStorage.removeItem("agend_hub_notify_kept");
    await notify.setHubNotify(true); await settle(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/hubkeep\.|\bkeep(Tab|App|NoInstall)\b/);
    expect(asked[0]).toContain(locale === "en" ? "closing every Hub tab stops them" : "關掉所有 Hub 分頁後就不會再通知");
    const strings = await import("/ui/js/hub-room-strings.js").then(() => "loaded");
    expect(strings).toBe("loaded");
  } finally { i18n.setLang("en", { store: false }); (globalThis as any).confirm = undefined; }
});
it("a browser whose storage refuses: still once per page across off and on", async () => {
  const { notify, asked } = await rig();
  const real = globalThis.localStorage;
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} });
  try {
    await notify.setHubNotify(true); await settle(2);
    await notify.setHubNotify(false); await notify.setHubNotify(true); await settle(2);
    expect(asked).toHaveLength(1);
  } finally { vi.stubGlobal("localStorage", real); (globalThis as any).confirm = undefined; }
});
