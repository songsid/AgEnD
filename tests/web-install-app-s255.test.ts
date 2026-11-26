/**
 * S-255: install the dashboard or the Hub as an app. The page registers /sw.js — no fetch handler, no cache, so no API
 * answer or chat is ever kept by it — and turns the browser's install offer into a button. Where the browser can't
 * install (an https address whose certificate it doesn't trust, a plain-http LAN address) it says why instead of a
 * prompt that fails; Safari on iPhone gets the Share → Add to Home Screen words; an installed window shows nothing.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { SERVICE_WORKER, handleWebIconRequest, isWebIconPath } from "../src/web-icons.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0).reverse()) { await p.unmount(); p.restore(); } });

/** A window as startInstall sees it: listeners, a service worker container and the facts each case changes. */
function fakeWindow(o: { secure?: boolean; ua?: string; standalone?: boolean; register?: () => Promise<unknown>; noWorker?: boolean } = {}) {
  const listeners = new Map<string, (e: any) => void>();
  const register = vi.fn(o.register ?? (async () => ({ scope: "/" })));
  const env: any = {
    isSecureContext: o.secure ?? true,
    navigator: { userAgent: o.ua ?? "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36", maxTouchPoints: 0, ...(o.noWorker ? {} : { serviceWorker: { register } }) },
    matchMedia: () => ({ matches: !!o.standalone }),
    addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn),
  };
  return { env, register, emit: (name: string, e: any) => listeners.get(name)?.(e) };
}
const offer = (outcome: "accepted" | "dismissed") => ({ preventDefault: vi.fn(), prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome }) });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the service worker", () => {
  it("is served before sign-in, never from cache, and has no fetch handler or cache at all", () => {
    expect(isWebIconPath("/sw.js")).toBe(true);
    expect(isPublicWebRoute("GET", "/sw.js")).toBe(true);
    expect(SERVICE_WORKER).not.toMatch(/addEventListener\(\s*["']fetch/);
    expect(SERVICE_WORKER).not.toMatch(/caches|cache\.put|respondWith|importScripts/);
    const out: Record<string, string> = {}; let status = 0, body = "";
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/sw.js?v=default", headers: { host: "localhost" } }) as unknown as IncomingMessage;
    const res = { writeHead: (c: number, hs: Record<string, string>) => { status = c; Object.assign(out, hs); }, end: (b?: Buffer) => { body = String(b ?? ""); } } as unknown as ServerResponse;
    expect(handleWebIconRequest(req, res, "/sw.js")).toBe(true);
    expect([status, out["Content-Type"], out["Cache-Control"]]).toEqual([200, "text/javascript; charset=utf-8", "no-cache"]);
    expect(body).toBe(SERVICE_WORKER);
  });
});

describe("what the page says", () => {
  it("Chrome/Edge on a trusted address: registers /sw.js at /, keeps the offer, Install opens the browser's dialog", async () => {
    const m = await import("/assets/app-install.js") as any;
    const w = fakeWindow(); m.startInstall(w.env); await flush();
    expect(w.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(m.installStore.get().state).toBe("none");                     // nothing offered yet: nothing shown
    const e = offer("accepted"); w.emit("beforeinstallprompt", e);
    expect([e.preventDefault.mock.calls.length, m.installStore.get().state]).toEqual([1, "available"]);
    await expect(m.promptInstall()).resolves.toBe("accepted");
    expect([e.prompt.mock.calls.length, m.installStore.get().state]).toEqual([1, "installed"]);
  });
  it("a dismissed offer is spent and the hint goes away until the browser offers again", async () => {
    const m = await import("/assets/app-install.js") as any;
    const w = fakeWindow(); m.startInstall(w.env);
    w.emit("beforeinstallprompt", offer("dismissed"));
    await expect(m.promptInstall()).resolves.toBe("dismissed");
    expect(m.installStore.get().state).toBe("none");
    await expect(m.promptInstall()).resolves.toBe("none");
  });
  it("an https address whose certificate the browser doesn't trust: the worker is refused, and the page says why", async () => {
    const m = await import("/assets/app-install.js") as any;
    const w = fakeWindow({ register: async () => { throw Object.assign(new Error("An SSL certificate error occurred"), { name: "SecurityError" }); } });
    m.startInstall(w.env); await flush();
    expect(m.installStore.get().state).toBe("untrusted");
  });
  it("a plain-http LAN address: no registration attempt, it says why; a missing worker API says nothing", async () => {
    const m = await import("/assets/app-install.js") as any;
    const w = fakeWindow({ secure: false }); m.startInstall(w.env); await flush();
    expect([w.register.mock.calls.length, m.installStore.get().state]).toEqual([0, "insecure"]);
    const old = fakeWindow({ noWorker: true }); m.startInstall(old.env); await flush();
    expect(m.installStore.get().state).toBe("none");
  });
  it("Safari on iPhone: the Share → Add to Home Screen words; running as the app already: nothing", async () => {
    const m = await import("/assets/app-install.js") as any;
    m.startInstall(fakeWindow({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1" }).env); await flush();
    expect(m.installStore.get().state).toBe("ios");
    const app = fakeWindow({ standalone: true }); m.startInstall(app.env); await flush();
    expect([m.installStore.get().state, app.register.mock.calls.length]).toEqual(["installed", 0]);
  });
});

describe("the hint", () => {
  async function mount(state: string, which: "section" | "button", locale = "en") {
    const pg = page(); pages.push(pg);
    const i18n = await import("/assets/app-i18n.js") as any; i18n.setLang(locale, { store: false });
    const m = await import("/assets/app-install.js") as any;
    m.installStore.set({ state });
    await pg.mount(h(which === "section" ? m.InstallAppSection : m.InstallAppButton, {})); await settle(2);
    return { pg, m, i18n };
  }
  it.each(["en", "zh-TW"] as const)("Needs you's This device row (%s): Install where offered, the reason where not, nothing otherwise", async (locale) => {
    const { pg, i18n } = await mount("available", "section", locale);
    try {
      expect(pg.root.querySelector(".n-install")?.textContent).toContain(locale === "en" ? "Install as an app" : "安裝成應用程式");
      expect(pg.root.querySelector(".n-install button")?.textContent).toContain(locale === "en" ? "Install" : "安裝");
      const { m } = await import("/assets/app-install.js").then((m) => ({ m })) as any;
      m.installStore.set({ state: "untrusted" }); await settle(2);
      expect(pg.root.querySelector(".n-install button")).toBeNull();
      expect(pg.root.querySelector(".n-install")?.textContent).toContain(locale === "en" ? "doesn't trust this address's certificate" : "不信任這個網址的憑證");
      for (const state of ["none", "installed"]) { m.installStore.set({ state }); await settle(2); expect(pg.root.querySelector(".n-install")).toBeNull(); }
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("the Hub header button: says why in the app's own dialog when it can't install", async () => {
    const { pg } = await mount("untrusted", "button");
    const asked: string[] = []; (globalThis as any).confirm = (msg: string) => { asked.push(msg); return true; };
    try {
      fire(pg.root.querySelector(".hub-install"), "click"); await settle(4);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("Ask your administrator for a trusted certificate");
    } finally { (globalThis as any).confirm = undefined; }
  });
});
