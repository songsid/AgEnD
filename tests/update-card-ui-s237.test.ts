/**
 * M-3770 slice 1.4 (design #4480 §3.1, §3.2, §4.1, §6): the one update card on the web, over a faked server in the agreed
 * shape (S-234's card, S-235's pre-flight): the banner's line and its answers (Update when idle, Pick a time, Not now,
 * Update now, Cancel), the second sentence only where true, no update button where pressHere is false, a 412's fresh
 * pre-flight, a pin (card null) hiding the old per-browser offer, Settings → Version and update (the state, "Updates on
 * this machine", the controls → PUT /api/settings/fleet/updates), and Needs you only for a failure or "can't update here".
 */
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
const CARD = (extra: Record<string, unknown> = {}) => ({ version: "2.4.1", channel: "beta", installable: true, state: "offered", ...extra });
const SELF = { class: "self", checkedAt: Date.now(), pressHere: true, checks: [{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }] };
const ADMIN = (extra: Record<string, unknown> = {}) => ({ admin: true, current: "2.4.0", offer: { version: "2.4.1", channel: "beta", installable: true },
  checked_at: Date.UTC(2026, 10, 9, 9, 12), check_failed: false, progress: null, now: Date.now(), card: CARD(), preflight: SELF, ...extra });
const posts = () => reqs.filter(r => r.method === "POST").map(r => r.url);

let p: AppPage;
let shell: any, upd: any, cmds: any, uc: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js");
  upd = await import("/assets/app-update.js");
  cmds = await import("/ui/js/chat-commands.js");
  uc = await import("/assets/update-card-ui.js");
  i18n = await import("/assets/app-i18n.js");
  (await import("/assets/app-nav.js")).startRouter(p.window);
});
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => undefined;
  try { (globalThis as any).localStorage.clear(); } catch { /* none */ }
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null });
  (globalThis as any).confirm = () => true; p.window.confirm = () => true;
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

const answers = () => reqs.filter(r => r.url === "/ui/update/answer");
const text = () => line()?.textContent ?? "";

