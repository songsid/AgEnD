/**
 * Refs #3061 (P2b), AGEND-138 (#3486): the sidebar's Session menu (src/ui/shared/app-session.js). The other signed-in devices are
 * not listed in it any more — Settings → Devices has the full list and "Sign out everywhere" (tests/settings-devices-3061.test.ts):
 *  - an admin session gets its own Sign out and a "Manage devices" link to Settings → Access & security; it lists no device and
 *    offers no "Sign out everywhere", and does not even read /auth/sessions;
 *  - a guest or read-only session has no Settings: its own Sign out stays, and "Sign out everywhere" (its account's devices,
 *    what the server lets it end) while it has another device.
 * The server decides who may end what regardless (tests/device-list-3061.test.ts) — this is only the page not offering what
 * would fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, tier = "admin", listing: Record<string, unknown>, asked: string[] = [];
const realFetch = (globalThis as any).fetch;
const SESSIONS = [
  { handle: "a".repeat(16), label: "Firefox on Linux", current: true, lastSeen: Date.now(), via: "host" },
  { handle: "b".repeat(16), label: "Chrome on Android", current: false, lastSeen: Date.now() - 300_000, via: "device" },
];
const fakeFetch = async (path: string) => {
  asked.push(path);
  const body = path === "/auth/session" ? { ok: true, label: "Firefox on Linux", tier, expiresAt: Date.now() + 3_600_000, idleMs: 1_800_000, handle: "a".repeat(16) }
    : path === "/auth/sessions" ? listing : {};
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
afterEach(async () => { await p.unmount(); });

async function menu(who: string, sessions = SESSIONS) {
  tier = who; listing = { sessions }; asked = [];
  const { SessionMenu } = await import("/assets/app-session.js");
  await p.unmount();
  await p.mount(h(SessionMenu, {}));
  await settle(10);
  fire(p.root.querySelector("button.side-row"), "click");
  await settle(10);
  const buttons = () => [...p.root.querySelectorAll(".pop button")].map((b: any) => (b.textContent ?? "").trim());
  return { buttons, rows: () => [...p.root.querySelectorAll(".devices li")].length, link: () => p.root.querySelector("#manageDevices") as any };
}

describe("AGEND-138: the Session menu points to Settings → Devices instead of listing devices", () => {
  it("an admin: no device list, no Sign out everywhere (it moved to Settings), a Manage devices link to Settings → Access & security, its own Sign out", async () => {
    const m = await menu("admin");
    expect(m.rows()).toBe(0);
    expect(p.root.querySelector(".pop .devices")).toBeNull();
    expect(m.buttons()).toEqual(["Sign out"]);
    expect([m.link().textContent.trim(), m.link().getAttribute("href")]).toEqual(["Manage devices", "/settings/access"]);
    expect(asked).not.toContain("/auth/sessions");                                       // the list is not even read
  });

  it("in 繁體中文 the link says 管理裝置", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const m = await menu("admin");
      expect(m.link().textContent.trim()).toBe("管理裝置");
    } finally { i18n.setLang("en"); }
  });

  it("a guest or read-only session (no Settings): its own Sign out, and Sign out everywhere while it has another device — no list, no link", async () => {
    for (const who of ["guest", "read"]) {
      const m = await menu(who);
      expect(m.buttons(), who).toEqual(["Sign out", "Sign out everywhere"]);
      expect([m.rows(), m.link()], who).toEqual([0, null]);
      const alone = await menu(who, [SESSIONS[0]]);
      expect(alone.buttons(), who).toEqual(["Sign out"]);
    }
  });
});
