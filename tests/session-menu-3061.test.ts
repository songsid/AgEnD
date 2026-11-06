/**
 * Refs #3061 (P2b): the sidebar's Session menu (src/ui/shared/app-session.js) follows what the server says about ending OTHER
 * devices. `GET /auth/sessions` tells an admin session that is not allowed to (`canEndOthers: false` — on a web-only fleet only
 * the verified owner is): the menu then lists the devices but offers no Sign out beside the others and no "Sign out everywhere";
 * its own Sign out stays. Without the word (the owner, a fleet with a chat connection, an older server) it is as it was.
 * The server refuses a non-owner regardless (tests/device-list-3061.test.ts) — this is only the page not offering what would fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, listing: Record<string, unknown>;
const realFetch = (globalThis as any).fetch;
const SESSIONS = [
  { handle: "a".repeat(16), label: "Firefox on Linux", current: true, lastSeen: Date.now(), via: "host" },
  { handle: "b".repeat(16), label: "Chrome on Android", current: false, lastSeen: Date.now() - 300_000, via: "device" },
];
const fakeFetch = async (path: string) => {
  const body = path === "/auth/session" ? { ok: true, label: "Firefox on Linux", expiresAt: Date.now() + 3_600_000, idleMs: 1_800_000, handle: "a".repeat(16) }
    : path === "/auth/sessions" ? listing : {};
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
afterEach(async () => { await p.unmount(); });

async function menu(extra: Record<string, unknown> = {}) {
  listing = { sessions: SESSIONS, ...extra };
  const { SessionMenu } = await import("/assets/app-session.js");
  await p.unmount();
  await p.mount(h(SessionMenu, {}));
  await settle(10);
  fire(p.root.querySelector("button.side-row"), "click");
  await settle(10);
  const buttons = () => [...p.root.querySelectorAll(".pop button")].map((b: any) => (b.textContent ?? "").trim());
  return { buttons, rows: () => [...p.root.querySelectorAll(".devices li")].length };
}

describe("#3061 P2b: the Session menu and the right to end other devices", () => {
  it("allowed (nothing said, as the owner's and a chat fleet's list): a Sign out beside each other device, and Sign out everywhere", async () => {
    const m = await menu();
    expect(m.rows()).toBe(2);
    expect(m.buttons()).toEqual(["Sign out", "Sign out", "Sign out everywhere"]);        // the other device's, this one's, all
  });

  it("`canEndOthers: false`: the devices are listed, the other's Sign out and Sign out everywhere are not offered, this one's Sign out stays", async () => {
    const m = await menu({ canEndOthers: false });
    expect(m.rows()).toBe(2);
    expect(m.buttons()).toEqual(["Sign out"]);
  });

  it("only an explicit false takes them away (a missing or odd value is 'as it was')", async () => {
    for (const odd of [undefined, null, true, 0, "no"]) {
      const m = await menu({ canEndOthers: odd });
      expect(m.buttons().length, String(odd)).toBe(3);
    }
  });
});