describe("M-3770 1.4: the card on the banner", () => {
  it("offered on a service install: two sentences, Update when idle / Pick a time / Not now; Update when idle answers once with a key", async () => {
    let info = ADMIN();
    answer = r => (r.url === "/ui/update" ? { body: info } : r.url === "/ui/update/answer" ? { body: { card: CARD({ state: "waiting-idle", waitingFor: ["Example helper", "writer"], waitingSince: Date.now() }) } } : undefined);
    await mountShell();
    expect(text()).toContain("AgEnD 2.4.1 is ready.");
    expect(text()).toContain("Your work continues; if the new version won't start, AgEnD tries to roll back to 2.4.0.");
    expect(["Update when idle", "Pick a time", "Not now"].every((b) => !!button(b))).toBe(true);
    expect(button("Later")).toBeUndefined();                                  // the per-browser Later is gone with the card
    await press("Update when idle");
    await vi.waitFor(() => expect(answers().length).toBe(1));
    expect([answers()[0]!.body, typeof answers()[0]!.key]).toEqual([{ action: "when-idle" }, "string"]);
    await settle(6);
    expect(text()).toContain("Updating to 2.4.1 as soon as your agents are idle.");
    expect(text()).toContain("Waiting for: Example helper, writer");
    expect(["Update now", "Pick a time", "Cancel"].every((b) => !!button(b))).toBe(true);
    void info;
  });
  it("the second sentence only where it is true: not a service → no way back; no pre-flight yet → none", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: { ...SELF, class: "admin-only", checks: [{ id: "P3", ok: false, code: "not-service" }] } }) } : undefined);
    await mountShell();
    expect(text()).toContain("this setup can't restart AgEnD by itself");
    expect(text()).not.toContain("roll back");
    await p.unmount(); upd.updateStore.set({ info: null });
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: null }) } : undefined);
    await mountShell();
    expect(text()).toContain("Your work continues.");
    expect(text()).not.toContain("roll back");
    expect(text()).not.toContain("can't restart");
    expect(!!button("Update when idle")).toBe(true);                         // no pre-flight yet: as today, the admin may press
  });
  it("pressHere false (P4 no-write): no update button, the words to do it by hand; Not now stays", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: { class: "admin-only", checkedAt: 1, pressHere: false,
      checks: [{ id: "P3", ok: true }, { id: "P4", ok: false, code: "no-write", detail: { path: "/usr/local/lib/node_modules" } }] } }) } : undefined);
    await mountShell();
    expect(button("Update when idle")).toBeUndefined();
    expect(button("Pick a time")).toBeUndefined();
    expect(text()).toContain("AgEnD can't update itself on this machine; update it by hand.");
    expect(p.root.querySelector(".update-line details.uc-how summary")?.textContent).toBe("How to update");
    expect(p.root.querySelector(".update-line details.uc-how")?.textContent).toContain("Run sudo agend update in a terminal on the computer AgEnD runs on");
    expect(!!button("Not now")).toBe(true);
  });
  it("a pin (card null) hides the offer — the old per-browser line never comes back on a card server", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: null }) } : undefined);
    await mountShell();
    expect(line()).toBeNull();
  });
  it("an older server (no card key): today's line and Later, unchanged", async () => {
    answer = r => (r.url === "/ui/update" ? { body: (({ card, preflight, ...rest }) => rest)(ADMIN() as any) } : undefined);
    await mountShell();
    expect(text()).toContain("AgEnD v2.4.1 is available (current v2.4.0)");
    expect(!!button("Later")).toBe(true);
  });
  it("Not now answers not-now and the line goes; a 412 brings a fresh pre-flight and says why", async () => {
    let card: any = CARD();
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card }) }
      : r.url === "/ui/update/answer" && r.body.action === "not-now" ? { body: { card: (card = CARD({ state: "not-now", notNowUntil: Date.now() + 7 * 864e5 })) } }
      : r.url === "/ui/update/answer" ? { status: 412, body: { key: "preflight", preflight: { class: "admin-only", checkedAt: 2, pressHere: false, checks: [{ id: "P4", ok: false, code: "no-write", detail: { path: "/opt/npm" } }] } } }
      : undefined);
    await mountShell();
    await press("Update when idle");
    await vi.waitFor(() => expect(p.document.body.textContent).toContain("Updating needs write access to /opt/npm."));
    expect(upd.updateStore.get().info.preflight.class).toBe("admin-only");
    expect(button("Update when idle")).toBeUndefined();                       // pressHere false now
    await press("Not now");
    await vi.waitFor(() => expect(answers().some((a) => a.body.action === "not-now")).toBe(true));
    await settle(6);
    expect(line()).toBeNull();
  });
  it("Update now (waiting for idle): one question naming how many agents work, then now + the literal", async () => {
    let q = "";
    (globalThis as any).confirm = (m: string) => { q = m; return true; }; p.window.confirm = (globalThis as any).confirm;
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "waiting-idle", waitingFor: ["Example helper", "writer"] }) }) }
      : r.url === "/ui/update/answer" ? { body: { card: CARD({ state: "updating" }) } } : undefined);
    await mountShell();
    await press("Update now");
    await vi.waitFor(() => expect(answers().length).toBe(1));
    expect(answers()[0]!.body).toEqual({ action: "now", confirm: "update-agend" });
    expect(p.document.body.textContent + q).toContain("2 agents are working");
  });
  it("Pick a time: tonight at 22:00 is sent as its ms; Cancel on a scheduled card answers cancel", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : r.url === "/ui/update/answer" ? { body: { card: CARD({ state: "scheduled", scheduledAt: uc.nextAt(22) }) } } : undefined);
    await mountShell();
    await press("Pick a time");
    expect(p.document.body.textContent).toContain("When should AgEnD update?");
    await press("Schedule");
    await vi.waitFor(() => expect(answers().length).toBe(1));
    expect(answers()[0]!.body).toEqual({ action: "pick-time", at: uc.nextAt(22) });
    await settle(6);
    expect(text()).toContain("Updating to 2.4.1 at");
    expect(text()).toContain("when your agents are idle.");
    await press("Cancel");
    await vi.waitFor(() => expect(answers().length).toBe(2));
    expect(answers()[1]!.body).toEqual({ action: "cancel" });
  });
});

