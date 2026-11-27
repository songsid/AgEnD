/**
 * M-3770 slice 1.6 (design #4480 §4.1, P3): Settings → Version and update → "Updates on this machine", over a faked
 * server: lingering off has a fix button (POST /ui/update/fixes with a key; the answer's pre-flight replaces the page's,
 * so the line goes once the check passes; a fix that doesn't take says so and keeps the command); a fleet that isn't a
 * service has a "How to fix" fold with `agend install` as code (and S-246's Install as a service); no other check offers one.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const pf = (cls: string, checks: unknown[]) => ({ class: cls, checkedAt: 1, pressHere: true, checks });
const LINGER_OFF = pf("admin-only", [{ id: "P1", ok: true }, { id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }]);
const FIXED = pf("self", [{ id: "P1", ok: true }, { id: "P3", ok: true }]);
const ADMIN = (preflight: unknown) => ({ admin: true, current: "2.4.0", offer: { version: "2.4.1", channel: "beta", installable: true }, checked_at: 1, check_failed: false,
  progress: null, now: Date.now(), card: { version: "2.4.1", channel: "beta", installable: true, state: "offered" }, preflight });

let p: AppPage, upd: any, uc: any, Toasts: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/ui/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  upd = await import("/assets/app-update.js");
  uc = await import("/assets/update-card-ui.js");
  Toasts = (await import("/assets/ui-toast.js")).Toasts;
});
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => undefined;
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null });
});
const machine = () => p.root.querySelector(".uc-machine");
const fixButton = () => ([...(machine()?.querySelectorAll("button") ?? [])] as any[]).find((b) => b.textContent === "Keep AgEnD running after sign-out");
const mount = async (preflight: unknown, fix?: (r: Req) => { status?: number; body?: unknown }) => {
  answer = r => (r.url === "/ui/update" ? { body: ADMIN(preflight) } : r.url === "/api/settings/fleet" ? { body: {} } : r.url === "/ui/update/fixes" && fix ? fix(r) : undefined);
  const { UpdateSection } = await import("/ui/js/settings-update.js");
  await p.mount(h("div", {}, h(UpdateSection, {}), h(Toasts, {}))); await settle(10);
};
const fixes = () => reqs.filter(r => r.url === "/ui/update/fixes");
// [text, ok, shown in full (toast-detail: a phone's toast is otherwise one cut line)]
const shown = () => [...p.root.querySelectorAll(".toasts .toast")].map((e: any) => [e.textContent, e.classList.contains("ok"), e.classList.contains("toast-detail")]);

describe("M-3770 1.6: the fix buttons", () => {
  it("lingering off: Keep AgEnD running after sign-out → one POST with a key; the fresh pre-flight replaces the page's and the line goes", async () => {
    await mount(LINGER_OFF, () => ({ body: { preflight: FIXED } }));
    expect(machine()?.textContent).toContain("AgEnD stops when the example account signs out");
    expect(fixButton()).toBeDefined();
    // The button's line says what it does (#4557 UX look): no restart, the agents keep working, else run it yourself.
    expect(machine()!.querySelector(".uc-fix .uc-fix-hint")?.textContent).toBe("AgEnD turns it on for you; nothing restarts and your agents keep working. If this computer doesn't allow it, run the command yourself.");
    const before = shown().length;
    fixButton().click();
    await vi.waitFor(() => expect(fixes().length).toBe(1)); await settle(10);
    expect(fixes()[0]).toMatchObject({ method: "POST", body: { fix: "linger" } });
    expect(fixes()[0]!.key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(upd.updateStore.get().info.preflight).toEqual(FIXED);
    expect(machine()?.textContent).toContain("AgEnD can update itself here.");
    expect(machine()?.textContent).not.toContain("signs out,");
    expect(fixButton()).toBeUndefined();
    expect(shown().slice(before)).toEqual([["Done: AgEnD keeps running after the example account signs out.", true, true]]);
  });

  it("a fix that doesn't take: the block says so in place of the button (no toast), keeps the line and its command; already fixed: says so", async () => {
    await mount(LINGER_OFF, () => ({ status: 422, body: { error: "fix_failed", preflight: LINGER_OFF } }));
    const before = shown().length;
    fixButton().click();
    await vi.waitFor(() => expect(fixes().length).toBe(1)); await settle(10);
    expect(shown().slice(before)).toEqual([]);
    expect(machine()!.querySelector(".uc-fix-refused")?.textContent).toBe("AgEnD couldn't turn it on by itself. Run the command above in a terminal on the computer AgEnD runs on.");
    expect([...machine()!.querySelectorAll(".uc-cmd")].map((e: any) => e.textContent)).toEqual(["sudo loginctl enable-linger example"]);
    expect(fixButton()).toBeUndefined();
    expect(machine()!.querySelector(".uc-fix-hint")).toBeNull();
    await p.unmount(); reqs = [];
    await mount(LINGER_OFF, () => ({ status: 409, body: { error: "not_needed", preflight: FIXED } }));
    const before2 = shown().length;
    fixButton().click();
    await vi.waitFor(() => expect(fixes().length).toBe(1)); await settle(10);
    expect(shown().slice(before2)).toEqual([["That's already fixed.", true, false]]);
    expect(fixButton()).toBeUndefined();
  });

  it("not a service: How to fix folds out `agend install` as code (S-246 adds its button); no other check offers a fix", async () => {
    await mount(pf("admin-only", [{ id: "P3", ok: false, code: "not-service" }, { id: "P5", ok: false, code: "linked", detail: { path: "/src/agend" } }]));
    expect(fixButton()).toBeUndefined();
    expect([...machine()!.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Install as a service"]);
    const how = machine()!.querySelector("details.uc-how") as any;
    expect(how?.querySelector("summary")?.textContent).toBe("How to fix");
    expect([...how.querySelectorAll(".uc-cmd")].map((e: any) => e.textContent)).toEqual(["agend install"]);
    expect(how.textContent).toContain("In a terminal on the computer AgEnD runs on, run agend install as the same user (no sudo). AgEnD restarts as a service: every agent stops briefly and comes back on its own.");
    expect(machine()!.querySelectorAll("details.uc-how").length).toBe(1);
    expect(uc.fixFor({ id: "P3", ok: false, code: "linger-off" })).toBe("linger");
    expect(uc.fixFor({ id: "P3", ok: false, code: "not-service" })).toBe("service");
  });

  it("the words in English and zh-TW, the same placeholders", async () => {
    const i18n = await import("/assets/app-i18n.js");
    const keys = ["fixIt", "fixing", "fixedLinger", "fixHint", "fixFailed", "fixNotNeeded", "howToFix", "serviceHow"];
    const words: Record<string, Record<string, string>> = {};
    for (const lang of ["en", "zh-TW"]) words[lang] = Object.fromEntries(keys.map(k => [k, i18n.tIn(lang, `updatecard.${k}`)]));
    for (const k of keys) {
      expect(words.en![k], k).not.toBe(`updatecard.${k}`);
      expect(words["zh-TW"]![k], k).not.toBe(words.en![k]);
      expect((words["zh-TW"]![k]!.match(/`[^`]+`|\{\d\}/g) ?? []), k).toEqual(words.en![k]!.match(/`[^`]+`|\{\d\}/g) ?? []);
    }
    expect(words["zh-TW"]!.serviceHow).toContain("Agent");
  });
});
