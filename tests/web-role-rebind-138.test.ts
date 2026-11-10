/**
 * AGEND-138 (UI): the four roles in the session menu and the in-place "Re-bind" for a browser whose host sign-in lost this
 * computer's admin authority (`host_sign_in`). Rendered against a fake server.
 * - Roles: Owner ✓ (an admin whose authorization is valid), Admin · not verified, Guest, Read-only — in English and 繁體中文.
 * - Re-bind: explains `agend web --code`, takes the code, posts it to /auth/login, reloads; the next read says verified.
 *   There is no code-free button (127.0.0.1 doesn't say who is using the computer).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, tier = "admin", authorization: any = { state: "verified", until: Date.now() + 3_600_000 }, loginStatus = 200;
let sent: Array<{ method: string; path: string; body: any }> = [];
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (path === "/auth/login") {
    if (loginStatus === 200) authorization = { state: "verified", until: Date.now() + 3_600_000 };   // the new session is the host's again
    return { ok: loginStatus === 200, status: loginStatus, json: async () => ({}) };
  }
  const body = path === "/auth/session" ? { ok: true, label: "Firefox on Linux", tier, expiresAt: Date.now() + 3_600_000, idleMs: 1_800_000, handle: "a".repeat(16) }
    : path === "/auth/sessions" ? { sessions: [] }
    : path === "/ui/authorization" ? authorization : {};
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; tier = "admin"; loginStatus = 200; authorization = { state: "verified", until: Date.now() + 3_600_000 }; });
afterEach(async () => { await p.unmount(); const { setLang } = await import("/assets/app-i18n.js"); setLang("en"); });

async function menu() {
  const { SessionMenu } = await import("/assets/app-session.js");
  const { resetWebAuthorization } = await import("/assets/web-authorize.js");
  resetWebAuthorization();                                                       // each case is its own page load
  await p.unmount();
  await p.mount(h(SessionMenu, {}));
  await settle(10);
  fire(p.root.querySelector("button.side-row"), "click");
  await settle(10);
  return p.root.querySelector(".pop") as any;
}
const role = () => (p.root.querySelector(".pop .role") as any)?.textContent?.replace(/\s+/g, " ").trim() ?? null;

describe("AGEND-138: the role in the session menu", () => {
  it("an admin with a valid authorization is the owner ✓; one without is an admin, not verified", async () => {
    await menu();
    expect(role()).toBe("Role Owner ✓");
    authorization = { state: "none", reason: "host_sign_in" };
    await menu();
    expect(role()).toBe("Role Admin · not verified");
    authorization = { state: "none", reason: "not_authorized" };
    await menu();
    expect(role()).toBe("Role Admin · not verified");
  });
  it("a guest and a read-only session say so", async () => {
    tier = "guest"; await menu();
    expect(role()).toBe("Role Guest");
    tier = "read"; await menu();
    expect(role()).toBe("Role Read-only");
  });
  it("in 繁體中文", async () => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    await menu();
    expect(role()).toBe("角色 擁有者 ✓");
    authorization = { state: "none", reason: "host_sign_in" };
    await menu();
    expect(role()).toBe("角色 管理者 · 未驗證");
    tier = "guest"; await menu();
    expect(role()).toBe("角色 訪客");
    tier = "read"; await menu();
    expect(role()).toBe("角色 唯讀");
  });
});

describe("AGEND-138: Re-bind in the popover", () => {
  const reload = vi.fn();
  beforeEach(() => { reload.mockReset(); (globalThis as any).location.reload = reload; authorization = { state: "none", reason: "host_sign_in" }; });

  it("host_sign_in offers Re-bind; it explains agend web --code and takes a code — never a code-free bind", async () => {
    const pop = await menu();
    const chip = pop.querySelector(".webauth-chip");
    expect(chip.dataset.state).toBe("none");
    const open = chip.querySelector("button.webauth-rebind");
    expect(open.textContent).toBe("Re-bind");
    expect(pop.querySelector("input.webauth-rebind-code")).toBeNull();
    fire(open, "click"); await settle(6);
    expect(pop.textContent).toContain("agend web --code");
    expect(pop.querySelector("input.webauth-rebind-code")).not.toBeNull();
    expect(sent.filter((s) => s.path === "/auth/login")).toEqual([]);               // nothing is sent until a code is typed and submitted
  });
  it("other reasons have no Re-bind (it is only for a host sign-in that lost its authority)", async () => {
    for (const reason of ["no_account", "loopback_only", "not_admin"]) {
      authorization = { state: "none", reason };
      const pop = await menu();
      expect(pop.querySelector(".webauth-rebind"), reason).toBeNull();
    }
  });
  it("the code goes to /auth/login, the page reloads, and the browser reads as verified (the owner ✓)", async () => {
    const pop = await menu();
    fire(pop.querySelector("button.webauth-rebind"), "click"); await settle(6);
    const input = pop.querySelector("input.webauth-rebind-code");
    input.value = "ABCD-EFGH"; fire(input, "input"); await settle(4);
    fire(pop.querySelector("form.webauth-rebind-form"), "submit"); await settle(10);
    expect(sent.filter((s) => s.path === "/auth/login")).toEqual([{ method: "POST", path: "/auth/login", body: { code: "ABCD-EFGH" } }]);
    expect(reload).toHaveBeenCalledTimes(1);
    const after = await menu();                                                     // the reloaded page
    expect(after.querySelector(".webauth-chip").dataset.state).toBe("verified");
    expect(role()).toBe("Role Owner ✓");
  });
  it("a wrong code says so, stays on the page and keeps the form; a pause and a server failure are worded apart", async () => {
    const pop = await menu();
    fire(pop.querySelector("button.webauth-rebind"), "click"); await settle(6);
    const input = pop.querySelector("input.webauth-rebind-code");
    input.value = "NOPE"; fire(input, "input"); await settle(4);
    for (const [status, text] of [[401, "That sign-in code didn't work"], [429, "Too many wrong codes"], [503, "could not confirm the sign-in"]] as const) {
      loginStatus = status;
      fire(pop.querySelector("form.webauth-rebind-form"), "submit"); await settle(10);
      expect(pop.querySelector("[role=alert]").textContent, String(status)).toContain(text);
    }
    expect(reload).not.toHaveBeenCalled();
    expect(pop.querySelector("input.webauth-rebind-code")).not.toBeNull();
  });
});