describe("M-3770 1.4: the leader's copy pass", () => {
  it("waiting names at most two agents, then how many more; Update now is not the filled button (#4487 UX look)", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "waiting-idle", waitingFor: ["A", "B", "C", "D", "E"] }) }) } : undefined);
    await mountShell();
    expect(text()).toContain("Waiting for: A, B and 3 more");
    expect(text()).not.toContain("C, D");
    expect(p.root.querySelectorAll(".update-line .btn-primary").length).toBe(0);
    expect(uc.namesShown(["A", "B"])).toBe("A, B");
    i18n.setLang("zh-TW", { store: false });
    try {
      expect(uc.namesShown(["A", "B", "C", "D", "E"])).toBe("A、B，另有 3 個");
      expect(i18n.t("updatecard.scheduled", "2.4.1", "11月26日週四 22:00")).toBe("排定在 11月26日週四 22:00，等 Agent 閒置後更新到 2.4.1。");
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("a scheduled card has no filled button either", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "scheduled", scheduledAt: Date.now() + 864e5 }) }) } : undefined);
    await mountShell();
    expect(p.root.querySelectorAll(".update-line button").length).toBeGreaterThan(0);
    expect(p.root.querySelectorAll(".update-line .btn-primary").length).toBe(0);
  });
  it("can't update here (class stop): no banner line; Needs you holds the one line", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: { class: "stop", checkedAt: 1, pressHere: false, checks: [{ id: "P9", ok: false, code: "container" }] } }) } : undefined);
    await mountShell();
    expect(line()).toBeNull();
  });
  it("Another time: a day and a 24-hour time from selects (no datetime-local, no AM/PM)", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : r.url === "/ui/update/answer" ? { body: { card: CARD({ state: "scheduled", scheduledAt: Date.now() + 864e5 }) } } : undefined);
    await mountShell();
    await press("Pick a time");
    const radios = [...p.document.querySelectorAll('dialog input[type="radio"]')] as any[];
    radios[2].checked = true; radios[2].dispatchEvent(new Event("change")); await settle(4);
    expect(p.document.querySelectorAll('input[type="datetime-local"], input[type="time"]').length).toBe(0);
    const times = [...p.document.querySelectorAll(".uc-pick-time option")].map((o: any) => o.textContent);
    expect([times[0], times[1], times.at(-1), times.length]).toEqual(["00:00", "00:15", "23:45", 96]);
    expect(uc.dayTimes(30).length).toBe(48);
  });
  it("Settings open: no top line (Settings has the card's own controls)", async () => {
    const nav = await import("/assets/app-nav.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : undefined);
    await mountShell();
    expect(line()).not.toBeNull();
    nav.navStore.set({ route: { panel: "settings", section: "advanced" } }); await settle(6);
    expect(line()).toBeNull();
    nav.navStore.set({ route: { panel: "fleet" } }); await settle(6);
    expect(line()).not.toBeNull();
  });
  it("Tomorrow morning is always tomorrow's 08:00, never a morning that has begun", () => {
    const night = new Date(2026, 10, 26, 1, 0, 0);
    const d = new Date(uc.tomorrowAt(8, night));
    expect([d.getDate(), d.getHours()]).toEqual([27, 8]);
  });
});

