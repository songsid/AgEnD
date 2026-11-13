/**
 * #3429 (M-2901, option B): fleet Settings → Hub → "Fleet connection address", the host owner's card over #3660's D3
 * route (/api/settings/hub/member-address, /prepare, /commit). Through the real card and client, fetch answered here:
 * - what it shows; Change → one field → Check (prepare body exact) → the Fleets that move listed → Confirm (the ref);
 * - each outcome said: all followed / some followed with the names that must reconnect / none online / no Fleets;
 *   stopped and unreachable; an expired Check goes back to the form;
 * - refusals in words, never a raw code; a non-owner sees nothing; the page mark only for the host owner's own shell.
 */
import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { serveAppShell } from "../src/web-api.js";

const FLEETS = [{ id: "a".repeat(8) + "-0000-4000-8000-" + "0".repeat(12), owner: { realm: "corp", objectId: "x" }, generation: 3, label: "Alice Fleet" },
  { id: "b".repeat(8) + "-0000-4000-8000-" + "0".repeat(12), owner: { realm: "corp", objectId: "y" }, generation: 5, label: "Bob Fleet" }];
const NOW = { ok: true, origin: "https://hub.example.com:9443", listen: { host: "0.0.0.0", port: 9443 }, fleets: FLEETS };
type Answer = { status?: number; body: unknown };
const mounted: AppPage[] = [];
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } delete (globalThis as any).fetch; });

async function fixture(opts: { language?: string; read?: Answer; prepare?: (b: any) => Answer; commit?: () => Answer } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const calls: Array<{ path: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method ?? "GET", body });
    const a: Answer = path.endsWith("/prepare") ? (opts.prepare ?? (b => ({ body: { ok: true, ref: "r".repeat(32), expiresAt: Date.now() + 300_000,
      summary: { field: "member-address", from: NOW.origin, to: b.origin, listen: b.listen, fleetsRejoin: true, fleets: FLEETS } } })))(body)
      : path.endsWith("/commit") ? (opts.commit ?? (() => ({ body: { ok: true, receiptId: "x", origin: "https://hub.example.com:9555", followed: 2, reconnect: [], state: "ready" } })))()
      : (opts.read ?? { body: NOW });
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, json: async () => a.body };
  };
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(opts.language ?? "en", { store: false });
  const mod = await import("/ui/js/settings-hub-member-address.js");
  await pg.mount(h(mod.HubMemberAddressSettings, {})); await settle(6);
  const q = (s: string) => pg.root.querySelector(s) as any;
  const type = async (s: string, v: string) => { const el = q(s); el.value = v; fire(el, "input"); await settle(); };
  const button = (text: string) => (Array.from(pg.root.querySelectorAll("button")) as any[]).find(b => b.textContent.trim() === text);
  const click = async (text: string) => { fire(button(text), "click"); await settle(6); };
  const submit = async () => { fire(q(".hub-addr-form"), "submit"); await settle(6); };
  return { pg, calls, q, type, button, click, submit, mod, text: () => pg.root.textContent as string };
}

