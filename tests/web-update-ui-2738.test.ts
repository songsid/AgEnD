// M-2738 (#3332): the web's Update — the app-wide line (an admin's new version, the update's progress in every tab, its
// failure said at the person's level, the reload a tab on the old version needs), the one confirmation, Settings →
// Advanced's "Version and update" card, and /update in a chat opening the same dialog. The server is faked (GET /ui/update).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

type Req = { method: string; url: string; key: string | null; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => { status?: number; body?: unknown } | undefined = () => undefined;
async function fetchFake(url: string, init: any = {}) {
  const headers = init.headers || {};
  const r: Req = { method: init.method || "GET", url, key: headers["Idempotency-Key"] ?? null, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const a = answer(r) ?? (url === "/api/settings/restart-pending" ? { body: { pending: false } } : { status: 404, body: {} });
  const status = a.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
}
const ADMIN = (extra: Record<string, unknown> = {}) => ({ admin: true, current: "2.3.5-beta.2", offer: { version: "2.3.5-beta.3", channel: "beta", installable: true },
  checked_at: Date.UTC(2026, 10, 9, 9, 12), check_failed: false, progress: null, now: Date.now(), ...extra });
const posts = () => reqs.filter(r => r.method === "POST").map(r => r.url);

let p: AppPage;
let shell: any, upd: any, cmds: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js");
  upd = await import("/assets/app-update.js");
  cmds = await import("/ui/js/chat-commands.js");
  (await import("/assets/app-nav.js")).startRouter(p.window);
});
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => undefined;
  try { (globalThis as any).localStorage.clear(); } catch { /* none */ }
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null });
});
afterEach(() => { p.document.body.removeAttribute("data-tier"); });

const panels = () => new Map([["fleet", { load: async () => () => h("div", { class: "panel" }, "fleet") }]]);
const mountShell = async () => { await p.mount(h(shell.Shell, { panels: panels() })); await settle(10); };
const line = () => p.root.querySelector(".update-line");
const button = (text: string) => ([...(p.root.querySelectorAll("button") ?? [])] as any[]).find((b) => b.textContent === text);
const press = async (label: string, yes?: boolean) => {
  if (yes !== undefined) { (globalThis as any).confirm = () => yes; p.window.confirm = () => yes; }
  button(label).click();
  await settle(10);
};

