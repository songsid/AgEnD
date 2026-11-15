/**
 * M-3145 (docs/design/hub-fleet-versions.md §4.4; contract M-3144): a Fleet's Notices entry about an update the Hub's
 * administrator asked for (WebNotice kind "update" with hubUpdate) says, in the owner's words, what happened by state;
 * its actions (Update now / Cancel update / the full log) are offered by state and drawn only when the page gives them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let m: any, words: any, upd: any, toasts: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); m = await import("/ui/js/notice-hub-update.js"); words = await import("/assets/app-i18n.js"); upd = await import("/assets/app-update.js"); toasts = await import("/assets/ui-toast.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } (globalThis as any).fetch = realFetch; (globalThis as any).confirm = undefined; vi.restoreAllMocks(); });
const realFetch = (globalThis as any).fetch;

// The Fleet's routes, faked (M-3144 #3963): every request is recorded; `answer` says what the server says.
type Req = { method: string; url: string; key: string | null; body: any };
let reqs: Req[] = [];
function serve(answer: (r: Req) => { status?: number; body?: unknown } | undefined) {
  reqs = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const r: Req = { method: init.method || "GET", url, key: init.headers?.["Idempotency-Key"] ?? null, body: init.body ? JSON.parse(init.body) : null };
    reqs.push(r);
    const a = answer(r) ?? { status: 404, body: {} }, status = a.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => a.body };
  };
}
/** The newest toast, as the mounted toast list shows it. */
const lastToast = (p: AppPage) => { const l = [...p.root.querySelectorAll(".toast")] as any[]; return l.length ? l[l.length - 1].textContent : null; };
const RQ = "0b9f2a64-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const hu = (state: string, over: Record<string, unknown> = {}) => ({ requestId: RQ, hubName: "Team Hub", requestedBy: "Ada", version: "2.4.0", state, ...over });

describe("the owner's words, by state", () => {
  it("en and zh-TW, the Hub, who asked and the versions named", () => {
    words.setLang("en");
    expect(["waiting", "done", "rolled-back", "expired", "cancelled", "failed"].map((s) => m.hubUpdateNoticeText(hu(s, { currentVersion: "2.3.9" })))).toEqual([
      "Ada (Team Hub) asked to update this Fleet to AgEnD v2.4.0. It will start when your agents are idle.",
      "AgEnD is updated to v2.4.0, as Ada (Team Hub) asked.",
      "The update to v2.4.0 did not work. AgEnD is back on v2.3.9; nothing else changed.",
      "The update Ada (Team Hub) asked for did not start: your agents were busy for 24 hours. You can update from here when ready.",
      "Update cancelled. The result will be reported to Ada (Team Hub).",
      "The update to v2.4.0 that Ada (Team Hub) asked for did not finish."]);
    words.setLang("zh-TW");
    expect(m.hubUpdateNoticeText(hu("waiting"))).toBe("Ada（Team Hub）要求把這個 Fleet 更新到 AgEnD v2.4.0。會等你的 Agent 都閒置才開始。");
    expect(m.hubUpdateNoticeText(hu("unknown-state"))).toBeNull();
  });

  it("the actions a state offers", () => {
    expect(["waiting", "expired", "rolled-back", "done", "cancelled"].map((s) => m.hubUpdateNoticeActions(hu(s))))
      .toEqual([["updateNow", "cancelUpdate"], ["updateNow"], ["fullLog"], [], []]);
  });
});

describe("the notice's body", () => {
  it("with the page's actions: Update now / Cancel update, bound to the request; without them: the words alone; not ours: its text", async () => {
    const p = page({ storage: { agend_lang: "en" } }); pages.push(p); words.setLang("en");
    const updateNow = vi.fn(), cancelUpdate = vi.fn();
    await p.mount(h("div", {},
      h("div", { class: "a" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "plain", hubUpdate: hu("waiting") }, actions: { updateNow, cancelUpdate } })),
      h("div", { class: "b" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "plain", hubUpdate: hu("waiting") } })),
      h("div", { class: "c" }, h(m.HubUpdateNotice, { notice: { kind: "update", text: "AgEnD 2.4.1 is available." } }))));
    await settle(3);
    const buttons = [...p.root.querySelectorAll(".a button")] as any[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Update now", "Cancel update"]);
    fire(buttons[1], "click");
    expect(cancelUpdate.mock.calls[0][0].requestId).toBe(RQ);
    expect([p.root.querySelector(".b button"), p.root.querySelector(".c .notice-text").textContent]).toEqual([null, "AgEnD 2.4.1 is available."]);
  });
});

