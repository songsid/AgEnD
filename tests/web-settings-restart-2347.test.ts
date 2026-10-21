// #2347 restart flow: saved changes that wait for an AgEnD restart are one app-wide line, in every panel, until AgEnD
// restarts — Restart now (asked first, never automatic) or Later. Over the temporary public link it offers nothing; with
// no Settings job to carry the restart it says how to restart on the host; a guest's page never asks.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

type Req = { method: string; url: string; key: string | null; body: any };
type Answer = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
let reqs: Req[] = [];
let routes: Array<(r: Req) => Answer | undefined> = [];
const FLEET_ROW = (status: string) => ({ target: "fleet", kind: "restart", status });
const JOB = (status: string) => ({ id: "job9", status: "done", targets: [{ target: "alpha", kind: "hot", status: "done" }, FLEET_ROW(status)] });
const PENDING = { pending: true, keys: ["defaults.locale"], job_id: "job9" };
async function fetchFake(url: string, init: any = {}) {
  const headers = init.headers || {};
  const r: Req = { method: init.method || "GET", url, key: headers["Idempotency-Key"] ?? null, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  let a: Answer | undefined;
  for (const route of routes) { a = route(r); if (a) break; }
  const ans = await (a ?? (r.method === "GET" && url === "/api/settings/restart-pending" ? { body: { pending: false } } : { status: 404, body: {} }));
  const status = ans.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => ans.body, text: async () => JSON.stringify(ans.body) };
}
const posts = () => reqs.filter(r => r.method === "POST").map(r => r.url);

let p: AppPage;
let apply: any, app: any, nav: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  apply = await import("/ui/js/settings-apply.js");
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  nav.startRouter(p.window);
});
beforeEach(async () => {
  await p.unmount();
  apply.resetOperation();
  reqs = []; routes = [];
  app.appStore.set({ restartPending: null, restartRunner: (jobId: string) => apply.restartPendingChanges(jobId) });
  nav.navigate("/ui/fleet");
});
afterEach(() => { p.document.body.removeAttribute("data-public-link"); p.document.body.removeAttribute("data-tier"); });

const panels = () => new Map([["fleet", { load: async () => () => h("div", { class: "panel" }, "fleet") }], ["settings", { load: async () => () => h("div", { class: "panel" }, "settings") }]]);
const mountShell = async () => { await p.mount(h(shell.Shell, { panels: panels() })); await settle(8); };
const line = () => p.root.querySelector(".restart-line");
const button = (text: string) => (line()?.querySelectorAll("button") ?? []).find((b: any) => b.textContent === text);
/** Press `button` and answer the app's confirmation (the harness answers it with globalThis.confirm). */
const pressAndAnswer = async (label: string, yes: boolean) => {
  (globalThis as any).confirm = () => yes; p.window.confirm = () => yes;
  button(label).click();
  await settle(8);
};

