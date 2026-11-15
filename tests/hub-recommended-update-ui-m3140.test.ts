// M-3140 (hub-fleet-versions.md §3.3, web): the Hub's recommended version on the update line — who is asking, Update now
// pinned to it (the start names the advice it was shown), Later for a day — one banner at a time (the Hub's line only when its
// version is the higher need), and Settings → Advanced's "Recommended by {Hub}" row. The server is faked (GET /ui/update).
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
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null, laterHub: null });
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

const REC = { hubId: "hub-1", hubName: "hub.example", version: "2.4.0-beta.4", revision: 3, setAt: 1, receivedAt: 2 };
const i18n = await import("/assets/app-i18n.js");
afterEach(() => { i18n.setLang("en", { store: false }); vi.restoreAllMocks(); });

describe("M-3140: the Hub's recommended version on the update line", () => {
  it("names the Hub and both versions; Update now confirms and starts pinned to the advice it showed", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: null, hubRecommendation: REC }) } : r.url === "/ui/update/start" ? { status: 202, body: { started: true } } : undefined);
    await mountShell();
    expect(line()?.textContent).toContain("hub.example recommends AgEnD v2.4.0-beta.4 (current v2.3.5-beta.2)");
    expect(line()?.textContent).toContain("Some Hub features need it. Only admins see this.");
    await press("Update now", false); expect(posts()).toEqual([]);
    await press("Update now", true);
    await vi.waitFor(() => expect(posts()).toEqual(["/ui/update/start"]));
    const start = reqs.find(r => r.url === "/ui/update/start")!;
    expect(start.body).toEqual({ confirm: "update-agend", recommended: { version: "2.4.0-beta.4", revision: 3 } });
    expect(start.key).toMatch(/^update-/);
  });
  it("zh-TW words; a changed recommendation is said in words, not as a code", async () => {
    i18n.setLang("zh-TW", { store: false });
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: null, hubRecommendation: REC }) } : r.url === "/ui/update/start" ? { status: 409, body: { error: "recommendation_changed" } } : undefined);
    await mountShell();
    expect(line()?.textContent).toContain("hub.example 建議更新到 AgEnD v2.4.0-beta.4（目前 v2.3.5-beta.2）");
    expect(line()?.textContent).toContain("部分 Hub 功能需要這個版本。只有管理員看得到。");
    await press("立即更新", true);
    await vi.waitFor(() => expect(p.root.textContent).toContain("Hub 建議的版本已變更"));
    expect(p.root.textContent).not.toContain("recommendation_changed");
  });
  it("one banner: the install's own update when it reaches the advised version, the Hub's when its version is higher", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: { version: "2.4.0-beta.5", channel: "beta", installable: true }, hubRecommendation: REC }) } : undefined);
    await mountShell();
    expect(line()?.textContent).toContain("AgEnD v2.4.0-beta.5 is available"); expect(line()?.textContent).not.toContain("recommends");
    expect(p.root.querySelectorAll(".update-line").length).toBe(1);
    await p.unmount(); upd.updateStore.set({ info: null });
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ hubRecommendation: REC }) } : undefined);   // offer beta.3 < advised beta.4
    await mountShell();
    expect(line()?.textContent).toContain("hub.example recommends AgEnD v2.4.0-beta.4");
    expect(p.root.querySelectorAll(".update-line").length).toBe(1);
  });
  it("advice not newer than what runs shows nothing; a read session never sees it", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: null, hubRecommendation: { ...REC, version: "2.3.5-beta.2" } }) } : undefined);
    await mountShell(); expect(line()).toBeNull();
    await p.unmount(); upd.updateStore.set({ info: null });
    answer = r => (r.url === "/ui/update" ? { body: { admin: false, current: "2.3.5-beta.2", hubRecommendation: REC } } : undefined);
    await mountShell(); expect(line()).toBeNull();
  });
  it("Later hides it for a day; a new revision shows at once", async () => {
    let rec = REC;
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: null, hubRecommendation: rec }) } : undefined);
    await mountShell();
    await press("Later"); expect(line()).toBeNull();
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 23 * 3600_000); upd.updateStore.set({ info: { ...upd.updateStore.get().info } }); await settle(5); expect(line()).toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 25 * 3600_000); upd.updateStore.set({ info: { ...upd.updateStore.get().info } }); await settle(5); expect(line()?.textContent).toContain("recommends");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 3600_000); upd.updateStore.set({ info: { ...upd.updateStore.get().info } }); await settle(5); expect(line()).toBeNull();
    rec = { ...REC, revision: 4 }; upd.updateStore.set({ info: ADMIN({ offer: null, hubRecommendation: rec }) }); await settle(5);
    expect(line()?.textContent).toContain("recommends");
  });
});

describe("M-3140: Settings → Advanced → Version and update", () => {
  it("a row 'Recommended by {Hub}: v…', and Update now there is the pinned one", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ offer: null, hubRecommendation: REC }) } : r.url === "/ui/update/start" ? { status: 202, body: { started: true } } : undefined);
    (globalThis as any).confirm = () => true; p.window.confirm = () => true;
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    await p.mount(h(UpdateSection, {})); await settle(8);
    const dts = [...p.root.querySelectorAll(".s-update dt")].map((x: any) => x.textContent), dds = [...p.root.querySelectorAll(".s-update dd")].map((x: any) => x.textContent);
    expect(dts).toContain("Recommended by hub.example"); expect(dds[dts.indexOf("Recommended by hub.example")]).toBe("v2.4.0-beta.4");
    button("Update now").click(); await settle(10);
    await vi.waitFor(() => expect(reqs.find(r => r.url === "/ui/update/start")?.body).toEqual({ confirm: "update-agend", recommended: { version: "2.4.0-beta.4", revision: 3 } }));
  });
});

describe("M-3140: the version rule the page uses", () => {
  it("semver order: core, release over its prereleases, numeric identifiers by value", () => {
    expect(upd.newerVersion("2.4.0-beta.4", "2.3.5-beta.2")).toBe(true);
    expect(upd.newerVersion("2.4.0", "2.4.0-beta.9")).toBe(true);
    expect(upd.newerVersion("2.4.0-beta.10", "2.4.0-beta.9")).toBe(true);
    expect(upd.newerVersion("2.4.0-beta.4", "2.4.0-beta.4")).toBe(false);
    expect(upd.newerVersion("2.4.0-alpha.9", "2.4.0-beta.1")).toBe(false);
    expect(upd.newerVersion("bogus", "1.0.0")).toBe(false);
  });
});
