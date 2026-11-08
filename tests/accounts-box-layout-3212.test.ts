/**
 * #3212 + #3321: Settings → Accounts, box layout (src/ui/accounts-view.js, accounts-keepalive.js and their stylesheets, over a faked GET /ui/accounts).
 * Each account is a box with three layers: the title bar (name, state, default tag · compact buttons without a trailing "…"), the meta bar
 * (masked email · plan, "used by" pill), the usage block (the short "5h" window and the week) and Keep sign-in alive as the box's foot.
 * #3321 (the upstream UI rules, songsid/AgEnD#3321: shared components, theme variables, no one-off styles): the windows are the Usage panel's own
 * `CompactMeter`, "used by N agents ▾" is the shared `Menu` (one item per agent, choosing it opens that agent's settings), the foot's explanations are
 * `InfoTip` (hover, focus or a tap), the CLI's block is a `.card`, and the stylesheets hold no colour of their own — only the theme's variables (tokens.css),
 * layers floating over the box (position: absolute), the box overflow visible, and no inline style (CSP style-src 'self'). Fixtures only (example.com).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const DAY = 86_400_000;
const none = { agents: [], classic: [], fleetDefault: false };
const VIEW = () => ({ clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: "work", agents: [{ name: "architect", profile: "work" }, { name: "code-reviewer", profile: "work" }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, identity: { maskedEmail: "ju***@example.com", plan: "max" }, usedBy: none, usage: { percent: 18, windowMs: 604800000 } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "te***@company.example", plan: "team" },
        usedBy: { agents: ["architect", "code-reviewer"], classic: [], fleetDefault: true }, usage: { percent: 42, windowMs: 604800000 },
        keepAlive: { enabled: true, fallback: false, endsAt: new Date(Date.now() + 30 * DAY).toISOString() } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "usable", signIn: true, usedBy: { agents: ["scout"], classic: [], fleetDefault: false }, keepAlive: { enabled: false, fallback: false } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "spare", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: ["room1"], fleetDefault: false } },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "win-team", state: "usable", signIn: true, usedBy: { agents: ["win-agent"], classic: [], fleetDefault: false } },
    ] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [],
    rows: [{ scope: { kind: "host" }, backend: "codex", profile: null, state: "usable", signIn: true, usedBy: none, keepAlive: { enabled: true, planType: "free" } }] },
] });
let view: any;
const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? view : { login: null, targets: [] }) });
let p: AppPage, A: any, S: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19283/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW();
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
const opened: string[] = [];
async function mount() {
  opened.length = 0;
  await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {}, openAgent: (n: string) => opened.push(n) }));
  await settle(8);
}
const card = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"]`);
const rowOf = (backend: string, acct: string) => card(backend).querySelectorAll(".s-account-row").find((r: any) => r.getAttribute("data-account") === acct);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const pill = (backend: string, acct: string) => rowOf(backend, acct).querySelector(".s-account-used");
const wins = (backend: string, acct: string) => rowOf(backend, acct).querySelectorAll(".u-cm");
/** A meter's words: its name, its percent and its reset as drawn ("↻ 3h"; the full "(resets in 3h 1m)" after it is for a screen reader only). */
const meterText = (w: any) => [text(w.querySelector(".u-cm-tag")), text(w.querySelector(".u-cm-pct")), text(w.querySelector(".u-cm-reset")).replace(/ \(.*\)$/, "")];

