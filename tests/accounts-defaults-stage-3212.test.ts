/**
 * #3212 PR 1 (review r1): Settings → Agents → Accounts → each CLI's fleet default, staged through the real Settings panel.
 * The defaults write replaces a nested map whole (the Advanced editor removes a key by leaving it out), so the change
 * carries the whole `backend_options`: what is saved, with every CLI's choice on top, in one change. Choosing what is
 * saved again unstages it. No server: a fake fetch answers like settings-api.ts does (the harness of web-settings-1408).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
const FLEET = { defaults: { backend: "claude-code", backend_options: { codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } } },
  channels: [], instances: { alpha: { working_directory: "/w/a" } } };
const row = (backend: string, profile: string | null) => ({ scope: { kind: "host" }, backend, profile, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: profile === null } });
const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "alpha", profile: null }], rows: [row("claude-code", null), row("claude-code", "work")] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [row("codex", null), row("codex", "team2")] },
] };
function answer(r: Req): { status?: number; body?: unknown } {
  const { method: m, url } = r;
  if (m === "GET" && url === "/api/settings/schema") return { body: { impacts: {}, order: ["now", "instance", "fleet"] } };
  if (m === "GET" && url === "/api/settings/fleet/raw") return { body: structuredClone(FLEET) };
  if (m === "GET" && url === "/api/settings/classic") return { body: { defaults: {}, channels: {} } };
  if (m === "GET" && url === "/api/settings/connections") return { body: [] };
  if (m === "GET" && url === "/api/fleet") return { body: { version: "2.3.5", instances: [{ name: "alpha", status: "running" }] } };
  if (m === "GET" && url === "/api/profiles") return { body: [] };
  if (m === "GET" && url === "/api/settings/pending") return { body: [] };
  if (m === "GET" && url.startsWith("/ui/accounts")) return { body: VIEW };
  if (m === "POST" && url === "/api/settings/apply") return { body: { id: "job1", status: "done", targets: [] } };
  if (m === "GET" && url === "/api/settings/apply/job1") return { body: { id: "job1", status: "done", targets: [] } };
  if (m !== "GET") return { body: { ok: true } };
  return { status: 404, body: {} };
}
async function fetchFake(url: string, init: any = {}) {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const a = answer(r), status = a.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
}
let p: AppPage, S: any, apply: any, confirmMod: any, nav: any, A: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  S = await import("/ui/js/panel-settings.js");
  apply = await import("/ui/js/settings-apply.js");
  confirmMod = await import("/ui/js/settings-confirm.js");
  A = await import("/ui/js/accounts-view.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
});
beforeEach(async () => {
  await p.unmount(); apply.resetOperation(); confirmMod.resetConfirmations(); reqs = [];
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  (globalThis as any).confirm = () => true;
});
const btn = (scope: any, text: string) => scope.querySelectorAll("button").find((b: any) => b.textContent.includes(text));
const sel = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"] .s-account-default select`);
async function pick(backend: string, value: string) { const el = sel(backend); el.value = value; fire(el, "change"); await settle(6); }
async function mountAgents() {
  await p.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "agents" }, navKey: "settings:agents|1|en" }));
  await settle(12);
  const d = p.root.querySelector("details.s-ai-accounts"); if (d && !d.open) { d.open = true; fire(d, "toggle"); }
  await settle(8);
}
const puts = () => reqs.filter((r) => r.method === "PUT" && r.url === "/api/settings/fleet/defaults").map((r) => r.body);

describe("the fleet default account, staged in Settings (#3212)", () => {
  it("two CLIs' choices are one change carrying the whole backend_options (saved options kept)", async () => {
    await mountAgents();
    expect([!!sel("claude-code"), !!sel("codex")]).toEqual([true, true]);
    await pick("claude-code", "work");
    await pick("codex", "team2");
    const bar = p.root.querySelector(".s-pending");
    expect(bar?.textContent).toContain("1 unsaved change(s)");
    btn(bar, "Save").click(); await settle(12);
    expect(puts()).toEqual([{ backend_options: { codex: { speed: "fast", credential_profile: "team2" }, "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } } }]);
  });
  it("choosing what is saved again leaves nothing to save", async () => {
    await mountAgents();
    await pick("claude-code", "work");
    expect(!!p.root.querySelector(".s-pending")).toBe(true);
    await pick("claude-code", "");
    expect(p.root.querySelector(".s-pending")).toBeFalsy();
    expect(puts()).toEqual([]);
  });
});
