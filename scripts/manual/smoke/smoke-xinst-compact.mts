// The user (hmsg-d6ac6dfb): 「想要再把網頁版的 send to instance 占的空間縮小 顯示只想留看到兩行」 — a cross-instance line
// (a status line: "A → B:" and the message) folded to two lines: the header and the first line, each one row with an
// ellipsis, no faded row, no separate link row; one click opens it (its small button at the end of line 2, or the text),
// keyboard and screen reader included; Show less folds it again.
// The lines are put in the real chat history (FleetManager.emitSseEvent "message", role status — the fleet's own path
// for another instance's message). Signed in as the operator through /signin. Per case (phone 390 touch / desk 1366,
// light / dark, en / zh-TW):
//   - the long line is folded: its text box is two rows tall, line 2 clipped with an ellipsis, its button on line 2;
//   - a two-line message stays open (no button);
//   - the button opens it (all rows, "Show less" / 收合, aria-expanded true) and folds it again;
//   - a click on the text opens it; Tab to the button and Enter opens it;
//   - no horizontal page scroll on a phone; no page error.
// MODE=before shoots the line as main draws it (no checks). PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-xinst-compact.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-xinst-compact";
const MODE = process.env.MODE === "before" ? "before" : "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48780), classic: false, instances: 6 });
const fm = fx.fm;
const CHAT = Object.keys(fm.fleetConfig.instances).find((n: string) => !fm.fleetConfig.instances[n].general_topic)!;
const LONG = [
  "Weaver → rd1-web-dev-claude-t695268:",
  "補充給 cid-1793608048938-h1813m 的 B（item 15 API 金鑰）用：這是共用後台正式機 ApiKeyGuard log 的呼叫端盤點，依來源 IP 與 key 前綴分組。",
  "1. 10.2.3.4 — key ak_live_7f… — 1,204 次／日",
  "2. 10.2.3.9 — key ak_live_19… — 311 次／日",
  "3. 172.16.0.12 — 沒帶 key（被擋）— 88 次／日",
  "",
  "請依這份清單確認哪些呼叫端要換新金鑰。",
  "— Weaver",
].join("\n");
const SHORT = "Weaver → rd1-web-dev-claude-t695268:\nreceived, thanks";
const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
fm.emitSseEvent("message", { instance: CHAT, sender: "agend-weaver", role: "status", text: LONG, ts: at(3) });
fm.emitSseEvent("message", { instance: CHAT, sender: "agend-weaver", role: "status", text: SHORT, ts: at(2) });
// #2933 review (Prism): two lines whose second wraps at the drawn width — 80 CJK characters (wraps on a phone and a
// desk) and 40 (fits a desk, wraps on a phone); and a CRLF message.
const CJK80 = "Weaver → worker:\n" + "這是一段沒有換行的中文說明文字，用來檢查兩行的訊息在窄的畫面上會不會超過兩行而且沒有展開的按鈕可以按。".repeat(2).slice(0, 80);
const CJK40 = "Weaver → worker:\n" + "這是一段沒有換行的中文說明，桌面放得下但手機放不下的長度，剛好四十個字。".slice(0, 40);
fm.emitSseEvent("message", { instance: CHAT, sender: "agend-weaver", role: "status", text: CJK80, ts: at(1.8) });
fm.emitSseEvent("message", { instance: CHAT, sender: "agend-weaver", role: "status", text: CJK40, ts: at(1.6) });
fm.emitSseEvent("message", { instance: CHAT, sender: "agend-weaver", role: "status", text: "Weaver → worker:\r\nfirst\r\nsecond\r\nthird", ts: at(1.4) });
fm.emitSseEvent("message", { instance: CHAT, sender: CHAT, role: "agent", text: "OK — I'll check the callers against that list.", ts: at(1) });