describe("the account box: three layers (#3212)", () => {
  it("title bar: name, state and the default tag on the left, the buttons on the right; meta bar: who, used by; usage: the week", async () => {
    await mount();
    const work = rowOf("claude-code", "work");
    const bar = work.querySelector(".s-account-title-bar"), meta = work.querySelector(".s-account-meta-bar");
    expect([text(bar.querySelector(".s-account-title-left strong")), text(bar.querySelector(".s-account-title-left .s-auth-state")), text(bar.querySelector(".s-account-title-left .s-account-default-tag"))])
      .toEqual(["Account “work”", "signed in", "fleet default"]);
    expect(bar.querySelector(".s-actions")).toBeTruthy();                                    // the buttons are in the title bar
    expect([text(meta.querySelector(".s-account-identity")), text(meta.querySelector(".s-account-used"))]).toEqual(["te***@company.example · Team", "used by 2 agents"]);
    expect(meta.querySelector(".s-account-usage")).toBeNull();                                 // the usage has a block of its own, below the meta bar
    expect(wins("claude-code", "work").map((w: any) => meterText(w))).toEqual([["7d", "42%", ""]]);        // no reset time in the fixture: that cell is empty
    expect(work.querySelector(".s-account-usage .u-cm .u-cm-fill")).toBeTruthy();              // the Usage panel's meter, not a second one
  });

  it("the shared pieces are used as they are: the CLI is a .card, the account a .s-row, the pills .tag, the buttons .btn", async () => {
    await mount();
    expect(card("claude-code").className.split(" ")).toEqual(expect.arrayContaining(["card", "s-account-card"]));
    const work = rowOf("claude-code", "work");
    expect(work.className.split(" ")).toEqual(expect.arrayContaining(["s-row", "s-account-row"]));
    expect(work.querySelector(".s-auth-state").className).toContain("tag");
    expect(work.querySelector(".s-account-identity").className.split(" ")).toContain("tag");
    expect(work.querySelector(".s-account-used").className.split(" ")).toContain("tag");
    for (const b of work.querySelectorAll(".s-actions button")) expect(b.className.split(" "), text(b)).toContain("btn");
    expect(rowOf("claude-code", "work").querySelector(".s-account-remove").className.split(" ")).toContain("danger");   // Remove reads as the shared danger button
  });

  it("the meter's fill is drawn through the CSSOM (CSP style-src 'self'): the percent is its width; nothing on the page has a style attribute", async () => {
    await mount();
    const fill = rowOf("claude-code", "work").querySelector(".u-cm-fill");
    expect(fill.style.width).toBe("42%");
    expect(rowOf("claude-code", "personal").querySelector(".u-cm")).toBeNull();                // no usage reported: no meter
    expect(p.root.querySelectorAll("[style]")).toHaveLength(0);
    // a percent outside 0–100 never overdraws the meter
    view.clis[0].rows[0].usage = { percent: 140, windowMs: 604800000 };
    A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
    expect(rowOf("claude-code", "default").querySelector(".u-cm-fill").style.width).toBe("100%");
    expect(text(rowOf("claude-code", "default").querySelector(".u-cm-pct"))).toBe("100%");
  });

  it("no toolbar button ends with “…”, in both languages", async () => {
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false }); await p.unmount(); await mount();
      const labels = p.root.querySelectorAll(".s-actions button").map((b: any) => text(b));
      expect(labels.length, lang).toBeGreaterThan(4);
      expect(labels.filter((l: string) => /[….]$/.test(l)), lang).toEqual([]);
    }
    expect(p.root.querySelectorAll(".s-actions button").map((b: any) => text(b))).toEqual(expect.arrayContaining(["重新登入", "移入 Agent", "切換帳號", "登出", "移除"]));
  });

  it("a computer's account is a box too, with its default tag in the title bar", async () => {
    view.clis[0].rows[4].usedBy.fleetDefault = true;
    await mount();
    const m = card("claude-code").querySelector(".s-account-machine");
    const row = m.querySelector('.s-account-row[data-account="win-team"]');
    expect(text(row.querySelector(".s-account-title-left .s-account-default-tag"))).toBe("this computer's default");
    expect(row.querySelector(".s-account-usage.is-none")).toBeTruthy();                       // kept in the page (hidden by the stylesheet)
  });
});