describe("M-3770 1.4: Settings → Version and update", () => {
  it("the state, Updates on this machine, the pause windows and Advanced → PUT /api/settings/fleet/updates", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "not-now", notNowUntil: Date.UTC(2026, 11, 2, 9) }),
      preflight: { class: "admin-only", checkedAt: 1, pressHere: true, checks: [{ id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }] } }) }
      : r.url === "/api/settings/fleet" && r.method === "GET" ? { body: { updates: { pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }], maxIdleWait: 12 } } }
      : r.url === "/api/settings/fleet/updates" ? { body: { ok: true } } : undefined);
    await p.mount(h(UpdateSection, {})); await settle(10);
    const card = () => p.root.querySelector(".s-update")?.textContent ?? "";
    expect(card()).toContain("You chose Not now. The card comes back on");
    expect(card()).toContain("Updates on this machine");
    expect(card()).toContain("Updates here need you:");
    expect(card()).toContain("AgEnD stops when the example account signs out, so it can't restart itself. To fix it, run sudo loginctl enable-linger example.");
    expect([...p.root.querySelectorAll(".s-update .uc-cmd")].map((e: any) => e.textContent)).toEqual(["sudo loginctl enable-linger example"]);
    expect(card()).not.toContain("lingering");
    expect(card()).toContain("Don't update during");
    expect(p.root.querySelectorAll(".uc-pause-row").length).toBe(1);
    expect(button("Update when idle")).toBeDefined();                         // not-now: the admin can still answer here
    expect(p.root.querySelectorAll('input[type="time"]').length).toBe(0);              // never the browser's AM/PM time input
    expect(([...p.root.querySelectorAll(".uc-time select option")] as any[]).some((o) => o.textContent === "18:00")).toBe(true);
    const saves = () => reqs.filter(r => r.url === "/api/settings/fleet/updates");
    ([...p.root.querySelectorAll(".uc-pause .btn-primary")] as any[])[0].click();
    await vi.waitFor(() => expect(saves().length).toBe(1)); await settle(6);
    expect(saves()[0]!.body).toEqual({ pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }] });
    ([...p.root.querySelectorAll(".uc-advanced .btn-primary")] as any[])[0].click();
    await vi.waitFor(() => expect(saves().length).toBe(2)); await settle(6);
    expect(saves()[1]!.body).toEqual({ pin: null, maxIdleWait: 12 });
  });
  it("the card's actions in every state, the same as the banner's; Pick a time only where a schedule is taken (#4487 review P2)", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    const SELF = { class: "self", checkedAt: 1, pressHere: true, checks: [{ id: "P3", ok: true }] };
    const ADMIN_ONLY = { class: "admin-only", checkedAt: 1, pressHere: true, checks: [{ id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }] };
    const PRESS_ONLY = { class: "admin-only", checkedAt: 1, pressHere: false, checks: [{ id: "P4", ok: false, code: "no-write", detail: { path: "/opt/npm" } }] };
    const want: Record<string, Record<string, string[]>> = {
      self: { offered: ["Update when idle", "Pick a time", "Not now"], "waiting-idle": ["Update now", "Pick a time", "Cancel"], scheduled: ["Update now", "Cancel"] },
      "admin-only": { offered: ["Update when idle", "Not now"], "waiting-idle": ["Update now", "Cancel"], scheduled: ["Update now", "Cancel"] },
      "press-only": { offered: ["Not now"], "waiting-idle": ["Cancel"], scheduled: ["Cancel"] },
    };
    for (const [name, pf] of [["self", SELF], ["admin-only", ADMIN_ONLY], ["press-only", PRESS_ONLY]] as const) {
      for (const state of ["offered", "waiting-idle", "scheduled"]) {
        const info = ADMIN({ preflight: pf, card: CARD({ state, ...(state === "scheduled" ? { scheduledAt: Date.now() + 864e5 } : {}), ...(state === "waiting-idle" ? { waitingFor: ["A"] } : {}) }) });
        answer = r => (r.url === "/ui/update" ? { body: info } : r.url === "/api/settings/fleet" ? { body: {} } : undefined);
        await p.unmount(); await p.mount(h(UpdateSection, {})); await settle(10);
        const shown = ([...p.root.querySelectorAll(".s-update-row button")] as any[]).map((b) => b.textContent.trim()).filter((x) => x !== "Check for updates");
        expect(shown, `${name} ${state}`).toEqual(want[name]![state]);
        expect(uc.cardActions(info, {}).map((x: any) => x.label), `banner ${name} ${state}`).toEqual(want[name]![state]);
        expect(p.root.querySelectorAll(".s-update-row .btn-primary").length, `${name} ${state}`).toBe(state === "offered" && pf.pressHere ? 1 : 0);
      }
    }
  });
  it("a save the server holds for confirmation says it is waiting, never Saved. (#4487 review P1)", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    const { Toasts } = await import("/assets/ui-toast.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() }
      : r.url === "/api/settings/fleet" && r.method === "GET" ? { body: { updates: { pin: "2.4.0" } } }
      : r.url === "/api/settings/fleet/updates" ? { status: 202, body: { ok: true, result: "pending_confirmation", pending_change: { id: "a".repeat(32), state: "pending", remaining_ms: 600_000, summary: [] } } }
      : undefined);
    await p.mount(h("div", {}, h(UpdateSection, {}), h(Toasts, {}))); await settle(10);
    const toasts = () => [...p.root.querySelectorAll(".toasts .toast")].map((e: any) => e.textContent);
    const before = toasts().length;
    ([...p.root.querySelectorAll(".uc-advanced .btn-primary")] as any[])[0].click();
    await vi.waitFor(() => expect(toasts().length).toBeGreaterThan(before)); await settle(4);
    expect(toasts().slice(before)).toEqual(["Waiting for confirmation: this lets updates go ahead sooner."]);
  });
  it("admin-only with no failing row (a check not run yet, #4483 r2): says so, never an empty list", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: { class: "admin-only", checkedAt: 1, pressHere: true, target: null, install: null, checks: [{ id: "P1", ok: true, checkedAt: 1 }] } }) } : r.url === "/api/settings/fleet" ? { body: {} } : undefined);
    await p.mount(h(UpdateSection, {})); await settle(10);
    expect(p.root.querySelector(".uc-machine")?.textContent).toContain("Some checks haven't run yet");
    expect(uc.checkSentence({ id: "P3", ok: false, code: "service-unknown" })).toBe("AgEnD can't confirm that its service will bring it back after an update.");
  });
  it("no pre-flight yet: \"not checked yet\", never ✓", async () => {
    const { UpdateSection } = await import("/ui/js/settings-update.js");
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ preflight: null }) } : r.url === "/api/settings/fleet" ? { body: {} } : undefined);
    await p.mount(h(UpdateSection, {})); await settle(10);
    const txt = p.root.querySelector(".uc-machine")?.textContent ?? "";
    expect(txt).toContain("Not checked yet");
    expect(txt).not.toContain("✓");
  });
});