const CASES = [
  { device: "phone", theme: "light", lang: "zh-TW" },
  { device: "phone", theme: "dark", lang: "en" },
  { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "desk", theme: "light", lang: "en" },
] as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
for (const c of CASES) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const p = await freshPage(fx, c as any, { account: "operator", path: `/ui/chat/${encodeURIComponent(CHAT)}` });
  await mounted(p.page, 30000);
  await p.page.waitForSelector(".msg.status-line", { timeout: 15000 });
  await p.page.waitForTimeout(600);
  const long = p.page.locator(".msg.status-line").first();
  await long.scrollIntoViewIfNeeded();
  await long.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-folded`) });
  if (MODE === "before") { results.push({ name: `${c.device}-${c.theme}-${c.lang}`, ok: true, failed }); await p.ctx.close(); continue; }
  const geo = () => long.evaluate((m: Element) => {
    const t = m.querySelector(".st-text")!, b = m.querySelector(".st-more")!, rows = [...m.querySelectorAll(".st-ln")] as HTMLElement[];
    const lh = parseFloat(getComputedStyle(rows[0]!).lineHeight) || 20, tr = t.getBoundingClientRect(), br = b.getBoundingClientRect();
    const shown = rows.filter(r => r.offsetParent !== null);
    return { folded: m.classList.contains("folded"), textH: tr.height, lh, shown: shown.length,
      clipped: shown.length > 1 && shown[1]!.scrollWidth > shown[1]!.clientWidth && getComputedStyle(shown[1]!).textOverflow === "ellipsis",
      btnOnLine2: Math.abs(br.bottom - tr.bottom) <= lh * 0.8 && br.left >= tr.right - 2, label: b.textContent,
      // Its label whole, and inside the message with room to spare (not flush with its edge).
      // (the label's own glyphs: a Range over its text — the button's box includes its padding)
      btnWhole: (() => { const r = document.createRange(); r.selectNodeContents(b); return b.scrollWidth <= (b as HTMLElement).clientWidth + 1 && r.getBoundingClientRect().right <= m.getBoundingClientRect().right - 4; })(),
      btnGeo: (() => { const r = document.createRange(); r.selectNodeContents(b); return `label ends ${r.getBoundingClientRect().right.toFixed(0)}, msg ${m.getBoundingClientRect().right.toFixed(0)} (scroll ${b.scrollWidth}/${(b as HTMLElement).clientWidth})`; })(), aria: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded") };
  });
  const g = await geo();
  const zh = c.lang === "zh-TW";
  need(g.folded && g.shown === 2 && g.textH <= g.lh * 2.4, `two rows (shown ${g.shown}, ${g.textH.toFixed(0)}px for line height ${g.lh})`);
  need(g.clipped, "line 2 clipped with an ellipsis");
  need(g.btnOnLine2, "its button at the end of line 2");
  need(g.btnWhole, `its label whole, not flush with the message's edge (${g.btnGeo})`);
  need(g.label === (zh ? "全部 8 行" : "All 8 lines") && g.aria === (zh ? "展開全部 8 行" : "Show all 8 lines") && g.expanded === "false", `label ${g.label} / ${g.aria} / ${g.expanded}`);
  const short = p.page.locator(".msg.status-line").nth(1);
  need(!(await short.evaluate((m: Element) => m.classList.contains("overflows"))) && !(await short.locator(".st-more").isVisible()), "a two-line message that fits has no control");
  // The button opens it, and folds it again.
  const btn = long.locator(".st-more");
  if (c.device === "phone") await btn.tap(); else await btn.click();
  await p.page.waitForTimeout(200);
  const open = await geo();
  need(!open.folded && open.shown === 8 && open.label === (zh ? "收合" : "Show less") && open.expanded === "true", `opened: ${open.shown} rows, ${open.label}, ${open.expanded}`);
  await long.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-open`) });
  if (c.device === "phone") await btn.tap(); else await btn.click();
  await p.page.waitForTimeout(200);
  need((await geo()).folded, "Show less folds it again");
  // A click on the text opens it.
  const row2 = long.locator(".st-ln").nth(1);
  if (c.device === "phone") await row2.tap(); else await row2.click();
  await p.page.waitForTimeout(200);
  need(!(await geo()).folded, "a click on the text opens it");
  if (c.device === "phone") await btn.tap(); else await btn.click();
  await p.page.waitForTimeout(200);
  // Keyboard: focus the button, Enter.
  await btn.focus(); await p.page.keyboard.press("Enter"); await p.page.waitForTimeout(200);
  need(!(await geo()).folded, "Enter on the focused button opens it");
  if (c.device === "phone") need(await p.page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "no horizontal scroll");
  // #2933 review: 80 CJK characters on line 2 — two rows and its control, phone and desk alike.
  const cjk80 = p.page.locator(".msg.status-line").nth(2);
  const fit = (loc: any) => loc.evaluate((m: Element) => { const t = m.querySelector(".st-text")!, b = m.querySelector(".st-more") as HTMLElement;
    const lh = parseFloat(getComputedStyle(m.querySelector(".st-ln")!).lineHeight) || 20;
    return { rows: Math.round(t.getBoundingClientRect().height / lh), control: !!b && b.offsetParent !== null, overflows: m.classList.contains("overflows") }; });
  const f80 = await fit(cjk80);
  need(f80.rows === 2 && f80.control, `80 CJK characters: ${f80.rows} rows, control ${f80.control}`);
  await cjk80.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-cjk80`) });
  // 40 CJK characters: a desk fits them (no control); narrowed to a phone they are clipped (control); widened again, none.
  const cjk40 = p.page.locator(".msg.status-line").nth(3);
  if (c.device === "desk") {
    const wide = await fit(cjk40);
    await p.page.setViewportSize({ width: 390, height: 844 }); await p.page.waitForTimeout(400);
    const narrow = await fit(cjk40);
    await p.page.setViewportSize({ width: 1366, height: 900 }); await p.page.waitForTimeout(400);
    const back = await fit(cjk40);
    need(wide.rows === 2 && !wide.control && narrow.rows === 2 && narrow.control && !back.control, `resize: desk ${JSON.stringify(wide)} → 390 ${JSON.stringify(narrow)} → desk ${JSON.stringify(back)}`);
  } else {
    const ph = await fit(cjk40);
    need(ph.rows === 2 && ph.control, `40 CJK characters on a phone: ${JSON.stringify(ph)}`);
  }
  // A CRLF message: four rows of text, no doubled line breaks.
  const crlf = await p.page.locator(".msg.status-line").nth(4).evaluate((m: Element) => ({ rows: [...m.querySelectorAll(".st-ln")].map(r => r.textContent), cr: m.querySelector(".st-text")!.textContent!.includes("\r") }));
  need(JSON.stringify(crlf.rows) === JSON.stringify(["Weaver → worker:", "first", "second", "third"]) && !crlf.cr, `CRLF rows ${JSON.stringify(crlf)}`);
  // A two-line message that fits is plain (no control).
  const plain = await fit(p.page.locator(".msg.status-line").nth(1));
  need(!plain.control && plain.rows === 2, `two short lines plain: ${JSON.stringify(plain)}`);
  need(p.errors.length === 0, `no page error: ${p.errors.slice(0, 2).join(" / ")}`);
  results.push({ name: `${c.device}-${c.theme}-${c.lang}`, ok: !failed.length, failed });
  await p.ctx.close();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