describe("#2347: saved changes waiting for an AgEnD restart", () => {
  it("one line in any panel, with the keys; Restart now asks first, then restarts the server's job and follows it", async () => {
    let restarted = false;
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: restarted ? { pending: false } : PENDING } : undefined));
    routes.push(r => (r.url === "/api/settings/apply/job9" ? { body: JOB(restarted ? "done" : "restart-required") } : undefined));
    routes.push(r => (r.method === "POST" && r.url === "/api/settings/restart-fleet" ? (restarted = true, { status: 202, body: { job_id: "job9", restarting: true } }) : undefined));
    await mountShell();
    expect(line()?.textContent).toContain("1 saved change(s) take effect after AgEnD restarts");
    expect(line()?.textContent).toContain("defaults.locale");
    expect(line()?.className).toContain("lbar");                          // the shared straight bar, nothing rounded

    await pressAndAnswer("Restart now", false);
    expect(posts()).toEqual([]);                                          // Cancel restarts nothing
    await pressAndAnswer("Restart now", true);
    await vi.waitFor(() => expect(posts()).toEqual(["/api/settings/restart-fleet"]));
    const sent = reqs.find(r => r.url === "/api/settings/restart-fleet")!;
    expect([sent.body.job_id, sent.body.confirm, typeof sent.key]).toEqual(["job9", "restart-agend", "string"]);
    // The restart is followed like any Save's (the operation line elsewhere, its card in Settings) and, once it lands,
    // nothing is waiting any more.
    await vi.waitFor(() => expect(app.appStore.get().settingsOp?.phase).toBe("done"));
    await vi.waitFor(() => expect(line()).toBeNull());
    expect(app.appStore.get().restartPending).toBeNull();
  });

  it("Later hides it until something new is waiting; nothing restarts on its own", async () => {
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: PENDING } : undefined));
    await mountShell();
    button("Later").click(); await settle(4);
    expect(line()).toBeNull();
    app.appStore.set({ restartPending: { keys: ["defaults.locale", "web.port"], jobId: "job10" } }); await settle(4);
    expect(line()?.textContent).toContain("2 saved change(s)");
    expect([apply.AUTO_RESTART_AFTER_SAVE, posts()]).toEqual([false, []]);
  });

  it("a Save that needs a restart: its own card or line offers it (no second line), and no restart is made for it", async () => {
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: PENDING } : undefined));
    routes.push(r => (r.method === "PUT" && r.url === "/api/settings/fleet/defaults" ? { body: { ok: true } } : undefined));
    routes.push(r => (r.method === "POST" && r.url === "/api/settings/apply" ? { body: { ...JOB("restart-required"), status: "running" } } : undefined));
    routes.push(r => (r.url === "/api/settings/apply/job9" ? { body: JOB("restart-required") } : undefined));
    await mountShell();
    apply.startOperation([{ label: "Locale", impact: "fleet", request: { method: "PUT", url: "/api/settings/fleet/defaults", body: { locale: "zh-TW" } } }]);
    await vi.waitFor(() => expect(app.appStore.get().settingsOp?.phase).toBe("done"), { timeout: 5000 });
    await settle(6);
    expect([!!line(), p.root.querySelector(".op-line")?.textContent ?? ""]).toEqual([false, expect.stringContaining("needs a restart")]);
    expect(posts()).not.toContain("/api/settings/restart-fleet");             // never automatic
    apply.dismissOperation(); await settle(6);
    expect(!!button("Restart now")).toBe(true);                                // once its card is gone, the line keeps it
  });

  it("over the temporary public link it says a restart is waiting and offers none (FLEET_READ_ONLY_OVER_PUBLIC_LINK)", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: PENDING } : undefined));
    await mountShell();
    expect([app.FLEET_READ_ONLY_OVER_PUBLIC_LINK, !!line(), !!button("Restart now")]).toEqual([true, true, false]);
    expect(line()?.textContent).toContain("not over a temporary public link");
  });

  it("with no Settings job to carry it (a hand edit) it says how to restart on the host", async () => {
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: { ...PENDING, job_id: null } } : undefined));
    await mountShell();
    expect([!!button("Restart now"), line()?.textContent.includes("agend restart")]).toEqual([false, true]);
  });

  it("a refused restart says why and keeps the line", async () => {
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: PENDING } : undefined));
    routes.push(r => (r.url === "/api/settings/apply/job9" ? { body: JOB("restart-required") } : undefined));
    routes.push(r => (r.url === "/api/settings/restart-fleet" ? { status: 409, body: { error: "a configuration reload is running" } } : undefined));
    await mountShell();
    await pressAndAnswer("Restart now", true);
    await vi.waitFor(() => expect(p.root.querySelectorAll(".toast").map((x: any) => x.textContent).join("\n")).toContain("Restart refused: a configuration reload is running"));
    expect(!!button("Restart now")).toBe(true);
  });

  it("#2378 review: a refusal is asked about again — restarted elsewhere meanwhile, the line goes", async () => {
    let refused = false;
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: refused ? { pending: false } : PENDING } : undefined));
    routes.push(r => (r.url === "/api/settings/restart-fleet" ? (refused = true, { status: 409, body: { error: "no fleet-level change is pending any more" } }) : undefined));
    await mountShell();
    await pressAndAnswer("Restart now", true);
    await vi.waitFor(() => expect(line()).toBeNull());
    expect(app.appStore.get().restartPending).toBeNull();
  });
  it("#2378 review: Restart now while an operation is in hand does nothing (busy) and asks the server nothing", async () => {
    routes.push(r => (r.method === "PUT" && r.url === "/api/settings/fleet/defaults" ? new Promise<never>(() => {}) : undefined));
    apply.startOperation([{ label: "Locale", impact: "fleet", request: { method: "PUT", url: "/api/settings/fleet/defaults", body: { locale: "zh-TW" } } }]);
    await settle(4);
    const res = await apply.restartPendingChanges("job9");
    expect([res, posts()]).toEqual([{ ok: false, busy: true }, []]);
  });
  it("a guest's page never asks", async () => {
    p.document.body.setAttribute("data-tier", "guest");
    routes.push(r => (r.url === "/api/settings/restart-pending" ? { body: PENDING } : undefined));
    await mountShell();
    expect([!!line(), reqs.some(r => r.url === "/api/settings/restart-pending")]).toEqual([false, false]);
  });
});