describe("M-2738: the update line", () => {
  it("an admin sees the new version; Update now asks once (Cancel starts nothing), then starts with a key and the literal", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : r.url === "/ui/update/start" ? { status: 202, body: { started: true } } : undefined);
    await mountShell();
    expect(line()?.textContent).toContain("AgEnD v2.3.5-beta.3 is available (current v2.3.5-beta.2)");
    expect(line()?.textContent).toContain("Preview · only admins see this");
    expect(line()?.className).not.toContain("lbar");                       // no accent bar (the leader's polish 1)
    await press("Update now", false);
    expect(posts()).toEqual([]);
    await press("Update now", true);
    await vi.waitFor(() => expect(posts()).toEqual(["/ui/update/start"]));
    const sent = reqs.find(r => r.url === "/ui/update/start")!;
    expect([sent.body, typeof sent.key, (sent.key ?? "").length >= 8]).toEqual([{ confirm: "update-agend" }, "string", true]);
  });

  it("Later hides it for that version only", async () => {
    let info = ADMIN();
    answer = r => (r.url === "/ui/update" ? { body: info } : undefined);
    await mountShell();
    await press("Later");
    expect(line()).toBeNull();
    info = ADMIN({ offer: { version: "2.3.5-beta.4", channel: "beta", installable: true } });
    await upd.refreshUpdate(); await settle(6);
    expect(line()?.textContent).toContain("v2.3.5-beta.4");
  });

  it("progress: a spinner, the stage, step n of 4 with the time elapsed, a progress bar; no buttons", async () => {
    const started = Date.now() - 35_000;
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ progress: { stage: "downloading", started_at: started, version: "2.3.5-beta.3", web: true } }) } : undefined);
    await mountShell();
    const text = line()?.textContent ?? "";
    expect(text).toContain("Downloading and installing v2.3.5-beta.3…");
    expect(text).toMatch(/Step 2 of 4 · 3[5-7] s elapsed/);
    expect(text).toContain("Closing this page does not affect the update.");
    expect([!!line()?.querySelector(".update-spinner"), line()?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")]).toEqual([true, "2"]);
    expect(line()?.querySelectorAll("button").length).toBe(0);
  });

  it("a failure reads as an error at the person's level, never the updater's words; the full log has them; × dismisses it", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ progress: { stage: "failed", failed_stage: "downloading", cause: "network", started_at: 111, version: "2.3.5-beta.3", web: true } }) }
      : r.url === "/ui/update/log" ? { body: { text: "npm ERR! code ENOTFOUND\n", error: "getaddrinfo ENOTFOUND registry.npmjs.org" } } : undefined);
    await mountShell();
    expect(line()?.className).toContain("bad");
    expect(line()?.getAttribute("role")).toBe("alert");
    expect(line()?.textContent).toContain("Update failed: the update source could not be reached.");
    expect(line()?.textContent).toContain("AgEnD is still v2.3.5-beta.2; nothing was changed.");
    expect(line()?.textContent).not.toMatch(/npm|ENOTFOUND|registry/);
    expect(!!button("Try again")).toBe(true);
    await press("See the full log");
    await vi.waitFor(() => expect(p.document.querySelector(".update-log")?.textContent).toContain("npm ERR! code ENOTFOUND"));
    expect(p.document.body.textContent).toContain("getaddrinfo ENOTFOUND registry.npmjs.org");
    upd.updateStore.set({ log: null }); await settle(4);
    (p.root.querySelector(".update-x") as any).click(); await settle(6);
    expect(line()?.className).not.toContain("bad");                          // gone; the offer is shown again
    expect(line()?.textContent).toContain("is available");
    expect((globalThis as any).localStorage.getItem("agend_update_dismissed")).toBe("111");
  });

  it("after the restart, a tab still on the old version is told to reload — read sessions too; Reload is one unbroken button", async () => {
    let info: any = { admin: false, current: "2.3.5-beta.2" };
    answer = r => (r.url === "/ui/update" ? { body: info } : undefined);
    await mountShell();
    expect(line()).toBeNull();
    info = { admin: false, current: "2.3.5-beta.3" };
    await upd.refreshUpdate(); await settle(6);
    expect(line()?.textContent).toContain("AgEnD is updated to v2.3.5-beta.3");
    expect(line()?.textContent).toContain("Reload this tab to use the new version.");
    expect(!!button("Reload")).toBe(true);
    (p.root.querySelector(".update-x") as any).click(); await settle(4);
    expect(line()).toBeNull();
  });

  it("an older server (no /ui/update), a read session's offer-less answer, a server away mid-restart: nothing breaks", async () => {
    await mountShell();
    expect([line(), reqs.some(r => r.url === "/ui/update")]).toEqual([null, true]);
    answer = r => (r.url === "/ui/update" ? { body: { admin: false, current: "2.3.5-beta.2" } } : undefined);
    await upd.refreshUpdate(); await settle(4);
    expect(line()).toBeNull();
    answer = () => { throw new Error("offline"); };
    expect(await upd.refreshUpdate().catch(() => "threw")).toBeNull();
  });

  it("a guest's page never asks", async () => {
    p.document.body.setAttribute("data-tier", "guest");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : undefined);
    await mountShell();
    expect([line(), reqs.some(r => r.url === "/ui/update")]).toEqual([null, false]);
  });
});

describe("M-2738: /update in a chat (D3) and Settings → Advanced (D4)", () => {
  it("/update is the app's Update: recognised exactly, offered in the palette after the agent's commands", () => {
    expect([cmds.isUpdateLine("/update"), cmds.isUpdateLine("  /update "), cmds.isUpdateLine("/update now"), cmds.isUpdateLine("/updates")]).toEqual([true, true, false, false]);
    expect(cmds.parseCommandLine("/update")).toBeNull();                    // never POST /ui/command (the agent's)
    expect(cmds.UPDATE_COMMAND).toEqual({ name: "update", arg: "" });
  });

  it("openUpdateDialog: an admin's confirmation; anyone else is told only an admin can", async () => {
    answer = r => (r.url === "/ui/update" ? { body: { admin: false, current: "2.3.5-beta.2" } } : undefined);
    await mountShell();
    (globalThis as any).confirm = () => true; p.window.confirm = () => true;
    await upd.openUpdateDialog(); await settle(4);
    expect(posts()).toEqual([]);
    expect(p.document.body.textContent).toContain("Only a fleet admin can update AgEnD.");
  });

  it("the card: version, line, latest, last check; an alpha's newer stable is shown without Update", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : undefined);
    await p.mount(h(UpdateSection, {})); await settle(8);
    const card = () => p.root.querySelector(".s-update");
    expect(card()?.textContent).toContain("Version and update");
    expect(card()?.textContent).toContain("v2.3.5-beta.2");
    expect(card()?.textContent).toContain("v2.3.5-beta.3 is available");
    expect(!!button("Update now") && !!button("Check for updates")).toBe(true);
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ current: "2.4.0-alpha.9", offer: { version: "2.5.0", channel: "latest", installable: false } }) } : undefined);
    await upd.refreshUpdate(); await settle(6);
    expect(card()?.textContent).toContain("v2.5.0 (stable) is available");
    expect(card()?.textContent).toContain("switching to stable is not offered here");
    expect(button("Update now")).toBeUndefined();
    answer = r => (r.url === "/ui/update/check" ? { status: 429, body: { error: "checked_recently" } } : r.url === "/ui/update" ? { body: ADMIN() } : undefined);
    await press("Check for updates");
    expect(posts()).toContain("/ui/update/check");
  });
});