describe("#3429 Settings → Hub → Fleet connection address", () => {
  it.each([
    ["en", "Fleet connection address", "Change connection address", "Confirm change", "Fleets that move (2)", "Fleets online now follow on their own", "Done. All 2 Fleets followed to the new address."],
    ["zh-TW", "Fleet 連線位址", "變更連線位址", "確認變更", "會移動的 Fleet（2）", "目前在線上的 Fleet 會自動跟著移動", "完成。全部 2 個 Fleet 都已跟著移動到新位址。"],
  ])("%s: shows the address and how many Fleets; Check lists those that move; Confirm says who followed", async (language, title, change, confirm, moving, effect, done) => {
    const f = await fixture({ language });
    expect(f.q("summary").textContent).toContain(title);
    expect(f.text()).toContain("hub.example.com:9443");
    expect(f.text()).not.toMatch(/hubMemberAddress\\.|err_/);
    await f.click(change); await f.type("#hubMemberNew", "hub.example.com:9555"); await f.submit();
    expect(f.calls[1]).toEqual({ path: "/api/settings/hub/member-address/prepare", method: "POST",
      body: { origin: "https://hub.example.com:9555", listen: { host: "0.0.0.0", port: 9555 } } });
    expect(f.text()).toContain(moving);
    expect(f.text()).toContain("Alice Fleet"); expect(f.text()).toContain("Bob Fleet");
    expect(f.text()).toContain(effect);
    await f.click(confirm);
    expect(f.calls[2]).toEqual({ path: "/api/settings/hub/member-address/commit", method: "POST", body: { ref: "r".repeat(32) } });
    expect(f.text()).toContain(done);
    expect(f.q(".hub-addr-now code").textContent).toBe("hub.example.com:9555");
  });
  it("each outcome names who must reconnect", async () => {
    const f = await fixture();
    const say = (r: object) => f.mod.outcomeText(r, 9555);
    expect(say({ state: "ready", followed: 1, reconnect: [{ id: "b", label: "Bob Fleet" }] })).toBe("Done. 1 of 2 Fleets followed. These must reconnect from their own Settings → Hub: Bob Fleet.");
    expect(say({ state: "ready", followed: 0, reconnect: [{ id: "a", label: "Alice Fleet" }, { id: "b" }] })).toBe("Done. No Fleet was online to follow. These must reconnect from their own Settings → Hub: Alice Fleet, a Fleet without a name.");
    expect(say({ state: "ready", followed: 0, reconnect: [] })).toBe("Done. No Fleet was connected.");
    expect(say({ state: "off" })).toContain("The Hub is stopped");
    expect(say({ state: "saved_unavailable" })).toContain("port 9555");
  });
  it.each([
    ["port_in_use", "Another program on this computer is using that port."],
    ["port_conflict", "That is the Hub address or its port."],
    ["stale", "Something changed meanwhile"],
    ["something_new", "The address wasn't changed. Try again."],
  ])("a Check refused with %s says so in words", async (code, words) => {
    const f = await fixture({ prepare: () => ({ status: 409, body: { ok: false, code } }) });
    await f.click("Change connection address"); await f.type("#hubMemberNew", "hub.example.com:9555"); await f.submit();
    expect(f.q('[role="alert"]').textContent).toContain(words);
    expect(f.text()).not.toMatch(/port_in_use|port_conflict|something_new/);
  });
  it("an expired Confirm goes back to the form; nothing changed locally is refused before any request", async () => {
    const f = await fixture({ commit: () => ({ status: 410, body: { ok: false, code: "expired" } }) });
    await f.click("Change connection address"); await f.type("#hubMemberNew", "hub.example.com:9443"); await f.submit();
    expect(f.q('[role="alert"]').textContent).toContain("That is already the Fleet connection address.");
    expect(f.calls).toHaveLength(1);
    await f.type("#hubMemberNew", "hub.example.com:9555"); await f.submit(); await f.click("Confirm change");
    expect(f.q('[role="alert"]').textContent).toContain("That took too long. Check again.");
    expect(f.q("#hubMemberNew")).not.toBeNull();
  });
  it("someone who is not this computer's host owner sees no card", async () => {
    const f = await fixture({ read: { status: 403, body: { ok: false, code: "denied" } } });
    expect(f.q(".hub-member-address")).toBeNull();
  });
});

describe("#3429 the page mark", () => {
  const shell = (ctx: Record<string, unknown>, gateway = false) => {
    const req = { method: "GET", url: "/settings/hub", headers: { host: "127.0.0.1:19280" }, socket: { remoteAddress: "127.0.0.1" } } as any;
    if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "http://127.0.0.1:19280", isCurrent: () => true });
    let html = ""; serveAppShell(req, { setHeader() {}, writeHead() {}, end(value: string) { html = value; } } as never, ctx as never, "full");
    return html;
  };
  const base = { getRawFleetConfig: () => ({ hub: { hubId: "h".repeat(32) } }), hubSetupSession: () => ({}), hubMemberAddress: async () => ({}) };
  it("is set for the host owner's own shell on a fleet with a Hub, and nowhere else", () => {
    expect(shell(base)).toContain('data-hub-member-address="1"');
    expect(shell(base, true)).not.toContain('data-hub-member-address="1"');
    expect(shell({ ...base, hubSetupSession: () => null })).not.toContain('data-hub-member-address="1"');
    expect(shell({ ...base, getRawFleetConfig: () => ({}) })).not.toContain('data-hub-member-address="1"');
    expect(shell({ ...base, hubMemberAddress: undefined })).not.toContain('data-hub-member-address="1"');
  });
});
