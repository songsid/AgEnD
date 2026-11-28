// M-3864 R6: an admin signed in with a code from this computer has no chat identity. The Permissions tab and Fleet →
// Authorizations told them to press "Authorize this browser" in Sign-in status, which shows no such button for them (it
// says to send /web from the chat). The pages now show this browser's own authorize line: the button, or why it can't be
// authorized here and where to fix that, with Try again.
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const g = globalThis as any, realFetch = g.fetch, mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } g.fetch = realFetch; });
const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();
let reads = 0;
async function show(which: "list" | "agent", authorization: unknown) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/authorizations", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  g.fetch = async (url: string) => {
    const u = String(url);
    if (u.startsWith("/ui/authorization")) return { ok: true, status: 200, json: async () => authorization };
    if (u.startsWith("/ui/api/request-contact-authorizations")) return { ok: false, status: 404, json: async () => ({}) };
    reads++;
    return { ok: false, status: 403, json: async () => ({ error: "verification-required" }) };
  };
  (await import("/assets/app-i18n.js") as any).setLang("en");
  (await import("/assets/app-store.js") as any).appStore.set({ streamOn: () => () => {}, instances: [{ name: "room" }] });
  const Comp = which === "list" ? (await import("/ui/js/contact-authorizations.js") as any).ContactAuthorizations : (await import("/ui/js/contact-permissions.js") as any).ContactPermissionsPanel;
  await pg.mount(h(Comp, which === "list" ? {} : { name: "room" }));
  await settle(6);
  return pg;
}

describe("M-3864 R6: verification-required shows how to verify this browser", () => {
  it.each(["agent", "list"] as const)("%s page: a code sign-in is told to send /web from the chat, and can try again", async (which) => {
    const pg = await show(which, { state: "unavailable", reason: "no_account" });
    const said = text(pg.root);
    expect(said).toContain("Permissions and contact requests need a verified administrator. Authorize this browser, then try again.");
    expect(said).toContain("This browser has no chat-account identity. Open General in Telegram or Discord and send /web to sign in as your account.");
    expect(said).not.toContain("Sign-in status");
    const before = reads;
    const retry = [...pg.root.querySelectorAll("button")].find((b: any) => text(b) === "Try again");
    expect(retry).toBeTruthy();
    retry.click(); await settle(4);
    expect(reads).toBeGreaterThan(before);
  });
});
