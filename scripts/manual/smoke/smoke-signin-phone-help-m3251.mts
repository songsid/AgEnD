// M-3251 (the user): the sign-in page's 「如何在手機開啟 AgEnD？」 — easiest first: the temporary link /web opens, a fixed
// link (a fixed public hostname in Settings), a private network such as Tailscale last; never "the computer's local
// network address" (the dashboard answers on 127.0.0.1 only). A fleet with no chat: Allow connections from outside, the
// fixed link, a private network with `agend web --code`.
// The real sign-in page from a real FleetManager on the shared fixture (scratch home, loopback only, no adapter, fleet or
// CLI starts). A chat fleet is a synthetic Telegram connection marked connected (no platform is contacted); a web-only
// fleet has none. Headless, phone 390×844. Cases: chat light en, chat dark zh-TW, web-only light en, web-only dark zh-TW.
// Pictured per case: the help opened.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there (Wi-Fi first, no /web).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> HP=<port> npx tsx scripts/manual/smoke/smoke-signin-phone-help-m3251.mts
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-signin-phone-help-m3251";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 2, classic: false, host: true });
const fm = fx.fm as any;
const CASES = [
  { name: "chat-light-en", chat: true, theme: "light", lang: "en" },
  { name: "chat-dark-zh-TW", chat: true, theme: "dark", lang: "zh-TW" },
  { name: "web-only-light-en", chat: false, theme: "light", lang: "en" },
  { name: "web-only-dark-zh-TW", chat: false, theme: "dark", lang: "zh-TW" },
] as const;
const WANT = {
  en: { chat: ["Temporary link", "Fixed link", "Private network, such as Tailscale"], web: ["From outside", "Fixed link", "Private network, such as Tailscale"] },
  "zh-TW": { chat: ["臨時連結", "固定連結", "私人網路（如 Tailscale）"], web: ["從外面連線", "固定連結", "私人網路（如 Tailscale）"] },
};
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const c of CASES) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    // A chat fleet: one synthetic Telegram connection, shown as connected (nothing is contacted). A web-only fleet: none.
    fm.fleetConfig.channels = c.chat ? [{ id: "m3251", type: "telegram", mode: "topic", group_id: "-1003251", access: { mode: "locked", allowed_users: ["100"] } }] : [];
    if (c.chat) fm.adapterState?.set?.("m3251", { status: "connected" }); else fm.adapterState?.delete?.("m3251");
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.phone, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: true, hasTouch: true });
    const page = await ctx.newPage(), errors: string[] = [];
    await ctx.addInitScript({ content: `window.__name = (f) => f; localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)});` });
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    try {
      need(fm.isWebOnlyFleet() === !c.chat, `the fixture is ${c.chat ? "a chat" : "a web-only"} fleet`);
      await page.goto(fx.base + "/signin");
      await page.waitForSelector("#form:not([hidden])", { timeout: 15000 });
      await page.locator("#reachHelp summary").tap();
      await page.waitForTimeout(300);
      const r = await page.evaluate(`(() => {
        var d = document.querySelector("#reachHelp"), list = d && d.querySelector("ol, ul"), items = list ? [].map.call(list.querySelectorAll("li"), function (li) { return li.textContent.trim(); }) : [];
        var code = [].map.call(d ? d.querySelectorAll("li code") : [], function (x) { return x.textContent; });
        return { open: !!(d && d.open && !d.hidden), title: d && d.querySelector("summary").textContent, lead: (d && d.querySelector("p") || {}).textContent || "",
          tag: list && list.tagName, numbered: list ? getComputedStyle(list).listStyleType : null, items: items, code: code,
          wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`) as any;
      const want = WANT[c.lang][c.chat ? "chat" : "web"];
      need(r.open && r.title === (c.lang === "en" ? "How do I open AgEnD on my phone?" : "如何在手機開啟 AgEnD？"), `the help opens, titled (${JSON.stringify({ open: r.open, title: r.title })})`);
      need(r.tag === "OL" && r.numbered === "decimal" && r.items.length === 3, `one numbered list of three (${JSON.stringify({ tag: r.tag, numbered: r.numbered, n: r.items.length })})`);
      need(want.every((w, i) => (r.items[i] || "").startsWith(w)), `easiest first: ${want.join(" → ")} (${JSON.stringify(r.items.map((s: string) => s.slice(0, 24)))})`);
      need(!r.items.some((s: string) => /Wi-Fi|local network address|區網/.test(s)), "no Wi-Fi / LAN address line");
      need(c.chat ? r.items[0].includes("/web") && r.items[0].includes("🌐") : r.items.every((s: string) => !/\/web[ ，。]/.test(s)) && r.code.includes("agend web --code"),
        c.chat ? "the temporary link is /web's 🌐" : `no /web on a fleet with no chat; agend web --code as code (${JSON.stringify(r.code)})`);
      need(!r.wide, "no sideways scroll");
      await page.locator("#reachHelp").scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath(SMOKE, c.name, "help"), fullPage: true });
      need(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, c.name, "error") }).catch(() => {});
    }
    results.push({ name: c.name, ok: failed.length === 0, failed });
    await ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