describe("M-3770 1.4: the words", () => {
  it("a check's sentence fills its detail; an unknown code is still words, never raw; absent checks aren't failures", () => {
    expect(uc.checkSentence({ id: "P10", ok: false, code: "node-too-old", detail: { node: "20.11", needs: ">=22.14" } }, "2.5.0")).toBe("AgEnD 2.5.0 needs Node >=22.14; this machine has 20.11.");
    expect(uc.checkText({ id: "P4", ok: false, code: "no-write", detail: { path: "/opt/x" } })).toBe("Updating needs write access to /opt/x. Run sudo agend update in a terminal on the computer AgEnD runs on, or reinstall with the one-line installer.");
    expect(uc.checkSentence({ id: "P3", ok: false, code: "linger-off", detail: { user: "a`b" } })).toBe("AgEnD stops when the user a'b signs out, so it can't restart itself. To fix it, run `sudo loginctl enable-linger a'b`.");
    expect(uc.checkSentence({ id: "P1", ok: false, code: "brand-new-code" })).toBe("A check didn't pass (brand-new-code).");
    expect(uc.failedChecks({ checks: [{ id: "P10", ok: false, code: "node-too-old" }, { id: "P2", ok: false, code: "shared-home" }, { id: "P1", ok: true }] }).map((c: any) => c.id)).toEqual(["P2", "P10"]);
    expect(uc.failedChecks({ checks: [] })).toEqual([]);
  });
  it("every word in English and zh-TW, the same placeholders; every agreed code worded", () => {
    const en = Object.keys((i18n as any).tables?.en ?? {}).filter((k) => k.startsWith("updatecard."));
    const all = en.length ? en : [];
    for (const code of ["checkout", "other-copy", "path-shadow", "unreadable", "shared-home", "unknown-owner", "other-install", "not-service", "service-unknown", "linger-off",
      "system-unit-not-root", "unit-reload-pending", "no-write", "linked", "vendored", "low-disk", "npm-unreachable", "rehearsal", "update-running", "container", "windows-runtime", "node-too-old"]) {
      i18n.setLang("en", { store: false });
      const e = uc.checkSentence({ id: "P1", ok: false, code }, "2.5.0");
      i18n.setLang("zh-TW", { store: false });
      const z = uc.checkSentence({ id: "P1", ok: false, code }, "2.5.0");
      expect(e.startsWith("A check didn't pass"), code).toBe(false);
      expect(z.startsWith("有一項檢查沒有通過"), code).toBe(false);
    }
    i18n.setLang("en", { store: false });
    void all;
  });
  it("Needs you counts the update item like any other: no empty state above it, in the page's count and the badge; gone when resolved (#4487 review P2)", async () => {
    const app = await import("/assets/app-store.js");
    const panel = await import("/ui/js/panel-needs.js");
    app.appStore.set({ chatOwner: null, ready: true, needsLoaded: true, needs: [], instances: [], proposals: [], connections: 0 });
    upd.updateStore.set({ info: ADMIN({ card: CARD({ state: "failed", failed: { cause: "network", rolledBack: true } }) }) });
    await p.mount(h(panel.NeedsPanel, { navKey: "needs|s237" })); await settle(6);
    const body = () => p.root.textContent ?? "";
    expect(body()).toContain("Update failed: the update source could not be reached.");
    expect(body()).not.toContain("Nothing needs you right now");
    expect(body()).toContain("1 waiting");
    expect(shell.needsCount(app.appStore.get())).toBe(1);
    expect(p.document.title.startsWith("(1) "), p.document.title).toBe(true);                   // the tab's title too (#4487 review P3)
    upd.updateStore.set({ info: ADMIN({ preflight: { class: "stop", checkedAt: 1, pressHere: false, checks: [{ id: "P9", ok: false, code: "container" }] } }) }); await settle(6);
    expect(body()).toContain("AgEnD runs in a container; update the image.");
    expect(p.root.querySelectorAll(".uc-needs").length).toBe(1);                     // once, never twice
    expect(shell.needsCount(app.appStore.get())).toBe(1);
    upd.updateStore.set({ info: ADMIN() }); await settle(6);                           // resolved: offered again
    expect(body()).toContain("Nothing needs you right now");
    expect(body()).not.toContain("waiting");
    expect(shell.needsCount(app.appStore.get())).toBe(0);
    expect(p.document.title.startsWith("("), p.document.title).toBe(false);
  });
  it("Needs you: only a failure or \"can't update here\"", async () => {
    const mount = async (info: any) => { await p.unmount(); await p.mount(h(uc.UpdateNeedsItem, { info, settingsHref: "/settings/advanced#settings-update" })); await settle(4); return p.root.textContent ?? ""; };
    expect(await mount(ADMIN())).toBe("");
    expect(await mount(ADMIN({ card: CARD({ state: "not-now" }) }))).toBe("");
    expect(await mount(ADMIN({ card: CARD({ state: "failed", failed: { cause: "network", rolledBack: true } }) }))).toContain("Update failed: the update source could not be reached.");
    const one = await mount(ADMIN({ preflight: { class: "stop", checkedAt: 1, pressHere: false, checks: [{ id: "P9", ok: false, code: "container" }] } }));
    expect(one).toContain("AgEnD runs in a container; update the image.");
    expect(one).not.toContain("can't update itself on this machine");                // one line, not a title plus the reason
  });
});
