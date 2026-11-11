import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, app: any, SessionMenu: any, status = 200, redirected: string | null = null;
const cleanup = vi.fn(), originalFetch = globalThis.fetch;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" });
  Object.defineProperty(location, "href", { configurable: true, set(value) { redirected = value; expect(cleanup).toHaveBeenCalledTimes(1); } });
  app = await import("/assets/app-store.js"); ({ SessionMenu } = await import("/assets/app-session.js"));
  globalThis.fetch = (async (url: string) => ({ ok: url !== "/auth/logout" || status === 200, status,
    json: async () => url === "/auth/session" ? { tier: "admin", label: "Owned browser", expiresAt: Date.now() + 60000, idleMs: 30000 } : {} })) as any;
});
afterEach(async () => { await p.unmount(); app.appStore.set({ chatWorkspaceSessionEnd: null }); cleanup.mockReset(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
describe("workspace display memory follows the existing sign-out result", () => {
  it.each([403, 200])("sign-out status %i clears memory only on success, before leaving", async code => {
    status = code; redirected = null;
    app.appStore.set({ chatWorkspaceSessionEnd: () => { expect(location.pathname).toBe("/ui/chat/alpha"); cleanup(); } });
    await p.mount(h(SessionMenu)); await settle(5);
    fire(p.root.querySelector(".session > button"), "click"); await settle(5);
    const button = p.root.querySelector(".pop .row button")!;
    fire(button, "click"); await settle(5);
    expect(cleanup).toHaveBeenCalledTimes(code === 200 ? 1 : 0);
    expect(p.root.querySelector("[role=alert]") !== null).toBe(code !== 200);
    expect(redirected).toBe(code === 200 ? "/signin" : null);
  });
});