describe("“used by N agents ▾”: the shared Menu, one item per agent, each opening that agent's settings (#3321)", () => {
  const list = (backend: string, acct: string) => rowOf(backend, acct).querySelector(".menu-list");
  const items = (backend: string, acct: string) => list(backend, acct).querySelectorAll('[role="menuitem"]');
  it("a static pill when no agent uses the account (nothing to open); a Menu button when agents do", async () => {
    await mount();
    expect([pill("claude-code", "default").tagName, text(pill("claude-code", "default")), pill("claude-code", "default").className]).toEqual(["SPAN", "used by no agent", "tag s-account-used"]);
    expect([pill("claude-code", "spare").tagName, text(pill("claude-code", "spare"))]).toEqual(["SPAN", "used by 1 ClassicBot room"]);   // rooms only: no agent to jump to
    const work = pill("claude-code", "work");
    expect([work.tagName, work.className.split(" ").filter((c: string) => c !== "active"), work.getAttribute("aria-haspopup"), work.getAttribute("aria-expanded"), text(work)])
      .toEqual(["BUTTON", ["tag", "s-account-used", "has-users"], "menu", "false", "used by 2 agents"]);
    expect(work.getAttribute("aria-label")).toBe("used by 2 agents");
    expect(work.parentElement.className).toContain("s-account-used-menu");
  });

  it("closed: its list is not in the page at all; click opens it; a second click closes it", async () => {
    await mount();
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(0);
    pill("claude-code", "work").click(); await settle(4);
    expect(list("claude-code", "work")).toBeTruthy();
    expect(list("claude-code", "work").getAttribute("role")).toBe("menu");
    expect(pill("claude-code", "work").getAttribute("aria-expanded")).toBe("true");
    expect(items("claude-code", "work").map((li: any) => text(li))).toEqual(["architect", "code-reviewer"]);
    expect(text(list("claude-code", "work").querySelector(".menu-heading"))).toBe("Agents using this account — choose one to open its settings");
    expect(text(pill("claude-code", "work"))).toBe("used by 2 agents");                       // the list is a sibling of the pill: its words are not the pill's
    pill("claude-code", "work").click(); await settle(4);
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(0);
  });

  it("choosing an agent calls openAgent(name) and closes the list", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    items("claude-code", "work")[1].click(); await settle(4);
    expect(opened).toEqual(["code-reviewer"]);
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(0);
  });

  it("Esc closes it and puts the focus back on the pill; a click outside closes it; a click on the heading does not", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    fire(list("claude-code", "work").querySelector(".menu-heading"), "pointerdown"); await settle(4);
    expect(list("claude-code", "work")).toBeTruthy();                                         // inside: stays
    fire(list("claude-code", "work"), "keydown", { key: "Escape" }); await settle(4);
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(0);
    pill("claude-code", "work").click(); await settle(4);
    fire(p.root.querySelector("h3"), "pointerdown"); await settle(4);
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(0);
  });

  it("opening another account's list closes the first (one at a time)", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    fire(pill("claude-code", "personal"), "pointerdown"); pill("claude-code", "personal").click(); await settle(4);
    expect(p.root.querySelectorAll(".menu-list")).toHaveLength(1);
    expect(list("claude-code", "personal")).toBeTruthy();
  });

  it("a computer's account lists its agents too, and opens them the same way", async () => {
    await mount();
    pill("claude-code", "win-team").click(); await settle(4);
    const menu = card("claude-code").querySelector('.s-account-machine .s-account-row[data-account="win-team"] .menu-list');
    expect(menu.querySelectorAll('[role="menuitem"]').map((x: any) => text(x))).toEqual(["win-agent"]);
    menu.querySelector('[role="menuitem"]').click(); await settle(4);
    expect(opened).toEqual(["win-agent"]);
  });

  it("without openAgent the agents are listed, but none can be chosen", async () => {
    await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8);
    pill("claude-code", "work").click(); await settle(4);
    const its = items("claude-code", "work");
    expect([its.map((x: any) => text(x)), its.map((x: any) => !!x.disabled)]).toEqual([["architect", "code-reviewer"], [true, true]]);
  });

  it("in zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    expect(text(pill("claude-code", "work"))).toBe("使用者：2 個 Agent");
    expect(text(pill("claude-code", "default"))).toBe("沒有 Agent 使用");
    pill("claude-code", "work").click(); await settle(4);
    expect(text(list("claude-code", "work").querySelector(".menu-heading"))).toBe("使用此帳號的 Agent（點擊跳轉設定）");
  });
});

