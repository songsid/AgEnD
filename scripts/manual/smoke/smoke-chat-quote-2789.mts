// M-2789: answer a long, multi-part message passage by passage — the real 「引用」 pill in a real headless Chrome on the
// shared smoke fixture (the product's own web server from an in-process FleetManager, a scratch home, loopback only —
// no fleet start, no network). Per case (desk/phone × light/dark × en/zh-TW; GATE=ci: desk-light-en + phone-dark-zh-TW):
//   - select a passage in one message (a Range: the browser's own selectionchange) → the pill: its words; desktop — its
//     pointer at the passage's end, not over the passage, BELOW its last line (M-2872) and clear of a simulated Edge
//     selection mini menu drawn above the selection's end; phone — inside the 16-px gutter, a clear gap above the
//     composer's whole box, not over the passage;
//   - M-2872 flip: the last line of the newest message at the thread's visible bottom → the pill above it when there is
//     no room below (the room measured and recorded);
//   - its click: the passage is in the composer as "> …" lines with the caret on the next line; the selection and the
//     pill are gone; desktop — the composer has the focus; phone — it does not (the keyboard stays down);
//   - repeat with two more passages, an answer typed under each: the composer holds all three in order; at its 240-px
//     cap it scrolls inside and shows the caret (the newest quote);
//   - send: /ui/send carries exactly the composer's text (the agent reads it as typed); the thread draws the quotes as
//     blockquotes;
//   - a selection across two messages, or in a message's header: no pill;
//   - SKEW (an open tab from before): the previous panel-chat.js (OLD_REF) with this server's modules — the chat works,
//     no pill, no error; this panel-chat.js with the previous app.css — the pill still works; the chat-quote.js from
//     before M-2872 (QUOTE_REF) with this server — the pill and the quote work (above the line: the "before" picture,
//     with the simulated Edge menu, its overlap recorded);
//   - no page error, no CSP report.
// Native long-press selection on a real phone can't be driven headless (the leader's ruling A is pinned in
// tests/web-chat-reply-ui-2272.test.ts); a real phone confirms it before a beta.
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [GATE=ci|full] [OLD_REF=d8dd79910^] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-chat-quote-2789.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-chat-quote-2789";
const REPO = process.env.REPO ?? process.cwd();
const GATE = process.env.GATE === "full" ? "full" : "ci";
// The SKEW legs compare with the page before the feature: on this (alpha) line, release/2.3.5-alpha just before #3556
// merged (its merge commit's parent) — a branch tip would already hold the feature once it landed. Main's is ea4de219c^.
const OLD_REF = process.env.OLD_REF ?? "d8dd79910^";
// M-2872's SKEW/"before" leg: chat-quote.js as this (alpha) line had it before the pill moved below the selection.
const QUOTE_REF = process.env.QUOTE_REF ?? "7dd2b0d07";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = { gate: GATE, oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const old = (path: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

const fx = await bootFixture({ port: Number(process.env.GATE_PORT ?? 48260), instances: 12 });
const name = fx.instances[4]!.name;
const now = Date.now();
const emit = (role: string, text: string, ago: number) => fx.fm.emitSseEvent("message", { instance: name, sender: role === "user" ? "Han 漢" : name, role, text, ts: new Date(now - ago).toISOString() });
const ASK = { en: "Three things for you to decide:\n1. Should we run a full rehearsal before the deploy? The b3 rig takes about 20 minutes.\n2. Should Notices get an unread count? The Hub keeps no read state yet.\n3. Should the Hub's name show under the brand on the sign-in page?",
  "zh-TW": "三個問題要你決定：\n1. 部署前要不要先跑一次完整的 rehearsal？上次 b3 的 rig 大概要 20 分鐘。\n2. Notices 要不要加未讀數字？目前 Hub 沒有記錄誰讀過。\n3. Hub 的名稱要不要顯示在登入頁的品牌下面？" };
const PASSAGES = { en: ["Should we run a full rehearsal before the deploy?", "Should the Hub's name show under the brand on the sign-in page?", "Should Notices get an unread count?"],
  "zh-TW": ["部署前要不要先跑一次完整的 rehearsal？", "Hub 的名稱要不要顯示在登入頁的品牌下面？", "Notices 要不要加未讀數字？"] };
const ANSWERS = { en: ["Yes, run the b3 one.", "Yes, one small line.", "Not now."], "zh-TW": ["要，跑 b3 那套。", "要，一行小字。", "先不用。"] };
emit("agent", ASK.en, 600_000);
emit("agent", ASK["zh-TW"], 540_000);

/** Select `passage` inside the message holding it (a Range: the page's selectionchange follows). */
const SELECT = `(passage) => {
  document.activeElement?.blur?.();                 // a drag in the thread takes the focus from the composer first
  const host = [...document.querySelectorAll(".msg[data-key]")].find((m) => (m.textContent || "").includes(passage));
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let node = null, at = -1;
  while (w.nextNode()) { const i = w.currentNode.data.indexOf(passage); if (i >= 0) { node = w.currentNode; at = i; break; } }
  const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + passage.length);
  // Out of the thread's visible box (later messages scrolled it away): bring it into view first, as a person would.
  const sc = document.querySelector(".scroller")?.getBoundingClientRect(), r0 = [...range.getClientRects()].filter((x) => x.width > 0);
  if (sc && r0.length && (r0[0].top < sc.top || r0[r0.length - 1].bottom > sc.bottom)) host.scrollIntoView({ block: "center" });
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const rects = [...range.getClientRects()].filter((x) => x.width > 0);
  return rects.map((x) => ({ left: x.left, right: x.right, top: x.top, bottom: x.bottom }));
}`;
const PILL = `() => {
  const p = document.querySelector(".quote-pop"); if (!p) return null;
  const b = p.getBoundingClientRect(), tip = p.querySelector(".quote-tip")?.getBoundingClientRect();
  let box = document.querySelector(".composer-box")?.getBoundingClientRect();
  return { text: p.textContent, left: b.left, right: b.right, top: b.top, bottom: b.bottom, h: b.height, tipX: tip ? tip.left + tip.width / 2 : null,
    vw: innerWidth, boxTop: box ? box.top : null, phone: p.classList.contains("is-phone") };
}`;
/** M-2872: a stand-in for Edge's selection mini menu (hide / … / copy / search), where Edge draws it: just above the
 * selection's end, centred on it. A page can't turn the real one off; the PNGs show the pill clear of it. */
const EDGE = `(r) => {
  document.getElementById("fake-edge-menu")?.remove();
  const m = document.createElement("div"); m.id = "fake-edge-menu"; m.textContent = "Edge menu (sim.) ⋯";
  const s = m.style; s.position = "fixed"; s.zIndex = "2147483647"; s.width = "132px"; s.height = "34px"; s.left = Math.round(r.right - 66) + "px";
  s.top = Math.round(r.top - 6 - 34) + "px"; s.display = "flex"; s.alignItems = "center"; s.justifyContent = "center"; s.font = "12px system-ui";
  s.background = "#2b2b2b"; s.color = "#f3f3f3"; s.borderRadius = "8px"; s.boxShadow = "0 4px 14px rgba(0,0,0,.35)"; s.pointerEvents = "none";
  document.body.append(m); const b = m.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
}`;
const covers = (a: any, z: any) => Math.min(a.right, z.right) > Math.max(a.left, z.left) && Math.min(a.bottom, z.bottom) > Math.max(a.top, z.top);

const CASES = GATE === "full" ? matrix("full") : matrix("desk-light-en,phone-dark-zh-TW");
const started = Date.now();
try {
  for (const c of CASES) {
    const cn = caseName(c), phone = c.device === "phone", L = c.lang;
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const sends: string[] = [];
    await page.route("**/ui/send", async (route: any) => { try { sends.push(JSON.parse(route.request().postData() || "{}").message ?? ""); } catch { /* not JSON */ } await route.continue(); });
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
    await page.waitForSelector(".msg[data-key]", { timeout: 20000 }); await page.waitForTimeout(1200);
    if (phone) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const quote = async (i: number, tag: string) => {
      const rects = await page.evaluate(`(${SELECT})(${JSON.stringify(PASSAGES[L][i])})`) as any[];
      await page.waitForSelector(".quote-pop", { timeout: 3000 }).catch(() => {});
      const pill = await page.evaluate(`(${PILL})()`) as any;
      const last = rects[rects.length - 1];
      const menu = phone ? null : await page.evaluate(`(${EDGE})(${JSON.stringify(last)})`) as any;
      await page.screenshot({ path: shotPath(SMOKE, cn, `${tag}-select`) });
      if (menu) {
        await page.evaluate(() => document.getElementById("fake-edge-menu")?.remove());
        check(`${cn}:${tag}:below-clear-of-edge-menu`, !!pill && pill.top >= last.bottom && !covers(pill, menu), { pill, last, menu });
      }
      const words = L === "zh-TW" ? (phone ? "引用選取的文字" : "引用") : (phone ? "Quote selection" : "Quote");
      check(`${cn}:${tag}:pill`, !!pill && pill.text === words && pill.phone === phone && !rects.some((z) => covers(pill, z))
        && (phone ? pill.left >= 16 && pill.right <= pill.vw - 16 + 1 && pill.boxTop !== null && (pill.bottom <= pill.boxTop - 8 || pill.top < last.top)
          : pill.tipX !== null && Math.abs(pill.tipX - last.right) <= 12), { pill, last });
      if (!pill) return;
      await page.click(".quote-pop .quote-pick");
      await page.waitForTimeout(250);
      const after = await page.evaluate(`(() => { const el = document.getElementById("msgIn"); return { value: el.value, caret: el.selectionStart, focused: document.activeElement === el,
        sel: String(getSelection()), pill: !!document.querySelector(".quote-pop"), shown: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 }; })()`) as any;
      return after;
    };
    // 1: the first passage, then an answer typed under it.
    const a1 = await quote(0, "1");
    check(`${cn}:1:inserted`, !!a1 && a1.value === `> ${PASSAGES[L][0]}\n` && a1.caret === a1.value.length && a1.sel === "" && !a1.pill && a1.focused === !phone, a1);
    const typeAnswer = async (text: string) => {
      await page.focus("#msgIn"); await page.keyboard.type(text);
      if (phone) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());   // a tap back on the thread
    };
    await typeAnswer(ANSWERS[L][0]);
    // 2 and 3: two more passages, each answered — the composer the user asked for.
    const a2 = await quote(1, "2");
    await typeAnswer(ANSWERS[L][1]);
    const a3 = await quote(2, "3");
    await typeAnswer(ANSWERS[L][2]);
    const want = `> ${PASSAGES[L][0]}\n${ANSWERS[L][0]}\n\n> ${PASSAGES[L][1]}\n${ANSWERS[L][1]}\n\n> ${PASSAGES[L][2]}\n${ANSWERS[L][2]}`;
    const box = await page.evaluate(`(() => { const el = document.getElementById("msgIn"); return { value: el.value, h: el.clientHeight, sh: el.scrollHeight, top: el.scrollTop }; })()`) as any;
    check(`${cn}:repeat`, !!a2 && !!a3 && a3.shown && box.value === want && box.h <= 240, { a2, a3, box: { ...box, value: box.value.slice(0, 200) } });
    await page.screenshot({ path: shotPath(SMOKE, cn, "4-composer") });
    // Not a passage: across two messages; a message's header.
    const none = await page.evaluate(`(() => {
      const msgs = [...document.querySelectorAll(".msg[data-key] .md")]; const sel = getSelection(); const r = document.createRange();
      const textIn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); };
      const a = textIn(msgs[msgs.length - 2]), b = textIn(msgs[msgs.length - 1]);
      r.setStart(a, 0); r.setEnd(b, Math.min(2, b.data.length));
      sel.removeAllRanges(); sel.addRange(r);
      return new Promise((ok) => setTimeout(() => { const across = !!document.querySelector(".quote-pop");
        const meta = document.querySelector(".msg[data-key] .meta .sender"); const r2 = document.createRange(); r2.selectNodeContents(meta); sel.removeAllRanges(); sel.addRange(r2);
        setTimeout(() => { ok({ across, meta: !!document.querySelector(".quote-pop") }); sel.removeAllRanges(); }, 300); }, 300));
    })()`) as any;
    check(`${cn}:not-a-passage`, !none.across && !none.meta, none);
    if (phone) {
      // Real touch input (CDP Input.dispatchTouchEvent, the browser's own pointer/touch/hit-test pipeline on the real layout):
      // #3555 review P2-2 — a long press on a glyph of a message's words opens no menu; one on the blank part of a short
      // line inside the same paragraph box opens #2272's menu. P2-1 — a touch scroll (pointercancel, no pointerup) leaves
      // no stale press: the next selection has its pill. Native text selection itself stays a real-phone check.
      const cdp = await ctx.newCDPSession(page);
      const touch = async (type: string, x?: number, y?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y }] });
      const spots = await page.evaluate(`(() => {
        const md = [...document.querySelectorAll(".msg[data-key] .md")].find((m) => (m.textContent || "").includes(${JSON.stringify(PASSAGES[L][2].slice(0, 6))}));
        const li = [...md.querySelectorAll("li")].find((x) => x.textContent.includes(${JSON.stringify(PASSAGES[L][2].slice(0, 6))})) || md;
        li.scrollIntoView({ block: "center" });
        const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT); const t = w.nextNode(); const r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 2);
        const g = r.getBoundingClientRect(); const rects = [...(() => { const a = document.createRange(); a.selectNodeContents(li); return a.getClientRects(); })()];
        const last = rects[rects.length - 1], box = md.getBoundingClientRect();
        return { glyph: { x: g.left + g.width / 2, y: g.top + g.height / 2 }, blank: { x: Math.min(box.right - 8, last.right + 40), y: last.top + last.height / 2, room: box.right - last.right } };
      })()`) as any;
      const longPress = async (p: { x: number; y: number }) => {
        await page.evaluate(() => { document.querySelectorAll(".msg-menu").forEach((m) => m.remove()); getSelection()?.removeAllRanges(); });
        await touch("touchStart", p.x, p.y); await page.waitForTimeout(700);
        const menu = await page.evaluate(`!!document.querySelector(".msg-menu:not(.quote-pop)")`) as boolean;
        await touch("touchEnd"); await page.waitForTimeout(200);
        await page.keyboard.press("Escape").catch(() => {});
        return menu;
      };
      const onGlyph = await longPress(spots.glyph), onBlank = spots.blank.room > 40 ? await longPress(spots.blank) : null;
      check(`${cn}:long-press-words-vs-blank`, onGlyph === false && (onBlank === null || onBlank === true), { spots, onGlyph, onBlank });
      // A touch scroll that starts on a message: down, a move, up — Chrome cancels the pointer (pointercancel), no pointerup.
      await page.evaluate(() => { (window as any).__pe = []; for (const k of ["pointerdown", "pointerup", "pointercancel"]) document.addEventListener(k, () => (window as any).__pe.push(k), true); });
      const sx = spots.glyph.x, sy = spots.glyph.y;
      await touch("touchStart", sx, sy); for (const d of [8, 20, 40, 70]) await touch("touchMove", sx, sy - d); await touch("touchEnd"); await page.waitForTimeout(300);
      const pe = await page.evaluate("window.__pe") as string[];
      await page.evaluate(`(${SELECT})(${JSON.stringify(PASSAGES[L][0])})`); await page.waitForTimeout(500);
      const pillAfter = await page.evaluate("!!document.querySelector('.quote-pop')") as boolean;
      check(`${cn}:after-touch-scroll`, pe.includes("pointerdown") && pe.includes("pointercancel") && !pe.includes("pointerup") && pillAfter, { pe, pillAfter });
      await page.evaluate(() => { getSelection()?.removeAllRanges(); document.querySelectorAll(".quote-pop").forEach((x) => x.remove()); });
    }
    // Send: exactly the composer's text; the thread draws the quotes.
    if (phone) await page.click("#sendBtn");
    else { await page.focus("#msgIn"); await page.keyboard.press("Enter"); }
    await page.waitForTimeout(1500);
    const drawn = await page.evaluate(`(() => { const m = [...document.querySelectorAll(".msg.user")].pop(); return m ? m.querySelectorAll(".md blockquote").length : -1; })()`);
    await page.screenshot({ path: shotPath(SMOKE, cn, "5-sent") });
    check(`${cn}:sent`, sends.length === 1 && sends[0] === want && Number(drawn) >= 3, { sends: sends.map((s) => s.slice(0, 120)), drawn });
    const cspNow = await csp();
    check(`${cn}:no-errors`, errs.length === 0 && cspNow.length === 0, { errs, csp: cspNow });
    await ctx.close();
  }
  // M-2872 flip: the newest message's last line sits at the thread's visible bottom → no room below → the pill above it.
  {
    const c: MatrixCase = { device: "desk", theme: "light", lang: "en" };
    // Enough later messages for the thread to scroll, then one in the middle scrolled so its line is at the visible bottom edge.
    for (let i = 0; i < 8; i++) emit("agent", `Status ${i + 1}: rehearsal leg ${i + 1} passed; nothing waits on you here.`, 500_000 - i * 1000);
    const FLIP = "Status 6: rehearsal leg 6 passed";
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
    await page.waitForSelector(".msg[data-key]", { timeout: 20000 }); await page.waitForTimeout(1200);
    await page.evaluate(`((passage) => {
      const host = [...document.querySelectorAll(".msg[data-key]")].find((m) => (m.textContent || "").includes(passage));
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let node = null, at = -1;
      while (w.nextNode()) { const i = w.currentNode.data.indexOf(passage); if (i >= 0) { node = w.currentNode; at = i; break; } }
      const rg = document.createRange(); rg.setStart(node, at); rg.setEnd(node, at + passage.length);
      const sc = document.querySelector(".scroller"), rs = [...rg.getClientRects()].filter((x) => x.width > 0);
      sc.scrollTop += rs[rs.length - 1].bottom - (sc.getBoundingClientRect().bottom - 8);
    })(${JSON.stringify(FLIP)})`);
    await page.waitForTimeout(400);
    const rects = await page.evaluate(`(${SELECT})(${JSON.stringify(FLIP)})`) as any[];
    await page.waitForSelector(".quote-pop", { timeout: 3000 }).catch(() => {});
    const pill = await page.evaluate(`(${PILL})()`) as any;
    const last = rects[rects.length - 1];
    const room = await page.evaluate(`(() => { const s = document.querySelector(".scroller").getBoundingClientRect(); return Math.min(innerHeight, s.bottom) - ${last.bottom}; })()`) as number;
    const menu = await page.evaluate(`(${EDGE})(${JSON.stringify(last)})`) as any;
    await page.screenshot({ path: shotPath(SMOKE, "desk-light-en", "flip-select") });
    const need = pill ? pill.h + 14 : 0;
    r.flipRoom = { room, need, sc: await page.evaluate(`(() => { const s = document.querySelector(".scroller"); const b = s.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, sh: s.scrollHeight, ch: s.clientHeight, st: s.scrollTop, msgs: document.querySelectorAll(".msg[data-key]").length }; })()`) };
    // Too little room below → above (pointer down); enough → below. Either way never over the passage.
    const ok = !!pill && !rects.some((z) => covers(pill, z)) && (room < need ? pill.bottom <= last.top : pill.top >= last.bottom);
    check("flip:placement", ok, { pill, last, room, need, menu });
    check("flip:exercised-above", room < need, { room, need });
    const cspNow = await csp();
    check("flip:no-errors", errs.length === 0 && cspNow.length === 0, { errs, csp: cspNow });
    await ctx.close();
  }
  // SKEW: the previous panel-chat.js with this server — no pill, no error; this panel-chat.js with the previous app.css — the pill works.
  const oldPanel = old("src/ui/panel-chat.js"), oldCss = old("src/ui/shared/app.css");
  let oldQuote: string | null = null;
  try { oldQuote = execFileSync("git", ["-C", REPO, "show", `${QUOTE_REF}:src/ui/chat-quote.js`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { /* none */ }
  for (const [leg, file, body] of [["old-panel", "/ui/js/panel-chat.js", oldPanel], ["old-css", "/assets/app.css", oldCss], ["old-quote", "/ui/js/chat-quote.js", oldQuote]] as const) {
    if (!body) { check(`skew:${leg}`, false, `no ${file} at ${OLD_REF}`); continue; }
    const c: MatrixCase = { device: "desk", theme: "light", lang: "en" };
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.route(`**${file}`, (route: any) => route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css" : "application/javascript", body }));
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
    await page.waitForSelector(".msg[data-key]", { timeout: 20000 }); await page.waitForTimeout(1000);
    const srects = await page.evaluate(`(${SELECT})(${JSON.stringify(PASSAGES.en[0])})`) as any[]; await page.waitForTimeout(500);
    const pill = await page.evaluate("!!document.querySelector('.quote-pop')");
    if (leg === "old-quote" && pill) {
      // The "before" picture: the pill above the line, next to where Edge draws its own menu.
      const box = await page.evaluate(`(${PILL})()`) as any, sl = srects[srects.length - 1];
      const menu = await page.evaluate(`(${EDGE})(${JSON.stringify(sl)})`) as any;
      await page.screenshot({ path: shotPath(SMOKE, "skew", "old-quote-before-with-edge-menu") });
      await page.evaluate(() => document.getElementById("fake-edge-menu")?.remove());
      r.beforeOverlapsEdgeMenu = { overlaps: covers(box, menu), above: box.bottom <= sl.top, pill: box, menu };
    }
    let value = "";
    if (pill) { await page.click(".quote-pop .quote-pick"); await page.waitForTimeout(250); value = await page.evaluate("document.getElementById('msgIn').value") as string; }
    await page.screenshot({ path: shotPath(SMOKE, "skew", leg) });
    const cspNow = await csp();
    check(`skew:${leg}`, errs.length === 0 && cspNow.length === 0 && (leg === "old-panel" ? !pill : pill && value === `> ${PASSAGES.en[0]}\n`), { pill, value, errs, csp: cspNow });
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 700)}`);
  console.log(fail.length ? `M-2789 smoke FAILED (${fail.length}) in ${r.seconds}s — ${OUT}` : `M-2789 smoke passed in ${r.seconds}s (${Object.keys(r).length - 3} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
