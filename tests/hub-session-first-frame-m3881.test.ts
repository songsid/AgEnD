/** Actual public entry and actual Hub module: defer only the local session response. */
import { afterEach, expect, it, vi } from "vitest";
import { fire, installDom } from "./helpers/mini-dom.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.doUnmock("/ui/js/panel-hub.js");
  vi.unstubAllGlobals();
  vi.resetModules();
});
const signedIn = { signedIn: true, login: "alex", displayName: "Alex", admin: true, csrf: "fixture-csrf", features: [] };
async function boot(path = "/ui/hub", oldModule = false) {
  vi.resetModules();
  const dom = installDom({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", agend_lang: "en" } });
  const app = dom.document.createElement("div"); app.id = "app"; dom.document.body.appendChild(app);
  // The real HTML ships a boot placeholder before any module executes.
  app.innerHTML = '<div class="sk-boot"><div class="sk-boot-side" aria-hidden="true"></div></div>';
  for (const [key, value] of Object.entries({ "data-mode": "full", "data-hub": "hub", "data-hub-name": "Fixture Hub", "data-web-transport": "none" })) dom.document.body.setAttribute(key, value);
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const reads: string[] = [];
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input), method = init.method || "GET"; reads.push(`${method} ${path}`);
    const body = path === "/hub/v1/session" ? method === "POST" ? signedIn : await pending : { rooms: [], fleets: [], pairings: [], mine: [], askable: [], notices: [] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  }));
  const { options, render } = await import("/assets/preact.module.js");
  options.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
  cleanups.push(() => { render(null, app as any); dom.restore(); });
  if (oldModule) vi.doMock("/ui/js/panel-hub.js", () => ({ HubPanel: () => null, HubWorkspace: undefined }));
  await import("/assets/app.js");
  // Settle the entry's module load, while the independent session response stays held.
  if (!oldModule) {
    await import("/ui/js/panel-hub.js");
    await vi.waitFor(() => expect(reads).toContain("GET /hub/v1/session"));
  }
  return { app, dom, reads, release };
}
it("shows no workspace or Hub name while the session is pending, then only sign-in", async () => {
  const p = await boot();
  expect(p.app.querySelector("#sidebar")).toBeNull();
  expect(p.app.textContent).not.toContain("Fixture Hub");
  expect(p.app.querySelector(".session-loading-page")).not.toBeNull();
  expect(p.app.querySelector(".sk-boot")).toBeNull();
  expect(p.reads.filter(path => path.startsWith("GET /hub/"))).toEqual(["GET /hub/v1/session"]);
  p.release({ signedIn: false });
  await vi.waitFor(() => expect(p.app.querySelector("#hubLogin")).not.toBeNull());
  expect(p.app.querySelector("#sidebar")).toBeNull();
  expect(p.app.querySelector(".session-loading-page")).toBeNull();
});
it.each(["exposures", "admin"])("opens a signed-in %s deep link from the same session read", async tab => {
  const p = await boot(`/ui/hub/${tab}`);
  p.release(signedIn);
  await vi.waitFor(() => expect(p.app.querySelector(`#main .p-hub-${tab}`)).not.toBeNull());
  expect(p.app.querySelector("#sidebar")).not.toBeNull();
  expect(location.pathname).toBe(`/ui/hub/${tab}`);
  expect(p.reads.filter(path => path === "GET /hub/v1/session")).toHaveLength(1);
  expect(p.reads.some(path => path.includes("/api/"))).toBe(false);
});
it("keeps the deep-link URL through sign-in and opens its page afterwards", async () => {
  const p = await boot("/ui/hub/exposures?fixture=kept");
  p.release({ signedIn: false });
  await vi.waitFor(() => expect(p.app.querySelector("#hubLogin")).not.toBeNull());
  const login = p.app.querySelector("#hubLogin")!, password = p.app.querySelector("#hubPassword")!;
  login.value = "alex"; fire(login, "input"); password.value = "fixture-password"; fire(password, "input");
  await new Promise(resolve => setTimeout(resolve, 0));
  fire(p.app.querySelector("form")!, "submit");
  await vi.waitFor(() => expect(p.app.querySelector("#main .p-hub-exposures")).not.toBeNull());
  expect(location.pathname + location.search).toBe("/ui/hub/exposures?fixture=kept");
  expect(p.reads.filter(path => path === "GET /hub/v1/session")).toHaveLength(1);
  expect(p.reads.filter(path => path === "POST /hub/v1/session")).toHaveLength(1);
});

it("offers the existing reload prompt when a retained Hub module lacks the session boundary", async () => {
  const p = await boot("/ui/hub", true);
  await vi.waitFor(() => expect(p.app.querySelector("[data-stale-tab]")).not.toBeNull());
  expect(p.app.querySelector("#sidebar")).toBeNull();
  expect(p.app.textContent).not.toContain("Fixture Hub");
  expect(p.app.textContent).toContain("Reload this tab");
  expect(p.reads).toEqual([]);
});