describe("the usage block: the short window and the week, as CompactMeter (#3212, #3321)", () => {
  const short = (percent: number, extra: Record<string, unknown> = {}) => ({ percent, windowMs: 5 * 3_600_000, resetsAt: new Date(Date.now() + 3 * 3_600_000 + 30_000).toISOString(), ...extra });
  const level = (w: any) => w.querySelector(".u-cm-fill").className.split(" ").filter((c: string) => /^(warn|crit)$/.test(c));

  it("both windows, short first: name · meter · percent · reset; the box's layers are title, meta, usage, foot", async () => {
    view.clis[0].rows[1].shortUsage = short(76);
    view.clis[0].rows[1].usage = { percent: 28, windowMs: 7 * 86_400_000, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() };
    await mount();
    const work = rowOf("claude-code", "work"), ws = wins("claude-code", "work");
    expect(ws.map((w: any) => meterText(w).slice(0, 2))).toEqual([["5h", "76%"], ["7d", "28%"]]);
    expect(ws.map((w: any) => w.querySelector(".u-cm-fill").style.width)).toEqual(["76%", "28%"]);
    expect(ws.map((w: any) => meterText(w)[2])).toEqual(["↻ 3h", "↻ 2d"]);                      // the meter's own reset words: coarse, one unit
    expect(work.querySelectorAll(".s-account-usage")).toHaveLength(1);                           // one block, holding both
    expect([...work.children].map((c: any) => String(c.className).split(" ")[0])).toEqual(["s-account-title-bar", "s-account-meta-bar", "s-account-usage", "s-account-keepalive"]);
  });

  it("amber from 70%, red from 90% — the meter's own thresholds, on the fill and the percent alike", async () => {
    const at = async (pct: number) => { view.clis[0].rows[1].shortUsage = short(pct); A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
      const w = wins("claude-code", "work")[0]; return [level(w), w.querySelector(".u-cm-pct").className.split(" ").filter((c: string) => /^(warn|crit)$/.test(c))]; };
    expect(await at(0)).toEqual([[], []]); expect(await at(42)).toEqual([[], []]); expect(await at(69)).toEqual([[], []]);
    expect(await at(70)).toEqual([["warn"], ["warn"]]); expect(await at(89)).toEqual([["warn"], ["warn"]]);
    expect(await at(90)).toEqual([["crit"], ["crit"]]); expect(await at(100)).toEqual([["crit"], ["crit"]]);
    expect(await at(140)).toEqual([["crit"], ["crit"]]);                                         // clamped, so never beyond the bar
  });

  it("a CLI that reports one window shows one; one that reports none shows no block", async () => {
    view.clis[0].rows[1].shortUsage = short(55); delete view.clis[0].rows[1].usage;               // work: only the short window
    delete view.clis[0].rows[0].usage;                                                           // default: nothing
    await mount();
    expect(wins("claude-code", "work").map((w: any) => meterText(w).slice(0, 2))).toEqual([["5h", "55%"]]);
    expect(wins("claude-code", "default")).toHaveLength(0);
    expect(rowOf("claude-code", "default").querySelector(".s-account-usage")).toBeNull();
    expect(wins("claude-code", "personal")).toHaveLength(0);
    await p.unmount(); view = VIEW(); A.accountsStore.set({ loaded: false, failed: false, view: null }); await mount();
    expect(wins("claude-code", "work").map((w: any) => meterText(w).slice(0, 2))).toEqual([["7d", "42%"]]);   // only the week, as before
  });

  it("the reset is the meter's: ↻ and one unit (45m, 3h, 26h, 3d), nothing once it has passed; the exact clock time is the tooltip", async () => {
    const reset = async (ms: number) => { view.clis[0].rows[1].shortUsage = short(50, { resetsAt: new Date(Date.now() + ms).toISOString() }); A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
      const w = wins("claude-code", "work")[0]; return [meterText(w)[2], w.getAttribute("title")]; };
    const MIN = 60_000, HOUR = 3_600_000;
    view.clis[0].rows[1].usage = { percent: 42, windowMs: 7 * 86_400_000, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() };
    expect((await reset(44 * MIN + 30_000))[0]).toBe("↻ 45m");
    expect((await reset(3 * HOUR + MIN))[0]).toBe("↻ 3h");
    expect((await reset(26 * HOUR + MIN))[0]).toBe("↻ 26h");
    expect((await reset(3 * 24 * HOUR + HOUR))[0]).toBe("↻ 3d");
    const past = await reset(-5 * MIN);
    expect([past[0], past[1]]).toEqual(["", "5h: 50%"]);                                            // already past (stale data): no reset words, no clock
    const [words, title] = await reset(3 * HOUR + MIN);
    expect(words).toBe("↻ 3h");
    expect(title).toMatch(/^5h: 50% · ↻ \d/);                                                       // the window, the percent and the reset's clock time
  });

  it("a window is named from its length: hours, the week's word near seven days, else days; a week of unknown length is still the week", async () => {
    view.clis[0].rows[0].shortUsage = short(10, { windowMs: 24 * 3_600_000 });
    view.clis[0].rows[0].usage = { percent: 20, windowMs: 30 * 86_400_000 };
    view.clis[0].rows[1].shortUsage = short(10, { windowMs: 3 * 3_600_000 });
    view.clis[0].rows[1].usage = { percent: 20 };                                                 // no windowMs
    await mount();
    expect(wins("claude-code", "default").map((w: any) => meterText(w)[0])).toEqual(["24h", "30d"]);
    expect(wins("claude-code", "work").map((w: any) => meterText(w)[0])).toEqual(["3h", "7d"]);
  });

  it("stale: the block is greyed (`is-stale`) and says so once; a window with no reset time leaves its cell empty", async () => {
    view.clis[0].rows[1].shortUsage = short(76, { stale: true, resetsAt: undefined });
    view.clis[0].rows[1].usage = { percent: 28, windowMs: 7 * 86_400_000, stale: true };
    await mount();
    const block = rowOf("claude-code", "work").querySelector(".s-account-usage");
    expect(block.className).toContain("is-stale");
    expect(text(block)).toBe("5h76%7d28%(stale)");
    expect(block.querySelectorAll(".s-usage-stale")).toHaveLength(1);
    expect(meterText(wins("claude-code", "work")[0])[2]).toBe("");
  });

  it("a computer's rows keep the hidden dash and no meters; nothing carries an inline style", async () => {
    await mount();
    const m = card("claude-code").querySelector('.s-account-machine .s-account-row[data-account="win-team"]');
    expect(m.querySelectorAll(".s-account-usage")).toHaveLength(1);
    expect(m.querySelector(".s-account-usage").className).toContain("is-none");
    expect(m.querySelectorAll(".u-cm")).toHaveLength(0);
    expect(p.root.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("in zh-TW: 5h and 本週, （未更新）, 30天", async () => {
    i18n.setLang("zh-TW", { store: false });
    view.clis[0].rows[1].shortUsage = short(76, { stale: true });
    view.clis[0].rows[1].usage = { percent: 28, windowMs: 7 * 86_400_000, stale: true, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() };
    view.clis[0].rows[0].usage = { percent: 20, windowMs: 30 * 86_400_000 };
    await mount();
    const ws = wins("claude-code", "work");
    expect(ws.map((w: any) => meterText(w)[0])).toEqual(["5h", "本週"]);
    expect(ws.map((w: any) => meterText(w)[2])).toEqual(["↻ 3小時", "↻ 2天"]);                      // the Usage panel's own words for a reset
    expect(text(rowOf("claude-code", "work").querySelector(".s-usage-stale"))).toBe("（未更新）");
    expect(wins("claude-code", "default").map((w: any) => meterText(w)[0])).toEqual(["30天"]);
  });
});

describe("Keep sign-in alive: one foot line, an InfoTip for each explanation (#3212, #3321)", () => {
  const ka = (backend: string, acct: string) => rowOf(backend, acct).querySelector(".s-account-keepalive");
  const tipBtn = (tip: any) => tip.querySelector(".s-tipbtn");
  it("the explanation is the shared InfoTip beside its switch (a button described by a tooltip); the fallback switch has its own", async () => {
    view.clis[0].rows[1].keepAlive.fallback = false;
    await mount();
    const work = ka("claude-code", "work");
    const tips = work.querySelectorAll(".s-tipwrap");
    expect(tips).toHaveLength(2);
    for (const tip of tips) {
      const btn = tipBtn(tip), body = tip.querySelector('[role="tooltip"]');
      expect([text(btn), btn.tagName, btn.getAttribute("aria-describedby") === body.getAttribute("id"), body.hidden]).toEqual(["i", "BUTTON", true, true]);
      expect(tip.className).toContain("s-i");
    }
    expect(text(tips[0].querySelector('[role="tooltip"]'))).toBe("Once a day, if no agent is using it, AgEnD renews this sign-in with Claude Code's own status check. No model request.");
    expect(tipBtn(tips[0]).getAttribute("aria-label")).toBe("About “Keep sign-in alive”");
    expect(text(work.querySelector(".s-keepalive-fallback label"))).toBe("Backup renewal (a tiny request if the status check doesn't renew)");
    expect(text(work.querySelector(".s-keepalive-fallback .s-tipwrap [role=\"tooltip\"]"))).toBe("When the regular status check can't extend the sign-in, allow one very short request on the smallest model (a few dozen tokens) to keep it signed in.");
    expect(ka("claude-code", "personal").querySelectorAll(".s-tipwrap")).toHaveLength(1);       // off: no fallback switch
    expect(ka("codex", "default").querySelectorAll(".s-tipwrap")).toHaveLength(1);              // Codex has no fallback
    const ids = p.root.querySelectorAll('.s-account-keepalive [role="tooltip"]').map((x: any) => x.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);                                                 // every tooltip has its own id
  });

  it("hover shows the words, a tap pins them (a phone has no hover), Esc or a click elsewhere closes them", async () => {
    await mount();
    const tip = ka("claude-code", "work").querySelector(".s-tipwrap"), btn = tipBtn(tip), body = () => tip.querySelector('[role="tooltip"]');
    // The mini DOM names a listener by the prop's own name (onMouseEnter → "MouseEnter"); a browser by the lower-case event.
    const enter = async () => { fire(btn, "mouseenter"); fire(btn, "MouseEnter"); await settle(2); };
    const leave = async () => { fire(btn, "mouseleave"); fire(btn, "MouseLeave"); await settle(2); };
    await enter();
    expect(body().hidden).toBe(false);
    await leave();
    expect(body().hidden).toBe(true);
    btn.click(); await settle(2);                                                                // a tap: shown, and it stays when the pointer goes
    await leave();
    expect(body().hidden).toBe(false);
    fire(p.document, "keydown", { key: "Escape" }); await settle(2);
    expect(body().hidden).toBe(true);
    btn.click(); await settle(2); expect(body().hidden).toBe(false);
    fire(p.root.querySelector("h3"), "click"); await settle(2);
    expect(body().hidden).toBe(true);
  });

  it("zh-TW: the shorter fallback wording and its hint", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    const work = ka("claude-code", "work");
    expect(text(work.querySelector(".s-keepalive-fallback label"))).toBe("備援續期（狀態檢查未續期時改送極小請求）");
    expect(text(work.querySelector('.s-keepalive-fallback [role="tooltip"]'))).toBe("當一般狀態檢查未能延長登入效期時，允許改用最小模型送一次極短請求（約數十 token）來維持登入。");
    expect(tipBtn(work.querySelector(".s-tipwrap")).getAttribute("aria-label")).toBe("「保持登入」的說明");
  });
});

describe("the stylesheets: the theme's colours only, layers float, the box does not clip them (#3212, #3321)", () => {
  const css = readFileSync(new URL("../src/ui/shared/accounts.css", import.meta.url), "utf8");
  const ka = readFileSync(new URL("../src/ui/shared/accounts-keepalive.css", import.meta.url), "utf8");
  const rule = (sheet: string, selector: string) => {
    const at = sheet.split("\n").find((l) => l.startsWith(`${selector} {`));
    if (!at) throw new Error(`no rule for ${selector}`);
    return at;
  };
  const code = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, "");   // the rules without their comments
  it("no colour of their own: no hex, rgb(), hsl() or named colour, and no private palette (--ac-*); every var() is a token tokens.css defines", () => {
    const tokens = readFileSync(new URL("../src/ui/shared/tokens.css", import.meta.url), "utf8");
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    for (const [name, sheet] of [["accounts.css", css], ["accounts-keepalive.css", ka]] as const) {
      const c = code(sheet);
      expect(c.match(/#[0-9a-fA-F]{3,8}\b/g), `${name}: hex`).toBeNull();
      expect(c.match(/\b(?:rgba?|hsla?|oklch|lab|lch)\(/g), `${name}: colour functions`).toBeNull();
      expect(c.match(/\b(?:white|black|gray|grey|red|green|blue|orange|yellow)\b/g), `${name}: named colours`).toBeNull();
      expect(c, `${name}: a private palette`).not.toMatch(/--ac-/);
      const used = [...c.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
      expect(used.length, name).toBeGreaterThan(5);
      expect(used.filter((v) => !defined.has(v)), `${name}: variables tokens.css does not define`).toEqual([]);
    }
  });
  it("the stylesheets do not re-draw what the shared pieces draw: no private tooltip, popover or meter", () => {
    for (const sheet of [css, ka]) expect(code(sheet)).not.toMatch(/s-keepalive-tip|s-keepalive-hint|s-used-popover|s-used-wrap|s-usage-meter|s-usage-win|::-webkit-progress|::-moz-progress/);
  });
  it("the used-by list is the shared .menu-list, opened from the pill's own edge, so opening it moves nothing (position: absolute is the Menu's)", () => {
    const r = rule(css, ".s-account-used-menu .menu-list");
    expect(r).toContain("left: 0"); expect(r).toContain("right: auto");
    expect(readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8")).toMatch(/\.menu-list \{\s*position: absolute;/);
  });
  it("the account box and its card keep overflow visible; the gap between boxes is a spacing token", () => {
    expect(rule(css, ".s-accounts .s-account-row")).toContain("overflow: visible");
    expect(rule(css, ".s-accounts .s-account-card")).toContain("overflow: visible");
    expect(rule(css, ".s-accounts .s-account-rows")).toContain("gap: var(--s-3)");
    expect(css).not.toMatch(/\.s-account-row[^{]*\{[^}]*overflow:\s*hidden/);
  });
  it("tone separates the layers: card --surface (.card), box --bg, usage block --surface, the foot and a computer's tray --surface-2", () => {
    expect(rule(css, ".s-accounts .s-account-row")).toContain("background: var(--bg)");
    expect(rule(css, ".s-account-usage")).toContain("background: var(--surface)");
    expect(rule(ka, ".s-account-keepalive")).toContain("background: var(--surface-2)");
    expect(rule(css, ".s-accounts .s-account-machine")).toContain("background: var(--surface-2)");
    expect(code(css)).not.toMatch(/background:[^;}]*(?:color-mix|gradient)/);
  });
  it("the usage block: columns when wide, rows when narrow; the meters' own columns keep stacked rows aligned", () => {
    expect(rule(css, ".s-account-usage")).toContain("grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))");
    expect(css).toContain(".s-account-usage.is-stale .u-cm-pct { color: var(--text-3); }");
    expect(css).toContain(".s-account-usage.is-stale .u-cm-fill { background: var(--text-3); }");
    expect(readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8")).toContain(".u-cm { display: grid; grid-template-columns: 2.2em minmax(0, 1fr) 2.9em 3.7em;");
  });
  it("the buttons group hides when empty; a computer's “—” usage is not drawn; the status bar is the theme's --ok, --warn or --text-3", () => {
    expect(css).toContain(".s-account-row .s-actions:empty { display: none; }");
    expect(rule(css, ".s-account-usage.is-none")).toContain("display: none");
    // The user's report on #3367: the state colour is the house straight bar (`.lbar`, #2330), never a border-left on the
    // rounded row — the row carries the class, this sheet only colours it.
    expect(rule(css, ".s-accounts .s-account-row::before")).toContain("background: var(--ok)");
    expect(rule(css, ".s-account-row:has(.s-auth-state.is-not_signed_in)::before")).toContain("background: var(--warn)");
    expect(rule(css, ".s-account-row:has(.s-auth-state:is(.is-unknown, .is-not_installed, .is-too_old))::before")).toContain("background: var(--text-3)");
    expect(css).not.toMatch(/border-left(?:-color)?\s*:/);
    // #3407 review: the bar is drawn by this sheet on the row's own class (the `.lbar` shape: 3px, square, short of the
    // corners), not by a class in the markup — so an older sheet or older markup in an open tab never draws two.
    expect(rule(css, ".s-accounts .s-account-row::before")).toMatch(/left: 0; top: var\(--s-2\); bottom: var\(--s-2\); width: 3px;/);
    expect(readFileSync(new URL("../src/ui/accounts-view.js", import.meta.url), "utf8")).toContain('class="s-row s-account-row"');
  });
  it("Keep sign-in alive's foot is one wrapping line", () => {
    expect(rule(ka, ".s-account-keepalive")).toContain("flex-wrap: wrap");
  });
  it("no rule sets an inline style hook: nothing in the views writes style=", () => {
    for (const f of ["accounts-view.js", "accounts-keepalive.js", "accounts-manage.js"]) expect(readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8"), f).not.toMatch(/\sstyle=/);
  });
});
