// The UI gate on the Hub's own pages (docs/design/ui-style-guide.md, leader cid-ui-style-guide): sign-in, the signed-in
// welcome, a chat, the owner's agents, Administration and its Group permissions editor, on a REAL Hub web listener
// (createHubHttp behind node:https, the s3b rig: scratch DB, fake directory; no fleet runs). Group permissions are composed
// with a fixed control and welcome answer, so the pages draw as a Hub with them on.
//
// Per page and case:
//   :overflow   nothing wider than the window (the page doesn't scroll sideways; no element past the right edge unless a
//               scrolling or clipping box holds it) — style guide rule 7;
//   :buttons    one height per button class combination on the page;
//   :no-errors  no page error, no CSP report;
//   :tap        at phone width, controls smaller than --tap (44px) — a ratchet: the places listed in
//               ui-gate-hub-tap-allowlist.json may keep their count, a new one or a higher count fails.
// GATE=ci (default): desk-light-en and phone-dark-zh-TW, plus a 1024 px desktop. GATE=full: the 8-case matrix, plus 900,
// 1024, 1180 and 1280 px, and a listed place that has fewer small controls now fails too (lower it with TAP_UPDATE=1, which
// refuses to raise anything; TAP_UPDATE=reset adopts the current pages as a new baseline — a branch's first list only).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-hub-ui-gate.mts
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const REPO = process.env.REPO ?? process.cwd(), PW = process.env.PW_DIR ?? REPO;
const GATE = process.env.GATE === "full" ? "full" : "ci";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "smoke-hub-ui-gate");
mkdirSync(OUT, { recursive: true });
type Case = { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" };
const ALL: Case[] = [];
for (const device of ["desk", "phone"] as const) for (const theme of ["light", "dark"] as const) for (const lang of ["en", "zh-TW"] as const) ALL.push({ device, theme, lang });
const caseName = (c: Case) => `${c.device}-${c.theme}-${c.lang}`;
const CASES = GATE === "full" ? ALL : [ALL[0]!, ALL[7]!];
const WIDTHS = GATE === "full" ? [900, 1024, 1180, 1280] : [1024];
const TAP_LIST = join(REPO, "scripts/manual/smoke/ui-gate-hub-tap-allowlist.json");
const tapAllowed: Record<string, number> = JSON.parse(readFileSync(TAP_LIST, "utf8"));
const tapSeen: Record<string, number> = {};

const r: Record<string, unknown> = { gate: GATE };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

// A string, not a function: a named helper inside a compiled function reaches the page as an undefined __name.
const MEASURE = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0 && !el.closest("[hidden], details:not([open]) > :not(summary)"); };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const path = (el) => { const p = []; for (let e = el; e && e !== document.body && p.length < 3; e = e.parentElement) p.unshift(name(e)); return p.join(" > "); };
  const W = document.documentElement.clientWidth, over = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.right <= W + 1) continue;
    let held = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible" || s.position === "fixed") { held = a.getBoundingClientRect().right <= W + 1; if (held) break; } }
    if (!held) over.push(path(el) + " right=" + Math.round(b.right));
  }
  const kinds = {};
  for (const el of document.querySelectorAll("button, a.btn")) {
    if (!vis(el)) continue;
    const cls = String(el.className || "").split(/\\s+/).filter((c) => /^(btn|icon-btn)/.test(c)).sort().join(".");
    if (!cls) continue;
    const h = Math.round(el.getBoundingClientRect().height);
    (kinds[cls] = kinds[cls] || {})[h] = path(el);
  }
  const tap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")) || 44;
  const small = {};
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch], [role=tab], [role=checkbox]")) {
    if (!vis(el) || el.matches(":disabled")) continue;
    let b = el.getBoundingClientRect(), m = Math.min(b.width, b.height);
    if (b.bottom <= 0) continue;   // drawn above the page until focused (the keyboard skip link): not a touch target
    if (el.matches("input[type=checkbox], input[type=radio]")) for (const l of el.labels || []) { if (!vis(l)) continue; const lb = l.getBoundingClientRect(); if (Math.min(lb.width, lb.height) > m) m = Math.min(lb.width, lb.height); }
    if (m >= tap - 0.5) continue;
    const k = path(el); small[k] = (small[k] || 0) + 1;
  }
  return { pageX: document.documentElement.scrollWidth - W, over: over.slice(0, 12), overCount: over.length, kinds, small, tap };
})()`;

const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const port = Number(process.env.HUB_GATE_PORT ?? 48930), origin = `https://127.0.0.1:${port}`;
const ID1 = "0f1e2d3c-4b5a-4968-8776-655443322110";
const POLICY = { realm: "corp", generation: "gen-1", revision: 4, state: "enabled", denies: [], groups: [
  { group: { realm: "corp", objectId: ID1 }, dn: "CN=Hub-Owners-With-A-Long-Group-Name,OU=Groups,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 1 }] };
const control = {
  async read(ctx: any) { await ctx.requireAdmin(); return { ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: POLICY, paused: [] }; },
  async resolve(_i: unknown, ctx: any) { await ctx.requireAdmin(); return { ok: false, reason: "not-found" }; },
  async preview(_i: unknown, ctx: any) { await ctx.requireAdmin(); return { ok: false, code: "stale-preview" }; },
  async apply(_i: unknown, ctx: any) { await ctx.requireAdmin(); return { ok: false, code: "stale-preview" }; },
  async resume(_i: unknown, ctx: any) { await ctx.requireAdmin(); return { ok: true, state: "enabled" }; },
};
const welcome = async (ctx: any) => { await ctx.requirePerson();
  return { ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "allow", reason: "group" }, connect: { state: "allow", reason: "group", maxFleets: 2, fleets: [] } }; };
const rig = await s3bRig({ webOrigin: origin, groupHttp: { control, welcome } });
const keys = mkdtempSync(join(OUT, ".keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

// People and content with long values (rule 7): a long name, a long agent name, a long message.
const olivia = rig.addPerson("olivia", "Olivia Chen-Montgomery of the Platform Reliability Engineering Group");
rig.addPerson("bo", "Bo Wu");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia), id = randomUUID();
await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id, fleetId, owner: olivia, displayName: "Design guide reviewer for the quarterly platform architecture documents", revision: 1,
  state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
const owner = await rig.signIn("olivia"), admin = await rig.signIn("admin"), bo = await rig.signIn("bo");
const runs: Array<{ c: Case; width?: number }> = [...CASES.map((c) => ({ c })), ...WIDTHS.map((width) => ({ c: ALL[0]!, width }))];
// One asker per run: the Hub paces a room's reads per session (ROOM_POLL_MS, 10 s), and sign-ins per login.
const askers: Array<{ cookie: string; room: string }> = [];
for (let i = 0; i < runs.length; i++) {
  rig.addPerson(`alex${i}`, "Alex Lin");
  const who = await rig.signIn(`alex${i}`);
  const grant = (await rig.call(owner, "POST", "/hub/v1/grants", { exposureId: id, exposureRevision: 1, login: `alex${i}`, days: 7 })).json.grant;
  askers.push({ cookie: who.cookie, room: (await rig.call(who, "POST", "/hub/v1/rooms", { exposureId: id, grantId: grant.id })).json.room.id });
}

const PAGES = [
  { name: "signin", who: null, path: "/ui/hub", ready: "#hubLogin" },
  { name: "welcome", who: bo, path: "/ui/hub", ready: ".hub-welcome-card" },
  { name: "chat", who: "asker", path: "/ui/hub?room=", ready: ".hub-chat-main" },
  { name: "owner", who: owner, path: "/ui/hub/exposures", ready: ".hub-owner" },
  { name: "admin", who: admin, path: "/ui/hub/admin", ready: ".hub-admin" },
  { name: "admin-groups", who: admin, path: "/ui/hub/admin?view=groups", ready: ".hub-group-row" },
] as const;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
async function open(c: Case, who: { cookie: string } | null, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
    isMobile: c.device === "phone", hasTouch: c.device === "phone" });
  if (who) { const [n, v] = who.cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: origin, httpOnly: true, secure: true }]); }
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_theme", ${JSON.stringify(c.theme)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
  const page = await ctx.newPage(), errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  return { ctx, page, errs };
}

