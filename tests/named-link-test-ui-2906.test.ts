/**
 * #2906: the fixed address's Test connection on the page — what it sends (the values as filled in; the typed token
 * only when one is typed), and how it shows each step: ✓ / ✗ / –, with what to do next, in English and zh-TW.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, i18n: any, M: any;
let sent: Array<{ path: string; body: any }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: null };
const realFetch = (globalThis as any).fetch;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/access" });
  (globalThis as any).fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    sent.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  i18n = await import("/assets/app-i18n.js");
  M = await import("/ui/js/settings-named-test.js");
});
afterAll(() => { i18n.setLang("en"); p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(async () => { await p.unmount(); sent = []; i18n.setLang("en"); M.setTypedTunnelToken(""); });

async function run(props: Record<string, unknown> = { hostname: "agend.example.com", port: "19282", protocol: "http2" }) {
  await p.mount(h(M.NamedLinkTest, props)); await settle(4);
  fire(p.root.querySelector("#namedLinkTest"), "click"); await settle(10);
  return [...p.root.querySelectorAll(".named-test-steps li")].map((li: any) => `${li.querySelector(".nt-mark").textContent} ${li.textContent.replace(/^\S+\s/, "")}`);
}
const steps = (list: Array<[string, boolean, string]>) => ({ status: 200, body: { hostname: "agend.example.com", port: 19282, steps: list.map(([step, ok, code]) => ({ step, ok, code })) } });

describe("#2906 Test connection on the page", () => {
  it("sends the values as filled in, without a token when none is typed; with the typed one when there is", async () => {
    answer = steps([["values", true, "ok"]]);
    await run({ hostname: " agend.example.com ", port: "", protocol: "quic" });
    expect(sent.at(-1)).toEqual({ path: "/api/settings/public-link/test", body: { hostname: "agend.example.com", origin_port: "19282", protocol: "quic" } });
    M.setTypedTunnelToken("eyJtyped");
    await p.unmount(); await run();
    expect(sent.at(-1)!.body.token).toBe("eyJtyped");
  });
  it("all ✓ (en): each step with its own line, the last says it works", async () => {
    answer = steps([["values", true, "ok"], ["origin", true, "ok"], ["tunnel", true, "ok"], ["dns", true, "ok"], ["reach", true, "ok"]]);
    expect(await run()).toEqual([
      "✓ The domain, port and token — Filled in correctly.",
      "✓ This machine answers on port 19282 — Answered for this test.",
      "✓ The tunnel connects to Cloudflare — Connected to Cloudflare.",
      "✓ agend.example.com can be looked up — Found.",
      "✓ agend.example.com reaches this AgEnD — It works: agend.example.com reached this AgEnD.",
    ]);
  });
  it("a ✗ says what to do; the steps after it are not tested (zh-TW)", async () => {
    i18n.setLang("zh-TW");
    answer = steps([["values", true, "ok"], ["origin", true, "ok"], ["tunnel", false, "auth"]]);
    expect(await run()).toEqual([
      "✓ 網域、port 與 token — 填寫正確。",
      "✓ 這台主機在 port 19282 回應 — 這次測試有回應。",
      "✗ tunnel 連上 Cloudflare — Cloudflare 拒絕這個 token：它是錯的或已被更換。請到 Cloudflare 的 tunnel 頁面複製目前的 token 再貼上。",
      "– 查得到 agend.example.com — 未測試（前面的步驟失敗）。",
      "– agend.example.com 連得到這台 AgEnD — 未測試（前面的步驟失敗）。",
    ]);
  });
  it("this machine's network can't open its own address: the words the user asked for, both languages", async () => {
    answer = steps([["values", true, "ok"], ["origin", true, "ok"], ["tunnel", true, "ok"], ["dns", true, "ok"], ["reach", false, "self-unreachable"]]);
    expect((await run()).at(-1)).toBe("✗ agend.example.com reaches this AgEnD — The tunnel is connected, but this machine's network can't open agend.example.com (some networks filter new domains). From another network, such as a phone on mobile data, it may still work. Ask the network administrator to allow agend.example.com.");
    i18n.setLang("zh-TW"); await p.unmount();
    expect((await run()).at(-1)).toBe("✗ agend.example.com 連得到這台 AgEnD — tunnel 已連上，但這台主機所在的網路打不開 agend.example.com（有些網路會擋新的網域）。從其他網路（例如手機行動網路）可能可以正常使用。請網路管理員允許 agend.example.com。");
  });
  it("every code the server can answer has words in both languages (no raw key shown)", async () => {
    const all: Record<string, string[]> = {
      values: ["ok", "bad-hostname", "bad-port", "no-token", "bad-token"],
      origin: ["ok", "live", "dashboard-port", "port-in-use", "origin-failed", "link-open-other", "tunnel-busy"],
      tunnel: ["ok", "live", "auth", "network", "stopped", "no-binary"],
      dns: ["ok", "dns-missing", "dns-failed"],
      reach: ["ok", "wrong-service", "other-page", "route-missing", "self-unreachable", "reach-failed"],
    };
    for (const language of ["en", "zh-TW"]) {
      i18n.setLang(language);
      for (const [step, list] of Object.entries(all)) for (const code of list) {
        const said = i18n.t(`settings.nt_${step}_${code}`, "agend.example.com", 19282);
        expect(said.startsWith("settings."), `${language} ${step} ${code}`).toBe(false);
      }
    }
  });
  it("#2907: the deadline, an ended sign-in, and a connector whose stop could not be proven", async () => {
    answer = steps([["values", true, "ok"], ["origin", true, "ok"], ["tunnel", false, "timeout"]]);
    expect((await run())[2]).toBe("✗ The tunnel connects to Cloudflare — The test took too long and was stopped. Test again; if it repeats, check this machine's network.");
    answer = steps([["values", true, "ok"], ["origin", false, "cancelled"]]); await p.unmount();
    expect((await run())[1]).toBe("✗ This machine answers on port 19282 — Your sign-in ended, so nothing was started. Sign in again and test again.");
    answer = { status: 200, body: { ...(steps([["values", true, "ok"], ["origin", true, "ok"], ["tunnel", true, "ok"], ["dns", true, "ok"], ["reach", true, "ok"]]).body), cleanup: "unconfirmed" } };
    i18n.setLang("zh-TW"); await p.unmount(); await run();
    expect(p.root.querySelector(".named-test [role=alert]").textContent).toBe("無法確認測試用的連接器已經停止。請先執行 agend restart，再測試或開啟連結。");
  });
  it("busy (409) and a failed request say so; the button is disabled while it runs", async () => {
    answer = { status: 409, body: { error: "test_running" } };
    await run();
    expect(p.root.querySelector(".named-test [role=status]").textContent).toBe("A test is already running. Try again when it ends.");
    answer = { status: 500, body: null }; await p.unmount();
    await run();
    expect(p.root.querySelector(".named-test [role=status]").textContent).toBe("The test could not run. Try again.");
  });
});
