/**
 * M-3814: Settings → Access → the fixed address's preview address, as rendered (the panel in the mini DOM, a fake fetch
 * for the server): drawn beside a fixed hostname, the one Cloudflare route step with this fleet's preview port, staged
 * as web.public_link.preview_hostname, refused on the dashboard's own name or without a fixed hostname, and Check —
 * on the saved address only — with every step worded in en and zh-TW.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { PREVIEW_ROUTE_STEPS, type PreviewRouteCode } from "../src/tunnel/named-link-test.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, fleet: any, i18n: any;
let sent: Array<{ method: string; path: string; body: any }> = [];
let checkAnswer: { status: number; body: unknown } = { status: 200, body: null };
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (path === "/api/settings/public-link/preview-test") return { ok: checkAnswer.status < 400, status: checkAnswer.status, json: async () => checkAnswer.body };
  const body = (() => {
    if (method === "POST" && path === "/api/settings/apply") return { id: "job-1", status: "done", targets: [] };
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return fleet;
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.2.0", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(async () => { p = page({ url: "http://127.0.0.1:19280/settings/access" }); (globalThis as any).fetch = fakeFetch; i18n = await import("/assets/app-i18n.js"); });
afterAll(() => { i18n.setLang("en"); p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; p.window.confirm = () => true; (globalThis as any).confirm = () => true; i18n.setLang("en"); });
afterEach(async () => {
  await p.unmount();
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

async function open(extra: Record<string, unknown> = {}) {
  fleet = { defaults: { locale: "en" }, instances: {}, channels: [], ...extra };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access" }));
  await settle(12);
  const $ = (id: string) => p.root.querySelector(`#${id}`) as any;
  const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
  const apply = async () => { await settle(4); const region = p.root.querySelector("[role=region]"); const b = region?.querySelectorAll("button").find((x: any) => x.textContent.trim() === "Save"); if (b) { fire(b, "click"); await settle(); } };
  const webWrites = () => sent.filter(s => s.method !== "GET" && s.path === "/api/settings/fleet/web").map(s => s.body);
  const steps = () => [...(p.root.querySelectorAll(".fixed-preview-steps li") as any)].map((li: any) => li.textContent.trim());
  const checks = () => [...(p.root.querySelectorAll(".fixed-preview .named-test-steps li") as any)].map((li: any) => `${li.querySelector(".nt-mark").textContent} ${li.textContent.replace(/^\S+\s/, "").trim()}`);
  return { $, type, apply, webWrites, steps, checks };
}
const named = (pl: Record<string, unknown> = {}, web: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  ({ web: { ...web, public_link: { hostname: "agend.example.net", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN", ...pl } }, ...top });

describe("M-3814: the preview address in Settings → Access", () => {
  it("not drawn without a fixed hostname (a quick link)", async () => {
    const w = await open();
    expect(w.$("publicWebPreviewHostname")).toBeNull();
    expect(w.$("publicPreviewAddress")).toBeNull();
  });
  it("beside a fixed hostname: the field (preview.<hostname> suggested) and the one route step, with this fleet's preview port", async () => {
    const w = await open(named());
    expect(w.$("publicWebPreviewHostname").getAttribute("placeholder")).toBe("preview.agend.example.net");
    expect(w.steps()).toEqual([
      "Open this tunnel's Routes tab → Add route → Published application.",
      "Hostname: a name such as preview.agend.example.com",
      "Service URL: http://127.0.0.1:19281 (the preview port; not the origin port above).",
      "Save the route. Cloudflare adds the DNS record by itself.",
      "Fill in the address here, save, then press Check with the fixed link open.",
    ]);
    expect(w.$("publicPreviewAddress").querySelector("details").open, "not set yet: the steps are open").toBe(true);
    const custom = await open(named({ preview_hostname: "pv.example.net" }, { preview_port: 20001 }, { health_port: 18000 }));
    expect(custom.steps()[1]).toBe("Hostname: pv.example.net");
    expect(custom.steps()[2]).toContain("http://127.0.0.1:20001");
    expect(custom.$("publicPreviewAddress").querySelector("details").open, "saved: folded").toBe(false);
    const hp = await open(named({}, {}, { health_port: 18000 }));
    expect(hp.steps()[2], "web port + 1").toContain("http://127.0.0.1:18001");
  });
  it("stages web.public_link.preview_hostname (only what changed); clearing it writes the empty value", async () => {
    let w = await open(named());
    await w.type(w.$("publicWebPreviewHostname"), " preview.agend.example.net ");
    await w.apply();
    expect(w.webWrites()).toEqual([{ public_link: { preview_hostname: "preview.agend.example.net" } }]);
    sent = [];
    w = await open(named({ preview_hostname: "preview.agend.example.net" }));
    await w.type(w.$("publicWebPreviewHostname"), "");
    await w.apply();
    expect(w.webWrites()).toEqual([{ public_link: { preview_hostname: "" } }]);
  });
  it.each([
    ["the fixed hostname itself", "agend.example.net", named(), "Use a different name from the fixed hostname"],
    ["the fixed hostname as an HTTPS URL", "https://AGEND.example.net/", named(), "Use a different name from the fixed hostname"],
    ["not a name", "preview example", named(), "Enter a DNS hostname or HTTPS root URL."],
  ])("refused: %s — nothing is written", async (_l, value, config, said) => {
    const w = await open(config);
    await w.type(w.$("publicWebPreviewHostname"), value);
    await w.apply();
    expect(w.webWrites()).toEqual([]);
    expect(p.root.querySelector(".fixed-preview")!.textContent).toContain(said);
  });
  it("refused: the fixed hostname cleared while a preview address stays", async () => {
    const w = await open(named({ preview_hostname: "preview.agend.example.net" }));
    await w.type(w.$("publicWebHostname"), "");
    await w.apply();
    expect(w.webWrites()).toEqual([]);
    expect(p.root.querySelector(".fixed-preview")!.textContent).toContain("A preview address needs the fixed public hostname above.");
  });
  it("Settings' search finds it", async () => {
    const { searchSettings } = await import("/ui/js/settings-registry.js");
    expect(searchSettings("preview address").map((e: any) => e.id)).toContain("access.preview-address");
  });
});

describe("M-3814: Check", () => {
  const answer = (list: Array<[string, boolean, string]>) => ({ status: 200, body: { hostname: "preview.agend.example.net", port: 19281, steps: list.map(([step, ok, code]) => ({ step, ok, code })) } });
  it("an unsaved address: says to save first, asks nothing", async () => {
    const w = await open(named());
    await w.type(w.$("publicWebPreviewHostname"), "preview.agend.example.net");
    fire(w.$("previewAddressCheck"), "click"); await settle(6);
    expect(sent.filter(s => s.path.endsWith("/preview-test"))).toEqual([]);
    expect(p.root.querySelector(".fixed-preview")!.textContent).toContain("Save first: Check uses the saved address.");
  });
  it("the saved address: one POST; every step ✓ (en)", async () => {
    checkAnswer = answer([["values", true, "ok"], ["link", true, "ok"], ["dns", true, "ok"], ["reach", true, "ok"]]);
    const w = await open(named({ preview_hostname: "preview.agend.example.net" }));
    fire(w.$("previewAddressCheck"), "click"); await settle(10);
    expect(sent.filter(s => s.path.endsWith("/preview-test")).map(s => [s.method, s.body])).toEqual([["POST", {}]]);
    expect(w.checks()).toEqual([
      "✓ The preview address — Saved.",
      "✓ The fixed link is open — Open.",
      "✓ preview.agend.example.net can be looked up — Found.",
      "✓ preview.agend.example.net reaches this AgEnD's previews — It works: previews over the fixed address use preview.agend.example.net.",
    ]);
  });
  it("a ✗ says what to do; the rest is not checked (zh-TW)", async () => {
    i18n.setLang("zh-TW");
    checkAnswer = answer([["values", true, "ok"], ["link", false, "link-closed"]]);
    const w = await open(named({ preview_hostname: "preview.agend.example.net" }));
    fire(w.$("previewAddressCheck"), "click"); await settle(10);
    expect(w.checks()).toEqual([
      "✓ 預覽網址 — 已儲存。",
      "✗ 固定連結已開啟 — 請先開啟固定連結（/web）再檢查：預覽網址只在連結開著時回應。",
      "– 查得到 preview.agend.example.net — 未檢查（前面的步驟失敗）。",
      "– preview.agend.example.net 連得到這台 AgEnD 的預覽 — 未檢查（前面的步驟失敗）。",
    ]);
  });
  it("every server step and code has words in both languages, the same keys in each", async () => {
    const { t, setLang } = i18n;
    await import("/ui/js/settings-preview-address.js");
    const codes: Record<string, PreviewRouteCode[]> = { values: ["ok", "not-set"], link: ["ok", "link-closed", "no-listener"], dns: ["ok", "dns-missing", "dns-failed"],
      reach: ["ok", "wrong-service", "other-page", "route-missing", "self-unreachable", "reach-failed"] };
    expect(Object.keys(codes)).toEqual([...PREVIEW_ROUTE_STEPS]);
    for (const lang of ["en", "zh-TW"]) {
      setLang(lang);
      for (const [step, list] of Object.entries(codes)) for (const code of list) {
        const key = `settings.pva_${step}_${code}`;
        expect(t(key), `${lang} ${key}`).not.toBe(key);
      }
      for (const k of ["pvaTimeout", "pvaNotRun", "pvaSaveFirst", "pvaBusy", "pvaFailed", "previewHostname", "previewHostSame", "previewHostNeedsHostname"]) expect(t(`settings.${k}`), `${lang} ${k}`).not.toBe(`settings.${k}`);
    }
    setLang("en");
  });
  it("zh words: 管理員 / 「Agent」 rules — no 代理, 艦隊, 公司, 管理者", async () => {
    const src = (await import("node:fs")).readFileSync("src/ui/settings-preview-address.js", "utf8");
    const zh = src.slice(src.indexOf('"zh-TW": {'));
    expect(zh).not.toMatch(/代理|艦隊|公司|管理者/);
  });
});
