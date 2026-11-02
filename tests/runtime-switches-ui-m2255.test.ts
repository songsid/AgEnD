/**
 * M-2255 / #2953 1.1, 1.8, 2.1, 2.2: Settings → Runtime's switches, as the page draws and saves them.
 *  - "Use this PC's Windows CLIs" and "Allow other Windows PCs to pair", each with its plain-language explanation (this
 *    computer stays the fleet; the other PC runs only a small runner), in English and zh-TW;
 *  - the connection guide in the page: Tailscale Serve with this fleet's own local address, an SSH tunnel with its port,
 *    never Funnel, no plain http:// on a LAN; open while pairing is on;
 *  - a switch the environment sets is shown as such and cannot be changed;
 *  - on: one PUT (it may wait for a fleet admin, said in the page); off: asked here first, nothing sent on No;
 *  - the per-PC limit: a whole number in its bounds, saved with one PUT;
 *  - where the switches cannot be read (403: the public link), the page says where they can be changed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, Panel: any, catalog: any, i18n: any, confirm: any;
const originalFetch = globalThis.fetch;
const requests: Array<{ path: string; method: string; body: any; key?: string }> = [];
let view: any, getStatus: number, putAnswer: (body: any) => { status: number; body: any };
const off = { on: false, configured: false, environment: null };
const response = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const text = () => p.root.textContent as string;
const input = (id: string) => p.root.querySelector(`#${id}`);
const button = (label: string) => p.root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
const puts = () => requests.filter(r => r.method === "PUT");
const toggle = async (id: string, checked: boolean) => { const el = input(id); el.checked = checked; fire(el, "change"); await settle(10); };

beforeAll(async () => {
  p = page({ url: "http://localhost/settings/runtimes", storage: { agend_lang: "en" } });
  globalThis.fetch = (async (path: string, options: any = {}) => {
    const method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, method, body, key: options.headers?.["Idempotency-Key"] });
    if (path === "/api/settings/runtimes") return getStatus === 200 ? response(view) : response({ error: "runtime_settings_not_over_public_link" }, getStatus);
    if (path === "/api/settings/fleet/runtimes") { const a = putAnswer(body); return response(a.body, a.status); }
    if (path === "/ui/runtimes") return response({ enabled: view.switches.remote_runtime.on, machines: [] });
    return response({});
  }) as any;
  i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  confirm = await import("/assets/ui-confirm.js");
  catalog = await import("/ui/js/runtime-catalog.js");
  Panel = (await import("/ui/js/panel-runtimes.js")).RuntimesPanel;
});
beforeEach(() => {
  requests.length = 0; getStatus = 200; i18n.setLang("en", { store: false }); catalog.forgetRuntimeCatalog();
  view = { switches: { windows_cli: { ...off }, remote_runtime: { ...off } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19555" };
  putAnswer = body => { for (const [k, v] of Object.entries(body)) if (k === "max_agents_per_machine") view.max_agents_per_machine.value = v; else view.switches[k] = { on: v, configured: v, environment: null };
    return { status: 200, body: { ok: true, ...view } }; };
  (globalThis as any).confirm = () => true;
});
afterEach(async () => { for (const q of confirm.confirmStore.get().queue) confirm.answerConfirm(q.id, false); await p.unmount(); catalog.forgetRuntimeCatalog(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; delete (globalThis as any).confirm; });
const mount = async () => { await p.mount(h(Panel, { navKey: "runtime" })); await settle(10); };

describe("what the page says", () => {
  it("both switches with their plain-language explanation, off by default, as switches; the limit with its bounds", async () => {
    await mount();
    const local = input("runtimeWindowsCli"), remote = input("runtimeRemoteRuntime");
    expect([local.getAttribute("role"), local.checked, local.disabled, remote.checked, remote.disabled]).toEqual(["switch", false, false, false, false]);
    expect(text()).toContain("Use this PC's Windows CLIs");
    expect(text()).toContain("with your Windows sign-ins");
    expect(text()).toContain("Allow other Windows PCs to pair");
    expect(text()).toContain("This computer stays your fleet. Another Windows PC runs only a small runner, not a fleet");
    expect(text()).toContain("Turning one on asks a fleet admin to confirm, like other access settings. Turning one off needs no fleet admin; it applies as soon as you confirm here.");
    expect([input("runtimeMaxAgents").value, input("runtimeMaxAgents").getAttribute("min"), input("runtimeMaxAgents").getAttribute("max")]).toEqual(["4", "1", "16"]);
    expect(text()).toContain("runs at most this many agents at the same time (1–16, default 4)");
    expect(text()).toContain("This limit applies to persistent terminal agents. Per-message execution keeps its existing admission limit.");
    expect(local.getAttribute("aria-describedby")).toBe("runtimeWindowsCliHelp");
    expect(p.root.querySelector("#runtimeWindowsCliHelp").textContent).toContain("Windows Node.js is required");
  });
  it("the connection guide: Tailscale Serve to this fleet's own address, an SSH tunnel on its port, never Funnel, no plain http on a LAN; closed while pairing is off", async () => {
    await mount();
    const guide = p.root.querySelector(".runtime-guide");
    const isOpen = (el: any) => el.open === true || el.hasAttribute("open");
    expect(isOpen(guide)).toBe(false);
    const codes = guide.querySelectorAll("code").map((c: any) => c.textContent);
    expect(codes).toEqual(["tailscale serve --https=443 http://127.0.0.1:19555",
      "ssh -N -L 127.0.0.1:19555:127.0.0.1:19555 user@this-computer"]);
    expect(guide.textContent).toContain("Then use http://localhost:19555:");
    expect(guide.textContent).toContain("3. When that PC asks to join, approve it here.");
    expect(guide.textContent).toContain("Never use Tailscale Funnel: it puts this fleet on the internet.");
    expect(guide.textContent).toContain("A plain http:// address on your network (such as http://192.168.1.20) is refused");
    const docs = guide.querySelector("a");
    expect([docs.getAttribute("href"), docs.getAttribute("target"), docs.getAttribute("rel")])
      .toEqual(["https://github.com/songsid/AgEnD/blob/main/docs/remote-runtime.md#connecting-over-a-private-network", "_blank", "noopener noreferrer"]);
    await p.unmount();
    view.switches.remote_runtime = { on: true, configured: true, environment: null };
    await mount();
    expect(isOpen(p.root.querySelector(".runtime-guide"))).toBe(true);
  });
  it("zh-TW: the same, in plain words", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    for (const s of ["使用這台電腦 Windows 上的 CLI", "允許其他 Windows 電腦配對", "這台電腦仍是你的 Fleet。另一台 Windows 電腦只執行一個小 runner，不是 Fleet",
      "每台 Windows 電腦同時執行的 Agent 數", "請勿使用 Tailscale Funnel", "另一台電腦如何連線", "開啟時，和其他存取設定一樣需要 Fleet 管理員確認；關閉不需 Fleet 管理員確認，你在這裡確認後就會立即生效。"]) expect(text(), s).toContain(s);
    expect(text()).not.toContain("Use this PC's Windows CLIs");
  });
  it("a switch the environment sets: shown in force, not changeable here, and the page says which variable", async () => {
    view.switches.remote_runtime = { on: true, configured: false, environment: "on" };
    view.switches.windows_cli = { on: false, configured: true, environment: "off" };
    await mount();
    expect([input("runtimeRemoteRuntime").checked, input("runtimeRemoteRuntime").disabled, input("runtimeWindowsCli").checked, input("runtimeWindowsCli").disabled]).toEqual([true, true, false, true]);
    expect(text()).toContain("Set by the environment (AGEND_REMOTE_RUNTIME=1). To change it, remove it from AgEnD's environment and restart AgEnD.");
    expect(text()).toContain("Set by the environment (AGEND_WINDOWS_CLI=0).");
  });
  it("where the switches cannot be read (the public link): said, nothing to press", async () => {
    getStatus = 403;
    await mount();
    expect(text()).toContain("These switches can be changed only on this fleet's own dashboard.");
    expect([input("runtimeWindowsCli"), input("runtimeMaxAgents")]).toEqual([null, null]);
  });
});

describe("what the page sends", () => {
  it("on: one PUT of that switch alone, with an idempotency key; the switch and the machines list follow the answer", async () => {
    await mount();
    await toggle("runtimeRemoteRuntime", true);
    expect(puts().map(r => [r.path, r.body])).toEqual([["/api/settings/fleet/runtimes", { remote_runtime: true }]]);
    expect(puts()[0].key).toMatch(/.+/);
    expect(input("runtimeRemoteRuntime").checked).toBe(true);
    expect(requests.filter(r => r.path === "/ui/runtimes").length).toBeGreaterThanOrEqual(2);
  });
  it("on, waiting for a fleet admin: the page says so", async () => {
    putAnswer = () => ({ status: 202, body: { result: "pending_confirmation", pending_change: { id: "a".repeat(32), state: "pending", summary: ["x"] } } });
    await mount();
    await toggle("runtimeWindowsCli", true);
    expect(text()).toContain("Waiting for a fleet admin to confirm. It turns on once they do.");
    expect(input("runtimeWindowsCli").disabled).toBe(true);
  });
  it("off: asked first — No sends nothing and leaves it on; Yes sends it", async () => {
    view.switches.windows_cli = { on: true, configured: true, environment: null };
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return false; };
    await mount();
    await toggle("runtimeWindowsCli", false);
    expect([puts().length, input("runtimeWindowsCli").checked]).toEqual([0, true]);
    expect(asked[0]).toContain("A Windows agent turn in progress on this PC stops");
    (globalThis as any).confirm = () => true;
    await toggle("runtimeWindowsCli", false);
    expect([puts().map(r => r.body), input("runtimeWindowsCli").checked]).toEqual([[{ windows_cli: false }], false]);
  });
  it("a refusal is said, and the switch shows what the server says", async () => {
    putAnswer = () => ({ status: 409, body: { error: "runtime_switch_set_by_environment" } });
    await mount();
    await toggle("runtimeWindowsCli", true);
    expect(text()).toContain("Could not change this setting: runtime_switch_set_by_environment");
    expect(input("runtimeWindowsCli").checked).toBe(false);
  });
  it("the limit: a whole number in its bounds, saved with one PUT; out of bounds or unchanged cannot be saved", async () => {
    await mount();
    const field = input("runtimeMaxAgents"), save = () => button("Save");
    expect(save().disabled).toBe(true);                                  // unchanged
    for (const v of ["17", "0", "2.5", ""]) { field.value = v; fire(field, "input"); await settle(); expect(save().disabled, v).toBe(true); }
    field.value = "6"; fire(field, "input"); await settle();
    expect(save().disabled).toBe(false);
    fire(p.root.querySelector(".runtime-limit"), "submit"); await settle(10);
    expect(puts().map(r => r.body)).toEqual([{ max_agents_per_machine: 6 }]);
    expect([input("runtimeMaxAgents").value, text().includes("Saved.")]).toEqual(["6", true]);
  });
  it("a number being typed survives a reload (a switch's answer); once saved, the server's value shows again", async () => {
    await mount();
    const field = input("runtimeMaxAgents");
    field.value = "9"; fire(field, "input"); await settle();
    await toggle("runtimeRemoteRuntime", true);                         // its answer reloads the view
    expect([input("runtimeMaxAgents").value, button("Save").disabled]).toEqual(["9", false]);
    fire(p.root.querySelector(".runtime-limit"), "submit"); await settle(10);
    view.max_agents_per_machine.value = 5;                               // changed elsewhere since
    await toggle("runtimeRemoteRuntime", false);
    expect(input("runtimeMaxAgents").value).toBe("5");
  });
});
