/**
 * #3212 PR 1: Settings → Agents → Accounts (src/ui/accounts-view.js, the real module over a faked GET /ui/accounts).
 * One card per CLI: the default sign-in and named accounts with which account each is (masked), who uses it and its
 * weekly usage; Sign in opens the existing dialog; "Move agents here…" stages each chosen agent's account (its other
 * backend options kept); the fleet default stages a defaults change; a paired computer's rows are read-only under its
 * name; the Agent dialog's Account field lists signed-in accounts and disables a signed-out one; both languages.
 * Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "dev", profile: "work" }, { name: "rev", profile: null }, { name: "ops", profile: null }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" }, usedBy: { agents: ["ops", "rev"], classic: [], fleetDefault: true }, usage: { percent: 37, windowMs: 604800000 } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "cd***@corp.example", plan: "team" }, usedBy: { agents: ["dev"], classic: ["room1"], fleetDefault: false }, usage: { percent: 82, windowMs: 604800000, stale: true } },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: false, readOnlyReason: "offline" }, backend: "claude-code", profile: "home", state: "usable", signIn: false, usedBy: { agents: [], classic: [], fleetDefault: false } },
    ] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "gpt", profile: "team2" }],
    rows: [
      { scope: { kind: "host" }, backend: "codex", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: true } },
      { scope: { kind: "host" }, backend: "codex", profile: "team2", state: "usable", signIn: false, hostCommand: "CODEX_HOME=/x codex login", usedBy: { agents: ["gpt"], classic: [], fleetDefault: false } },
    ] },
] };
let view: unknown = VIEW;
const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? view : { login: null, targets: [] }) });
let p: AppPage, A: any, S: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
const INSTANCES = { dev: { backend_options: { "claude-code": { credential_profile: "work" } } }, rev: {}, ops: { backend_options: { codex: { speed: "fast" } } }, gpt: { backend: "codex" } };
async function mount(props: Record<string, unknown> = {}) {
  const staged: unknown[] = [], defaults: unknown[] = [];
  await p.mount(h(A.AccountsView, { instances: INSTANCES, stageAgent: (n: string, i: unknown, patch: unknown) => staged.push([n, patch]), stageDefault: (b: string, prof: unknown) => defaults.push([b, prof]), ...props }));
  await settle(8);
  return { staged, defaults };
}
const card = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"]`);
const rowOf = (backend: string, acct: string) => card(backend).querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Settings → Agents → Accounts (#3212)", () => {
  it("one card per CLI; each account says which it is, who uses it, its week; states in words", async () => {
    await mount();
    expect(p.root.querySelectorAll(".s-account-card").map((c: any) => c.getAttribute("data-backend"))).toEqual(["claude-code", "codex"]);
    const def = rowOf("claude-code", "default"), work = rowOf("claude-code", "work"), off = rowOf("claude-code", "personal");
    expect([text(def.querySelector(".s-account-who strong")), text(def.querySelector(".s-account-identity")), text(def.querySelector(".s-account-used")), text(def.querySelector(".s-account-usage"))])
      .toEqual(["Default sign-in", "ab***@example.com · Max", "used by 2 agents · fleet default", "37% of the week"]);
    expect([text(work.querySelector(".s-account-who strong")), text(work.querySelector(".s-account-used")), text(work.querySelector(".s-account-usage"))])
      .toEqual(["Account “work”", "used by 1 agent · 1 ClassicBot room", "82% of the week · last known"]);
    expect([text(off.querySelector(".s-auth-state")), text(off.querySelector(".s-account-used"))]).toEqual(["not signed in", "used by no agent"]);
    expect(text(off.querySelector(".s-actions button"))).toBe("Sign in");
    expect(off.querySelector(".s-actions").textContent).not.toContain("Move agents here");      // a signed-out account takes no agents
    const team2 = rowOf("codex", "team2");
    expect([team2.querySelector(".s-actions button")?.textContent ?? null, text(team2.querySelector("details code"))]).toEqual(["Move agents here…", "CODEX_HOME=/x codex login"]);
  });

  it("a paired computer's accounts are drawn read-only under its name (the reserved machine scope)", async () => {
    await mount();
    const m = card("claude-code").querySelector(".s-account-machine");
    expect(text(m.querySelector(".note"))).toBe("On Desk PC — offline");
    expect(m.querySelectorAll("button")).toHaveLength(0);
  });

  it("Sign in opens the existing sign-in dialog for that account", async () => {
    await mount();
    fire(rowOf("claude-code", "personal").querySelector(".s-actions button"), "click"); await settle(4);
    const dialog = shell.shellStore.get().dialog;
    expect(dialog && dialog.props).toMatchObject({ backend: "claude-code", profile: "personal" });
  });

  it("Move agents here… stages each chosen agent onto the account, keeping its other backend options", async () => {
    const { staged } = await mount();
    const move = [...rowOf("claude-code", "work").querySelectorAll(".s-actions button")].find((b: any) => b.textContent === "Move agents here…");
    fire(move, "click"); await settle(6);
    const items = [...p.root.querySelectorAll(".s-account-move li")] as any[];
    expect(items.map((li) => [text(li.querySelector("span")), text(li.querySelector("small"))])).toEqual([["rev", "now: Default sign-in"], ["ops", "now: Default sign-in"]]);   // dev is already on it
    const box = items[1].querySelector("input"); box.checked = true; fire(box, "change"); await settle(4);
    const stageBtn = [...p.root.querySelectorAll("dialog button, .dlg button")].find((b: any) => b.textContent === "Stage") as any;
    fire(stageBtn, "click"); await settle(6);
    expect(staged).toEqual([["ops", { backend_options: { codex: { speed: "fast" }, "claude-code": { credential_profile: "work" } } }]]);
  });

  it("the fleet default: lists signed-in accounts, stages the change and keeps showing it until Save", async () => {
    const { defaults } = await mount();
    const sel = card("claude-code").querySelector(".s-account-default select");
    expect([...sel.querySelectorAll("option")].map((o: any) => o.value ?? o.getAttribute("value") ?? "")).toEqual(["", "work"]);   // not the signed-out one
    sel.value = "work"; fire(sel, "change"); await settle(4);
    expect(defaults).toEqual([["claude-code", "work"]]);
    expect(card("claude-code").querySelector(".s-account-default select").value).toBe("work");
  });

  it("the fleet default's backend_options: the whole map, two CLIs' choices adding up, null when back to what is saved", () => {
    const saved = { codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } };
    const one = A.defaultsBackendOptions(saved, undefined, "claude-code", "work");
    expect(one).toEqual({ codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } });
    const two = A.defaultsBackendOptions(saved, one, "codex", "team2");
    expect(two).toEqual({ codex: { speed: "fast", credential_profile: "team2" }, "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } });
    expect(A.defaultsBackendOptions(saved, one, "claude-code", null)).toBeNull();                    // back to what is saved
    expect(A.defaultsBackendOptions({ "claude-code": { credential_profile: "work" } }, undefined, "claude-code", null)).toEqual({});   // the CLI's entry goes
    expect(saved).toEqual({ codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } });   // not changed in place
  });

  it("in zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect([text(rowOf("claude-code", "default").querySelector(".s-account-who strong")), text(rowOf("claude-code", "work").querySelector(".s-account-used"))])
      .toEqual(["預設登入", "使用者：1 個 Agent · 1 個 ClassicBot 房間"]);
  });

  it("the Agent dialog's Account field: the fleet default first, signed-in accounts choosable, a signed-out one disabled", async () => {
    let picked = "";
    await p.mount(h(A.AccountSelect, { id: "ag-account", backend: "claude-code", value: "", onChange: (v: string) => { picked = v; } }));
    await settle(8);
    const opts = [...p.root.querySelectorAll("#ag-account option")] as any[];
    expect(opts.map((o) => [o.value ?? o.getAttribute("value") ?? "", text(o), !!o.disabled])).toEqual([["", "Fleet default (default sign-in)", false], ["personal", "personal — not signed in", true], ["work", "work", false]]);
    const sel = p.root.querySelector("#ag-account"); sel.value = "work"; fire(sel, "change"); await settle(2);
    expect(picked).toBe("work");
  });

  it("no Account field for a CLI without accounts, and the view says when it could not be read", async () => {
    await p.mount(h(A.AccountSelect, { id: "ag-account", backend: "grok", value: "", onChange: () => {} })); await settle(8);
    expect(p.root.querySelector("#ag-account")).toBeNull();
    await p.unmount(); A.accountsStore.set({ loaded: false, failed: false, view: null });
    (globalThis as any).fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "accounts_need_a_local_admin" }) });
    try { await mount(); expect(text(p.root.querySelector("[role=alert]"))).toBe("Could not read the accounts."); }
    finally { (globalThis as any).fetch = fetchFake; }
  });
});
