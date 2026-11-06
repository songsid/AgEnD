// #2889 (the user, hmsg-769c60a4): on a phone, "Not verified" under the composer, where this browser can't be
// authorized, said nothing more — the reason was only in a tooltip, and touch has no hover. A tap now shows it in the
// bubble "✓ Verified" uses (#2215/#2216). From defaults (fleet decision a78ebdc5): fresh profiles signed in through the
// visible /signin as a demo account, driven through visible UI. not_admin is the server's own answer (the account is no
// admin); the other reasons are this page's GET /ui/authorization answered by the smoke (the server's reasons are
// unchanged; what is judged is how the row shows them).
// Cases: phone (390, touch) and desk, zh-TW and en; reasons no_account, not_admin, public_link, named_link_off, disabled
// (with its Settings link) and token_rotated. Judged: the row says only "Not verified"; its accessible name is
// "Not verified: <reason>"; a tap shows the reason in a bubble inside the viewport; a second tap, a tap elsewhere,
// Escape and a tap in the message box each close it, and then Attach and the message box take a tap; on a desk the
// reason is the hover tooltip (title) and hovering opens no bubble. MODE=before shoots the old row for the PR.
//   PW_DIR=… REPO=… OUT=… FONTCONFIG_FILE=/etc/fonts/fonts.conf [MODE=before] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2889-not-verified-why.mts
import { bootFixture, demoAccount, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2889-not-verified-why";
const MODE = process.env.MODE === "before" ? "before" : "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48720), classic: false });
const fm = fx.fm;
const CHAT = "observability-dashboards";
for (const name of Object.keys(fm.fleetConfig.instances)) if (name !== CHAT) delete fm.fleetConfig.instances[name];
fm.fleetConfig.channels = [{ id: "demo", type: "discord", bot_token_env: "DEMO_BOT_TOKEN", access: { mode: "locked", allowed_users: [] } }];

const REASONS = ["no_account", "not_admin", "public_link", "named_link_off", "disabled", "token_rotated"] as const;
const SAYS: Record<string, Record<string, string>> = {
  en: {
    no_account: "This browser was not signed in as an account (agend web): sign in with /web to authorize.",
    not_admin: "Your account is not a fleet admin here.",
    public_link: "Not on the temporary public link.",
    named_link_off: "Over your named link: turn on \"Also over my named link\" in Settings → Access & security on this computer.",
    disabled: "Web authority is turned off.",
    token_rotated: "The dashboard's token changed: sign in again.",
  },
  "zh-TW": {
    no_account: "這個瀏覽器不是用帳號登入的（agend web）：請用 /web 登入後再授權。",
    not_admin: "你的帳號在這裡不是 fleet 管理者。",
    public_link: "臨時公開連結上無法授權。",
    named_link_off: "透過固定網域：請在這台電腦的 設定 → 存取與安全 開啟「也允許透過我的固定網域」。",
    disabled: "網頁授權已關閉。",
    token_rotated: "儀表板的 token 已變更：請重新登入。",
  },
};
const NAME = { en: (why: string) => `Not verified: ${why}`, "zh-TW": (why: string) => `未驗證：${why}` } as const;
const CASES = [
  { device: "phone", theme: "light", lang: "zh-TW" },
  { device: "phone", theme: "dark", lang: "en" },
  { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "desk", theme: "light", lang: "en" },
] as const;

const results: Array<{ name: string; ok: boolean; failed: string[] }> = [], geo: Record<string, unknown> = {};
const row = ".dock .webauth-row";
const tipShown = (page: any) => page.evaluate(`(() => { const t = document.querySelector(".dock .webauth-tip"); if (!t || t.hidden) return null;
  const r = t.getBoundingClientRect(); return r.height > 0 ? { text: t.textContent, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 } : null; })()`);
const free = (page: any) => page.evaluate(`(() => [document.getElementById("attachBtn"), document.getElementById("msgIn")].map((el) => {
  if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === el || el.contains(at)); }))()`);
async function shoot(page: any, name: string, tapped: boolean) {
  const box = await page.locator(".dock").boundingBox();
  const top = Math.max(0, box.y - (tapped ? 110 : 8));
  await page.screenshot({ path: shotPath(SMOKE, `${MODE}-${name}`, tapped ? "tapped" : "row"), clip: { x: 0, y: top, width: page.viewportSize().width, height: Math.min(page.viewportSize().height - top, box.y - top + box.height + 8) } });
}

for (const c of CASES) {
  const a = demoAccount();                                                    // no admin here: the server says not_admin
  const p = await freshPage(fx, c as any, { account: a });
  await mounted(p.page, 30000);
  const navEnd = p.errors.length;
  let served: string | null = null;
  await p.page.route("**/ui/authorization", async (route: any) => {
    if (served === null || route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "none", reason: served }) });
  });
  const phone = c.device === "phone";
  const tap = async (sel: string) => { const l = p.page.locator(sel).first(); if (phone) await l.tap(); else await l.click(); };
  for (const reason of REASONS) {
    served = reason === "not_admin" ? null : reason;
    await p.page.goto(`${fx.base}/ui/chat/${encodeURIComponent(CHAT)}`);
    await p.page.waitForSelector("#msgIn", { timeout: 15000 });
    await p.page.waitForSelector(`${row}[data-state="none"]`, { timeout: 10000 });
    await p.page.waitForTimeout(300);
    const name = `${c.device}-${c.theme}-${c.lang}-${reason}`, why = SAYS[c.lang][reason];
    await shoot(p.page, name, false);
    const chk: Record<string, boolean> = {};
    if (MODE === "before") {
      const note = p.page.locator(`${row} .note`).first();
      await (phone ? note.tap() : note.click());
      await p.page.waitForTimeout(300);
      chk.oldRowSaysWhyOnlyInTitle = (await note.getAttribute("title")) === why && (await tipShown(p.page)) === null;
      await shoot(p.page, name, true);
    } else {
      const btn = p.page.locator(`${row} button.webauth-why`).first();
      chk.rowSaysNotVerified = (await p.page.locator(row).first().innerText()).replace(/\s*·\s*(Settings|設定)$/, "").trim() === (c.lang === "en" ? "Not verified" : "未驗證");
      chk.accessibleName = (await btn.getAttribute("aria-label")) === NAME[c.lang](why);
      chk.hoverTitle = (await btn.getAttribute("title")) === why;
      chk.settingsLink = reason === "disabled" ? (await p.page.locator(`${row} a[href="/settings/access"]`).count()) === 1 : (await p.page.locator(`${row} a`).count()) === 0;
      if (!phone) { await btn.hover(); await p.page.waitForTimeout(300); chk.hoverOpensNoBubble = (await tipShown(p.page)) === null; }
      // A tap shows it; a second tap closes it.
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      const shown = await tipShown(p.page);
      chk.tapShowsReason = !!shown && shown.text === why && (await btn.getAttribute("aria-expanded")) === "true";
      chk.bubbleInsideViewport = !!shown && shown.inside;
      await shoot(p.page, name, true);
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      chk.secondTapCloses = (await tipShown(p.page)) === null;
      // A tap elsewhere (the thread) closes it.
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      const th = await p.page.locator(".thread").first().boundingBox();
      if (phone) await p.page.touchscreen.tap(th.x + th.width / 2, th.y + 40); else await p.page.mouse.click(th.x + th.width / 2, th.y + 40);
      await p.page.waitForTimeout(250);
      chk.tapElsewhereCloses = (await tipShown(p.page)) === null;
      // Escape closes it.
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      await p.page.keyboard.press("Escape"); await p.page.waitForTimeout(250);
      chk.escapeCloses = (await tipShown(p.page)) === null;
      // #2216: open, the bubble sits above the whole composer — Attach and the message box still take a tap, and a tap
      // in the box closes it; so does typing.
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      geo[name] = await p.page.evaluate(`(() => { const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
        return { tip: r(".dock .webauth-tip"), composer: r(".dock .composer"), attach: r("#attachBtn"), box: r("#msgIn") }; })()`);
      const g = geo[name] as any;
      chk.openCoversNothing = !!g.tip && !!g.composer && g.tip[3] <= g.composer[1] && (await free(p.page)).every(Boolean);
      await tap("#msgIn"); await p.page.waitForTimeout(250);
      chk.tapInBoxCloses = (await tipShown(p.page)) === null && await p.page.evaluate(`document.activeElement === document.getElementById("msgIn")`);
      await tap(`${row} button.webauth-why`); await p.page.waitForTimeout(250);
      await p.page.locator("#msgIn").focus();
      await p.page.keyboard.type("hello");
      chk.typingClosesIt = (await tipShown(p.page)) === null && (await p.page.inputValue("#msgIn")) === "hello";
      await p.page.fill("#msgIn", "");
    }
    chk.noErrors = p.errors.slice(navEnd).length === 0;
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    results.push({ name, ok: !failed.length, failed });
    console.log(`${failed.length ? "FAIL" : "ok  "} ${MODE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(p.errors.slice(navEnd)).slice(0, 400)}` : ""}`);
  }
  await p.ctx.close();
}
if (process.env.GEO) console.log(JSON.stringify(geo));
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${MODE}, ${results.length} cases)`);
await fx.close();
process.exit(bad.length ? 1 : 0);
