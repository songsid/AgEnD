/**
 * AGEND-101: Settings → Accounts, box layout (src/ui/accounts-view.js, accounts-keepalive.js and their stylesheets, over a faked GET /ui/accounts).
 * Each account is a box with three layers: the title bar (name, state, default tag · compact buttons without a trailing "…"), the meta bar
 * (masked email · plan, "used by" pill, weekly usage with a <progress> meter) and Keep sign-in alive as the box's foot, whose explanations are
 * a `!` shown on hover / focus. "Used by N agents ▾" opens a floating list (only while open is it in the page) with a jump to each agent's
 * settings; a click outside or Esc closes it. The stylesheets keep the layers over the box (position: absolute), the box overflow visible, and
 * use no inline style (CSP style-src 'self'). Fixtures only (example.com).
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
const popover = (backend: string, acct: string) => rowOf(backend, acct).querySelector(".s-used-popover");

describe("the account box: three layers (AGEND-101)", () => {
  it("title bar: name, state and the default tag on the left, the buttons on the right; meta bar: who, used by, the week", async () => {
    await mount();
    const work = rowOf("claude-code", "work");
    const bar = work.querySelector(".s-account-title-bar"), meta = work.querySelector(".s-account-meta-bar");
    expect([text(bar.querySelector(".s-account-title-left strong")), text(bar.querySelector(".s-account-title-left .s-auth-state")), text(bar.querySelector(".s-account-title-left .s-account-default-tag"))])
      .toEqual(["Account “work”", "signed in", "fleet default"]);
    expect(bar.querySelector(".s-actions")).toBeTruthy();                                    // the buttons are in the title bar
    expect([text(meta.querySelector(".s-account-identity")), text(meta.querySelector(".s-account-used")), text(meta.querySelector(".s-account-usage"))])
      .toEqual(["te***@company.example · Team", "used by 2 agents", "42% of the week"]);
    expect(meta.querySelector(".s-account-usage progress.s-usage-meter")).toBeTruthy();       // a meter in front of the week, not an inline-styled bar
  });

  it("the usage meter is a <progress> with the percent as its value; nothing on the page uses an inline style (CSP style-src 'self')", async () => {
    await mount();
    const meter = rowOf("claude-code", "work").querySelector("progress.s-usage-meter");
    expect([Number(meter.getAttribute("max")), Number(meter.value ?? meter.getAttribute("value"))]).toEqual([100, 42]);
    expect(rowOf("claude-code", "personal").querySelector("progress")).toBeNull();            // no usage reported: no meter
    expect(p.root.querySelectorAll("[style]")).toHaveLength(0);
    // a percent outside 0–100 never overdraws the meter
    view.clis[0].rows[0].usage = { percent: 140, windowMs: 604800000 };
    A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
    expect(Number(rowOf("claude-code", "default").querySelector("progress").value ?? rowOf("claude-code", "default").querySelector("progress").getAttribute("value"))).toBe(100);
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

describe("“used by N agents ▾”: a floating list that jumps to an agent's settings (AGEND-101)", () => {
  it("a static pill when no agent uses the account (nothing to open); a button when agents do", async () => {
    await mount();
    expect([pill("claude-code", "default").tagName, text(pill("claude-code", "default")), pill("claude-code", "default").className]).toEqual(["SMALL", "used by no agent", "s-account-used"]);
    expect([pill("claude-code", "spare").tagName, text(pill("claude-code", "spare"))]).toEqual(["SMALL", "used by 1 ClassicBot room"]);   // rooms only: no agent to jump to
    const work = pill("claude-code", "work");
    expect([work.tagName, work.className, work.getAttribute("aria-expanded"), text(work)]).toEqual(["BUTTON", "s-account-used has-users", "false", "used by 2 agents"]);
  });

  it("closed: its list is not in the page at all; click opens it; a second click closes it", async () => {
    await mount();
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(0);
    pill("claude-code", "work").click(); await settle(4);
    const pop = popover("claude-code", "work");
    expect(pop).toBeTruthy();
    expect(pill("claude-code", "work").getAttribute("aria-expanded")).toBe("true");
    expect(pill("claude-code", "work").className).toContain("is-open");
    expect(pop.querySelectorAll("li").map((li: any) => text(li.querySelector(".s-used-agent")))).toEqual(["architect", "code-reviewer"]);
    expect(text(pill("claude-code", "work"))).toBe("used by 2 agents");                       // the list is a sibling of the pill: its words are not the pill's
    pill("claude-code", "work").click(); await settle(4);
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(0);
  });

  it("“Open settings →” calls openAgent(name) and closes the list", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    const go = popover("claude-code", "work").querySelectorAll(".s-used-go");
    expect(go.map((b: any) => text(b))).toEqual(["Open settings →", "Open settings →"]);
    expect(go[1].getAttribute("aria-label")).toBe("Open the settings of code-reviewer");
    go[1].click(); await settle(4);
    expect(opened).toEqual(["code-reviewer"]);
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(0);
  });

  it("Esc and a click outside close it; a click inside it does not", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    fire(popover("claude-code", "work").querySelector(".s-used-popover-title"), "click"); await settle(4);
    expect(popover("claude-code", "work")).toBeTruthy();                                      // inside: stays
    fire(p.document, "keydown", { key: "Escape" }); await settle(4);
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(0);
    pill("claude-code", "work").click(); await settle(4);
    fire(p.root.querySelector("h3"), "click"); await settle(4);
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(0);
  });

  it("opening another account's list closes the first (one at a time)", async () => {
    await mount();
    pill("claude-code", "work").click(); await settle(4);
    pill("claude-code", "personal").click(); await settle(4);
    expect(p.root.querySelectorAll(".s-used-popover")).toHaveLength(1);
    expect(popover("claude-code", "personal")).toBeTruthy();
  });

  it("a computer's account lists its agents too, and jumps the same way", async () => {
    await mount();
    pill("claude-code", "win-team").click(); await settle(4);
    const pop = card("claude-code").querySelector('.s-account-machine .s-account-row[data-account="win-team"] .s-used-popover');
    expect(pop.querySelectorAll(".s-used-agent").map((x: any) => text(x))).toEqual(["win-agent"]);
    pop.querySelector(".s-used-go").click(); await settle(4);
    expect(opened).toEqual(["win-agent"]);
  });

  it("without openAgent the agents are listed with no jump button", async () => {
    await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8);
    pill("claude-code", "work").click(); await settle(4);
    expect([popover("claude-code", "work").querySelectorAll(".s-used-agent").length, popover("claude-code", "work").querySelectorAll(".s-used-go").length]).toEqual([2, 0]);
  });

  it("in zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    expect(text(pill("claude-code", "work"))).toBe("使用者：2 個 Agent");
    expect(text(pill("claude-code", "default"))).toBe("沒有 Agent 使用");
    pill("claude-code", "work").click(); await settle(4);
    expect(text(popover("claude-code", "work").querySelector(".s-used-popover-title"))).toBe("使用此帳號的 Agent（點擊跳轉設定）");
    expect(popover("claude-code", "work").querySelectorAll(".s-used-go").map((b: any) => text(b))).toEqual(["前往設定 →", "前往設定 →"]);
  });
});

describe("Keep sign-in alive: one foot line, a `!` for each explanation (AGEND-101)", () => {
  const ka = (backend: string, acct: string) => rowOf(backend, acct).querySelector(".s-account-keepalive");
  it("the explanation is a hint beside a focusable `!`; the fallback switch has its own", async () => {
    view.clis[0].rows[1].keepAlive.fallback = false;
    await mount();
    const work = ka("claude-code", "work");
    const tips = work.querySelectorAll(".s-keepalive-tip-wrap");
    expect(tips).toHaveLength(2);
    for (const tip of tips) {
      const icon = tip.querySelector(".s-keepalive-tip-icon"), hint = tip.querySelector(".s-keepalive-hint");
      expect([text(icon), icon.getAttribute("tabindex"), icon.getAttribute("aria-describedby") === hint.getAttribute("id")]).toEqual(["!", "0", true]);
    }
    expect(text(tips[0].querySelector(".s-keepalive-hint"))).toBe("Once a day, if no agent is using it, AgEnD renews this sign-in with Claude Code's own status check. No model request.");
    expect(text(work.querySelector(".s-keepalive-fallback label"))).toBe("Backup renewal (a tiny request if the status check doesn't renew)");
    expect(text(work.querySelector(".s-keepalive-fallback .s-keepalive-hint"))).toBe("When the regular status check can't extend the sign-in, allow one very short request on the smallest model (a few dozen tokens) to keep it signed in.");
    expect(work.querySelector(".s-keepalive-fallback .s-keepalive-hint").className).toContain("is-end");   // right-aligned, inside the box's right edge
    expect(ka("claude-code", "personal").querySelectorAll(".s-keepalive-tip-wrap")).toHaveLength(1);       // off: no fallback switch
    expect(ka("codex", "default").querySelectorAll(".s-keepalive-tip-wrap")).toHaveLength(1);              // Codex has no fallback
    const ids = p.root.querySelectorAll(".s-keepalive-hint").map((x: any) => x.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);                                                            // every hint has its own id
  });

  it("zh-TW: the shorter fallback wording and its hint", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    const work = ka("claude-code", "work");
    expect(text(work.querySelector(".s-keepalive-fallback label"))).toBe("備援續期（狀態檢查未續期時改送極小請求）");
    expect(text(work.querySelector(".s-keepalive-fallback .s-keepalive-hint"))).toBe("當一般狀態檢查未能延長登入效期時，允許改用最小模型送一次極短請求（約數十 token）來維持登入。");
    expect(text(work.querySelector(".s-keepalive-tip-icon"))).toBe("!");
  });
});

describe("the stylesheets: layers float, the box does not clip them (AGEND-101)", () => {
  const css = readFileSync(new URL("../src/ui/shared/accounts.css", import.meta.url), "utf8");
  const ka = readFileSync(new URL("../src/ui/shared/accounts-keepalive.css", import.meta.url), "utf8");
  const rule = (sheet: string, selector: string) => {
    const at = sheet.split("\n").find((l) => l.startsWith(`${selector} {`));
    if (!at) throw new Error(`no rule for ${selector}`);
    return at;
  };
  it("the used-by list is position: absolute under the pill with a high z-index, so opening it moves nothing", () => {
    const r = rule(css, ".s-used-popover");
    expect(r).toContain("position: absolute"); expect(r).toContain("top: calc(100% + 5px)"); expect(r).toContain("left: 0"); expect(r).toContain("z-index: 100");
    expect(rule(css, ".s-used-wrap")).toContain("position: relative");
  });
  it("the account box and its card keep overflow visible; the gap between boxes is 12px", () => {
    expect(rule(css, ".s-accounts .s-account-row")).toContain("overflow: visible");
    expect(rule(css, ".s-accounts .s-account-card")).toContain("overflow: visible");
    expect(rule(css, ".s-accounts .s-account-rows")).toContain("gap: 12px");
    expect(css).not.toMatch(/\.s-account-row[^{]*\{[^}]*overflow:\s*hidden/);
  });
  it("the `!` hint is out of the flow and shown only on hover / focus", () => {
    const hint = rule(ka, ".s-account-keepalive .s-keepalive-hint");
    expect(hint).toContain("display: none"); expect(hint).toContain("position: absolute");
    expect(ka).toContain(".s-keepalive-tip-wrap:hover .s-keepalive-hint, .s-keepalive-tip-wrap:focus-within .s-keepalive-hint { display: block; }");
    expect(rule(ka, ".s-account-keepalive")).toContain("flex-wrap: wrap");
  });
  it("the buttons group hides when empty; a computer's “—” usage is not drawn; the status bar turns amber when not signed in", () => {
    expect(css).toContain(".s-account-row .s-actions:empty { display: none; }");
    expect(rule(css, ".s-account-usage.is-none")).toContain("display: none");
    expect(css).toContain(".s-account-row:has(.s-auth-state.is-not_signed_in)::before");
  });
  it("no rule sets an inline style hook: nothing in the views writes style=", () => {
    for (const f of ["accounts-view.js", "accounts-keepalive.js", "accounts-manage.js"]) expect(readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8"), f).not.toMatch(/\sstyle=/);
  });
});