describe("the actions, on the Fleet's routes", () => {
  const ADMIN = { admin: true, current: "2.3.9", offer: null, progress: null };
  const VIEW = (state: string) => ({ id: RQ, version: "2.4.0", requestedAt: 1, expiresAt: 2, state });

  it("Update now rereads the request, asks naming its version, then starts it by id (no version sent)", async () => {
    const p = page(); pages.push(p); words.setLang("en");
    upd.updateStore.set({ info: ADMIN, starting: false });
    serve((r) => r.url === `/api/settings/hub/fleet-updates/${RQ}` ? { body: VIEW("waiting") } : r.url === "/ui/update/start" ? { status: 202, body: { started: true } } : r.url === "/ui/update" ? { body: ADMIN } : undefined);
    let asked = ""; (globalThis as any).confirm = (q: string) => { asked = q; return true; };
    expect((await m.hubUpdateActions().updateNow(hu("waiting"))).ok).toBe(true);
    expect(asked).toContain("This installs v2.4.0 (the version Ada (Team Hub) asked for), then restarts AgEnD.");
    const start = reqs.find((r) => r.url === "/ui/update/start")!;
    expect([reqs[0].url, start.method, start.body, typeof start.key]).toEqual([`/api/settings/hub/fleet-updates/${RQ}`, "POST", { confirm: "update-agend", hubRequestId: RQ }, "string"]);
  });

  it("Update now on a request that is no longer waiting (or expired): said, nothing started; said no: nothing started", async () => {
    const p = page(); pages.push(p); words.setLang("en");
    upd.updateStore.set({ info: ADMIN, starting: false }); await p.mount(h(toasts.Toasts, {}));
    serve((r) => r.url === `/api/settings/hub/fleet-updates/${RQ}` ? { body: VIEW("updating") } : undefined);
    (globalThis as any).confirm = () => true;
    expect((await m.hubUpdateActions().updateNow(hu("waiting"))).ok).toBe(false);
    await settle(3);
    expect([lastToast(p), reqs.some((r) => r.url === "/ui/update/start")]).toEqual(["This update request is no longer waiting.", false]);
    serve((r) => r.url === `/api/settings/hub/fleet-updates/${RQ}` ? { body: VIEW("expired") } : undefined);
    (globalThis as any).confirm = () => false;
    expect((await m.hubUpdateActions().updateNow(hu("expired"))).ok).toBe(false);
    expect(reqs.some((r) => r.url === "/ui/update/start")).toBe(false);
  });

  it("Cancel update posts {} to the request's cancel; already running (409 update_running) is said as such", async () => {
    const p = page(); pages.push(p); words.setLang("en");
    await p.mount(h(toasts.Toasts, {}));
    serve((r) => r.url === `/api/settings/hub/fleet-updates/${RQ}/cancel` ? { body: VIEW("cancelled") } : undefined);
    expect((await m.hubUpdateActions().cancelUpdate(hu("waiting"))).ok).toBe(true);
    await settle(3);
    expect([reqs[0].method, reqs[0].body, lastToast(p)]).toEqual(["POST", {}, "Update cancelled."]);
    serve(() => ({ status: 409, body: { error: "update_running" } }));
    expect((await m.cancelHubRequestedUpdate(RQ)).ok).toBe(false);
    await settle(3);
    expect(lastToast(p)).toBe("The update has already started and can't be cancelled.");
  });

  it("only an admin gets the buttons; a rolled-back notice's See the full log opens the update log", async () => {
    const p = page({ storage: { agend_lang: "en" } }); pages.push(p); words.setLang("en");
    serve((r) => r.url === "/ui/update/log" ? { body: { text: "npm ERR! nope", error: "" } } : undefined);
    const Probe = ({ state }: { state: string }) => h(m.HubUpdateNotice, { notice: { kind: "update", text: "plain", hubUpdate: hu(state, { currentVersion: "2.3.9" }) }, actions: m.useHubUpdateActions() });
    upd.updateStore.set({ info: { ...ADMIN, admin: false }, log: null });
    await p.mount(h("div", {}, h(Probe, { state: "rolled-back" }))); await settle(3);
    expect(p.root.querySelector("button")).toBeNull();
    upd.updateStore.set({ info: ADMIN }); await settle(3);
    const b = p.root.querySelector("button") as any;
    expect(b.textContent).toBe("See the full log");
    fire(b, "click"); await settle(5);
    expect(upd.updateStore.get().log).toEqual({ text: "npm ERR! nope", error: "" });
  });
});