try {
  for (const [i, { c, width }] of runs.entries()) {
    const cn = width ? `desk-${width}` : caseName(c);
    const viewport = width ? { width, height: 900 } : c.device === "desk" ? { width: 1366, height: 900 } : { width: 390, height: 844 };
    for (const p of PAGES) {
      const tag = `${cn}:${p.name}`;
      const who = p.who === "asker" ? askers[i]! : p.who, path = p.who === "asker" ? p.path + askers[i]!.room : p.path;
      const { ctx, page, errs } = await open(c, who, viewport);
      try {
        await page.goto(origin + path);
        const drawn = await page.waitForSelector(p.ready, { timeout: 15000 }).then(() => true, () => false);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(OUT, `${tag.replace(":", "-")}.png`), fullPage: true });
        const failed = await page.evaluate(`[...document.querySelectorAll(".error-state")].map((e) => e.innerText.trim()).filter(Boolean)`) as string[];
        // The page drew what it is for, not a failed read (the gate measures a working page).
        check(`${tag}:drawn`, drawn && failed.length === 0, { ready: p.ready, drawn, failed, errs });
        if (!drawn) continue;
        const m = await page.evaluate(MEASURE) as any;
        check(`${tag}:overflow`, m.pageX <= 0 && m.overCount === 0, { pageX: m.pageX, over: m.over });
        const mixed = Object.entries(m.kinds as Record<string, Record<string, string>>).filter(([, hs]) => Object.keys(hs).length > 1);
        check(`${tag}:buttons`, mixed.length === 0, mixed);
        const csp = await page.evaluate("window.__csp || []") as string[];
        check(`${tag}:no-errors`, errs.length === 0 && csp.length === 0, { errs, csp });
        if (c.device === "phone" && !width) {
          const over: string[] = [];
          for (const [where, n] of Object.entries(m.small as Record<string, number>)) {
            const k = `${p.name} ${where}`;
            tapSeen[k] = Math.max(tapSeen[k] ?? 0, n);
            if (n > (tapAllowed[k] ?? 0)) over.push(`${where} (${n} now, ${tapAllowed[k] ?? 0} allowed)`);
          }
          check(`${tag}:tap`, over.length === 0, over);
        }
      } finally { await ctx.close(); }
    }
  }
  const sorted = Object.fromEntries(Object.entries(tapSeen).sort(([a], [b]) => a.localeCompare(b)));
  const rises = Object.entries(tapSeen).filter(([k, n]) => n > (tapAllowed[k] ?? 0));
  if (process.env.TAP_UPDATE === "reset" || (process.env.TAP_UPDATE === "1" && rises.length === 0)) writeFileSync(TAP_LIST, JSON.stringify(sorted, null, 2) + "\n");
  if (GATE === "full" && process.env.TAP_UPDATE !== "reset") {
    const stale = Object.entries(tapAllowed).filter(([k, n]) => (tapSeen[k] ?? 0) < n).map(([k, n]) => `${k} (${tapSeen[k] ?? 0} now, ${n} listed)`);
    check("gate:tap-allowlist-stale", stale.length === 0, stale);
  }
} catch (e) { fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1500); }
finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res()));
  await rig.close(); rmSync(keys, { recursive: true, force: true });
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
  const failed = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "PASS"));
  console.log(JSON.stringify(failed, null, 2));
  console.log(`${Object.keys(r).length - 1} checks; ` + (fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS"));
  process.exit(fail.length ? 1 : 0);
}
