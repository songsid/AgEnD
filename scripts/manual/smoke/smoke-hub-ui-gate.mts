// The AgEnD UI gate on the Hub's pages (cid-hub-shell-parity; the user: 「agend 排得很好看, agend hub 醜到不行」). The Hub's
// shell is the fleet dashboard's (style guide rule 1), checked in a real headless Chrome on a REAL Hub web listener
// (createHubHttp's handle() behind node:https on 127.0.0.1, the shared S5 fakes of tests/helpers/hub-s3b-rig.ts, a fake
// directory; no fleet runs, no network), the administrator signed in. Per case:
//   - sidebar:  the dashboard's sidebar — a one-line brand ("AgEnD Hub", the Hub's name its tooltip); the nav as side-row
//               rows, each with its icon, one height, one left inset, exactly one marked current; Search (with its Ctrl K
//               hint on a wide screen) and New chat as side-rows (no bordered pill, no old Hub brand line); the conversation
//               list under its section label, its empty state one line; the foot (Settings, the session row) at the bottom;
//               Notices with no count (the Hub has no read state); the session menu opens on the screen (upward);
//   - pages:    Chats, My shared agents, Administration and Notices — each page's own cards share one frame; one height per
//               button kind; nothing past the content column or the page; no coloured left edge on a rounded box; the
//               dashboard's page head (PanelHeader) on every page but the chat; the security notices card in the page's
//               column (the cards' own edges), never full-bleed above a chat;
//   - Hub-only: the page asks the Hub for nothing but /hub/v1/*, /assets/*, its own /ui/js modules and its pages;
//   - no page error, no CSP report.
// The Notices page needs a Hub that offers its security notices: the rig composes none, so the session's capability mark and
// the notices are answered in the browser (page.route) — the page itself is the product's.
// GATE=ci (the CI job): desk light en + phone dark zh-TW. GATE=full (local): desk/phone × light/dark × en/zh-TW.
// Pictures of every page land in OUT/smoke-hub-ui-gate (a failing CI run uploads them).
//   PW_DIR=<dir with playwright-core> (or node_modules) REPO=<checkout> OUT=<dir> [GATE=ci|full] [CHROME=<chrome binary>] \
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-hub-ui-gate.mts
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { caseName, matrix, shotPath, VIEWPORTS, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-hub-ui-gate";
const REPO = process.env.REPO ?? process.cwd();
const PW = process.env.PW_DIR ?? REPO;
const GATE = process.env.GATE === "full" ? "full" : "ci";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const CASES: MatrixCase[] = GATE === "full" ? matrix("full") : matrix("desk-light-en,phone-dark-zh-TW");
const r: Record<string, unknown> = { gate: GATE };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
// What the Hub's own listener serves under /ui/js (the authority — the page may ask for nothing else there).
const { HUB_UI_MODULES } = await import(REPO + "/src/hub/http/compose.ts") as { HUB_UI_MODULES: readonly string[] };
const allowed = (path: string) => /^\/(hub\/v1\/|assets\/|ui\/hub|favicon)/.test(path) || (path.startsWith("/ui/js/") && HUB_UI_MODULES.includes(path.slice(7)));
const port = 48700 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
const keys = mkdtempSync(join(OUT, "keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
// The world: olivia's fleet publishes two agents (the administrator sees them in Administration).
const olivia = rig.addPerson("olivia", "Olivia Chen");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia);
const exposure = (id: string, name: string) => ({ id, fleetId, owner: olivia, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
await http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [exposure(randomUUID(), "Sales numbers"), exposure(randomUUID(), "Design guide")] }, link) as never, link);
// One retained security notice for the Notices page (the DTO the Hub's notice stream sends).
const NOTICE = { id: randomUUID(), label: "Olivia's laptop", at: Date.now() - 3_600_000, fleetId, generation: 1, revoked: false };

/** The sidebar as drawn (the drawer open on a phone). */
const SIDEBAR = `(() => {
  const sb = document.querySelector("#sidebar");
  if (!sb) return { missing: true };
  const vis = (el) => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0; };
  const brand = sb.querySelector(".side-head .brand");
  const bs = brand && getComputedStyle(brand);
  const rows = [...sb.querySelectorAll(".side-nav > .side-row")].filter(vis).map((el) => {
    const b = el.getBoundingClientRect(), icon = el.querySelector("svg.icon"), ib = icon && icon.getBoundingClientRect();
    return { text: (el.querySelector(".grow")?.textContent || "").trim(), h: Math.round(b.height), iconX: ib ? Math.round(ib.left - b.left) : null,
      current: el.matches(".active"), count: !!el.querySelector(".nav-count"), kbd: (el.querySelector("kbd")?.textContent || "").trim(), cls: el.className };
  });
  const foot = sb.querySelector(".side-foot"), fb = foot && foot.getBoundingClientRect();
  const footRows = foot ? [...foot.querySelectorAll(".side-row")].filter(vis).map((el) => Math.round(el.getBoundingClientRect().height)) : [];
  const label = sb.querySelector(".hub-side-rooms .inst-head .side-label");
  const empty = sb.querySelector(".hub-side-rooms .side-empty");
  const lines = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size; };
  return {
    brand: brand ? { text: brand.textContent.trim(), title: brand.getAttribute("title"), lines: lines(brand), weight: bs.fontWeight } : null,
    rows, foot: fb ? { bottomGap: Math.round(sb.getBoundingClientRect().bottom - fb.bottom), rows: footRows, prefs: !!foot.querySelector(".hub-prefs"), session: !!foot.querySelector(".hub-session-row") } : null,
    label: label ? label.textContent.trim() : null, empty: empty ? { text: empty.textContent.trim(), lines: lines(empty) } : null,
    legacy: [...sb.querySelectorAll(".hub-new, .hub-brand-name, .empty-hint, .hub-list-empty")].filter(vis).map((el) => el.className),
  };
})()`;

/** The page as drawn: its head, overflow, its cards' frames, its buttons, left accents (as the Settings gate measures). */
const PAGE = `(() => {
  const panel = document.querySelector("main .p-hub") || document.querySelector(".p-hub");
  const body = panel && panel.querySelector(".panel-body");
  if (!body) return { missing: true };
  const cb = body.getBoundingClientRect();
  const vis = (el) => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0 && !el.closest("[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const path = (el) => { const p = []; for (let e = el; e && e !== body && p.length < 3; e = e.parentElement) p.unshift(name(e)); return p.join(" > "); };
  const over = [];
  for (const el of body.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect();
    let clipped = false;
    for (let a = el.parentElement; a && a !== body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible") { clipped = a.getBoundingClientRect().right <= cb.right + 1; break; } }
    if (!clipped && b.right > cb.right + 1) over.push(path(el) + " +" + Math.round(b.right - cb.right));
  }
  const inBox = (el) => !!el.parentElement.closest("details, dialog");
  const cards = [...body.querySelectorAll(".card")].filter((el) => vis(el) && !inBox(el))
    .map((el) => { const s = getComputedStyle(el); return { el: path(el), frame: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft, s.borderTopWidth, s.borderTopStyle, s.borderTopLeftRadius].join(" ") }; });
  const kinds = {};
  for (const el of body.querySelectorAll("button, a.btn")) {
    if (!vis(el) || el.closest("nav, [role=tablist], .s-row, dialog, .hub-composer")) continue;
    const cls = String(el.className || "").split(/\\s+/).filter((c) => /^(btn|icon-btn)/.test(c)).sort().join(".");
    if (!cls) continue;
    const h = Math.round(el.getBoundingClientRect().height);
    const row = el.parentElement, peers = row ? [...row.querySelectorAll(":scope > select, :scope > input, :scope > label select, :scope > label input")] : [];
    if (peers.some((f) => vis(f) && Math.abs(Math.round(f.getBoundingClientRect().height) - h) <= 1)) continue;
    (kinds[cls] ||= {})[h] = (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24);
  }
  const painted = (c) => { if (!c || c === "transparent") return false; let m = /\\/\\s*([\\d.]+)(%?)\\s*\\)$/.exec(c); if (!m && c.startsWith("rgba(")) m = /,\\s*([\\d.]+)(%?)\\s*\\)$/.exec(c); return !m || parseFloat(m[1]) / (m[2] ? 100 : 1) > 0; };
  const accents = [];
  for (const el of body.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el), lw = parseFloat(s.borderLeftWidth) || 0;
    if (lw < 2 || s.borderLeftStyle === "none" || !painted(s.borderLeftColor)) continue;
    const edge = lw > (parseFloat(s.borderTopWidth) || 0) || s.borderLeftColor !== s.borderTopColor;
    const round = (parseFloat(s.borderTopLeftRadius) || 0) > 0 || (parseFloat(s.borderBottomLeftRadius) || 0) > 0;
    if (edge && round) accents.push(path(el) + " " + s.borderLeftWidth + " r" + s.borderTopLeftRadius);
  }
  // The security notices card: in the page's column (the cards' own edges) on a page; inset from the edges above a chat.
  const align = [];
  for (const n of body.querySelectorAll(".hub-security-notices")) {
    if (!vis(n)) continue;
    const nb = n.getBoundingClientRect();
    const col = [...body.querySelectorAll(":scope > .col")].find((c) => !c.contains(n) && vis(c));
    if (col) { const s = getComputedStyle(col), b = col.getBoundingClientRect(), l = b.left + parseFloat(s.paddingLeft), r = b.right - parseFloat(s.paddingRight);
      if (Math.abs(nb.left - l) > 1 || Math.abs(nb.right - r) > 1) align.push("off the column " + [Math.round(nb.left - l), Math.round(nb.right - r)]); }
    else if (nb.left < cb.left + 8 || nb.right > cb.right - 8) align.push("full-bleed " + [Math.round(nb.left - cb.left), Math.round(cb.right - nb.right)]);
  }
  const head = panel.querySelector(":scope > header.panel-head h1");
  return { align, head: head ? head.textContent.trim() : null, over: over.slice(0, 8), overCount: over.length, cards, kinds, accents: accents.slice(0, 8),
    pageX: document.documentElement.scrollWidth - innerWidth };
})()`;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const started = Date.now();
const PAGES = [
  { key: "chats", path: "/ui/hub", current: { en: "Chats", "zh-TW": "對話" }, head: false },
  { key: "mine", path: "/ui/hub/exposures", current: { en: "My shared agents", "zh-TW": "我分享的 Agent" }, head: true },
  { key: "admin", path: "/ui/hub/admin", current: { en: "Administration", "zh-TW": "管理" }, head: true },
  { key: "notices", path: "/ui/hub?view=notices", current: { en: "Notices", "zh-TW": "通知" }, head: true },
] as const;
try {
  for (const c of CASES) {
    const cn = caseName(c), phone = c.device === "phone";
    const ctx = await browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
      isMobile: phone, hasTouch: phone, deviceScaleFactor: Number(process.env.PW_DPR ?? 1) });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
      window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
    // The Hub offers its security notices (the rig composes no notice routes): the session's mark and one retained notice.
    await ctx.route(/\/hub\/v1\/session$/, async (route: any) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch(); const json = await res.json().catch(() => null);
      if (json && json.signedIn) json.features = [...new Set([...(json.features ?? []), "quick-pairing-v1"])];
      await route.fulfill({ response: res, json });
    });
    await ctx.route(/\/hub\/v1\/notices\/events$/, (route: any) => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
      body: `event: notices\ndata: ${JSON.stringify({ notices: [NOTICE] })}\n\n` }));
    await ctx.route(/\/hub\/v1\/notices(\/[^/]+\/ack)?$/, (route: any) => route.fulfill({ status: 200, json: route.request().method() === "GET" ? { notices: [NOTICE] } : {} }));
    const page = await ctx.newPage();
    const errs: string[] = [], foreign: string[] = [];
    page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    page.on("request", (q: any) => { const u = new URL(q.url()); if (u.origin === origin && !allowed(u.pathname)) foreign.push(u.pathname); });
    await page.goto(origin + "/ui/hub");
    await page.waitForSelector("#hubLogin", { timeout: 15000 });
    await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin");
    await page.click(".hub-signin button[type=submit]");
    await page.waitForSelector("#sidebar .side-foot", { timeout: 15000, state: "attached" });
    for (const p of PAGES) {
      const tag = `${cn}:${p.key}`;
      await page.goto(origin + p.path);
      await page.waitForSelector("#sidebar .side-foot", { timeout: 15000, state: "attached" });
      await page.waitForSelector(p.key === "notices" ? ".p-hub-notices .hub-security-notices" : ".p-hub .panel-body", { timeout: 15000 });
      await page.waitForTimeout(900);
      const drawn = await page.evaluate(PAGE) as any;
      await page.screenshot({ path: shotPath(SMOKE, cn, p.key) });
      if (drawn.missing) { check(`${tag}:drawn`, false, "no Hub page body"); continue; }
      check(`${tag}:head`, p.head ? drawn.head === p.current[c.lang] : true, { head: drawn.head });
      const frames = [...new Set((drawn.cards as any[]).map((x) => x.frame))];
      check(`${tag}:frame`, frames.length <= 1, drawn.cards);
      const mixed = Object.entries(drawn.kinds as Record<string, Record<string, string>>).filter(([, hs]) => Object.keys(hs).length > 1);
      check(`${tag}:buttons`, mixed.length === 0, mixed);
      check(`${tag}:overflow`, drawn.overCount === 0 && drawn.pageX <= 0, { over: drawn.over, pageX: drawn.pageX });
      check(`${tag}:left-accent`, drawn.accents.length === 0, drawn.accents);
      check(`${tag}:notice-in-column`, drawn.align.length === 0, drawn.align);
      if (phone) { await page.click("#sbOpen"); await page.waitForTimeout(600); await page.screenshot({ path: shotPath(SMOKE, cn, `${p.key}-drawer`) }); }
      const sb = await page.evaluate(SIDEBAR) as any;
      if (sb.missing) { check(`${tag}:sidebar`, false, "no #sidebar"); continue; }
      const want = c.lang === "zh-TW" ? ["對話", "我分享的 Agent", "管理", "通知", "搜尋", "新對話"] : ["Chats", "My shared agents", "Administration", "Notices", "Search", "New chat"];
      const rows = sb.rows as any[];
      check(`${tag}:sidebar:brand`, !!sb.brand && sb.brand.text === "AgEnD Hub" && sb.brand.title === "Team Hub" && sb.brand.lines === 1, sb.brand);
      check(`${tag}:sidebar:rows`, JSON.stringify(rows.map((x) => x.text)) === JSON.stringify(want), rows.map((x) => x.text));
      check(`${tag}:sidebar:row-shape`, new Set(rows.map((x) => x.h)).size === 1 && new Set(rows.map((x) => x.iconX)).size === 1 && rows.every((x) => x.iconX !== null), rows.map((x) => [x.text, x.h, x.iconX]));
      check(`${tag}:sidebar:current`, rows.filter((x) => x.current).map((x) => x.text).join() === p.current[c.lang], rows.filter((x) => x.current).map((x) => x.text));
      check(`${tag}:sidebar:notices-no-count`, rows.every((x) => !x.count), rows.filter((x) => x.count).map((x) => x.text));
      check(`${tag}:sidebar:search`, /side-search/.test(rows[4]?.cls ?? "") && (phone || /K$/.test(rows[4]?.kbd ?? "")), rows[4]);
      check(`${tag}:sidebar:new`, /side-new/.test(rows[5]?.cls ?? "") && sb.legacy.length === 0, { row: rows[5], legacy: sb.legacy });
      check(`${tag}:sidebar:list`, sb.label === (c.lang === "zh-TW" ? "對話" : "Chats") && !!sb.empty && sb.empty.lines === 1, { label: sb.label, empty: sb.empty });
      if (p.key === "chats") {   // the session menu, opened: every item shown — inside the screen and topmost at its centre
        await page.click("#sidebar .hub-session-row button"); await page.waitForTimeout(300);
        const menu = await page.evaluate(`[...document.querySelectorAll("#sidebar .hub-session-row [role=menuitem]")].map((x) => { const b = x.getBoundingClientRect();
          return { t: x.textContent.trim(), shown: b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest("[role=menuitem]") === x }; })`) as { t: string; shown: boolean }[];
        await page.screenshot({ path: shotPath(SMOKE, cn, "session-menu") });
        await page.keyboard.press("Escape"); await page.waitForTimeout(200);
        check(`${tag}:sidebar:session-menu`, menu.length === 4 && menu.every((m) => m.shown), menu);
        // Settings, opened: this device's theme and language, both on the screen.
        await page.click("#sidebar .hub-prefs > summary"); await page.waitForTimeout(300);
        const prefs = await page.evaluate(`[...document.querySelectorAll("#sidebar .hub-prefs .pop select")].map((x) => { const b = x.getBoundingClientRect();
          return b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === x; })`) as boolean[];
        await page.screenshot({ path: shotPath(SMOKE, cn, "settings-pop") });
        await page.click("#sidebar .hub-prefs > summary"); await page.waitForTimeout(200);
        check(`${tag}:sidebar:settings-pop`, prefs.length === 2 && prefs.every(Boolean), prefs);
      }
      check(`${tag}:sidebar:foot`, !!sb.foot && sb.foot.prefs && sb.foot.session && sb.foot.bottomGap <= 2 && sb.foot.rows.every((h: number) => h === rows[0]?.h), sb.foot);
    }
    const csp = await page.evaluate("window.__csp || []") as string[];
    check(`${cn}:hub-only`, foreign.length === 0, foreign);
    check(`${cn}:no-errors`, errs.length === 0 && csp.length === 0, { errs, csp });
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 600)}`);
  console.log(fail.length ? `Hub UI gate FAILED (${fail.length}) in ${r.seconds}s — pictures and result.json in ${OUT}` : `Hub UI gate passed in ${r.seconds}s (${Object.keys(r).length - 2} checks)`);
  await browser.close(); server.close(); await rig.close?.(); rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
