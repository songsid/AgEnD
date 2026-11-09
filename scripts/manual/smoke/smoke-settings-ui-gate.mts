// The AgEnD UI gate (fleet decision "AgEnD UI gate"; alpha.6 feedback #3): every Settings section, in a real headless Chrome,
// on the shared fixture (the product's own web server from an in-process FleetManager, a scratch home, loopback only — no
// fleet start, no network). Per case and section:
//   - frame:    the section's own cards (not one inside a drawer or disclosure; not a full-bleed editor/terminal) share one
//               frame — padding, border and corner radius;
//   - buttons:  each button kind (.btn…, .icon-btn) has one height (a list row's actions are a phone tap target on purpose,
//               and a button sized to the input controls of its own row is that row's control size);
//   - overflow: nothing reaches past the content column — as drawn, with every drawer open, and with a long real value in every
//               select (a long model / computer / agent name: a select is as wide as its longest option unless bounded);
//   - left-accent: no coloured left edge on a rounded box — a border-left wider than (or coloured unlike) the box's own top
//               border while a left corner is rounded. The house style is the straight left bar (`.lbar`, #2330/#2332/#2489);
//               a rounded border-left accent came back once in #3367's Accounts boxes (the user's report), so it fails here;
//   - tap (phone width only; style guide rule 7, a ratchet): every interactive control in the column is at least --tap (44px)
//               in both directions — a checkbox or radio by its label when it has one. Today's small controls are listed in
//               ui-gate-tap-allowlist.json (section + where, with a count); a new one, or one more of a listed kind, fails.
//               Both states count: as drawn, and with every disclosure open (a control only an open drawer shows). A
//               disabled control (:disabled, a disabled fieldset included) isn't a target; a checkbox or radio is measured
//               by its largest associated label (wrapping or label[for]) when that is bigger than the control.
//               The list only shrinks: after GATE=full over every section, a listed allowance no case reached fails
//               (gate:tap-allowlist-stale). TAP_UPDATE=1 lowers the list to this run and refuses (writes nothing) if any
//               count would rise; TAP_UPDATE=reset adopts this run as a new baseline (a new branch's first list only —
//               reviewed as such, never to pass a PR);
//   - no page error, no CSP report, no horizontal scroll of the page.
// GATE=ci (the CI job, < 5 min): desk light en + phone dark zh-TW, every section, the long-value pass, one middle width (1024).
// GATE=full (local, ~10 min): the whole matrix (desk/phone × light/dark × en/zh-TW) and widths 900–1280.
// Pictures of every section land in OUT (a failing CI run uploads them).
//   PW_DIR=<dir with playwright-core> (or node_modules) REPO=<checkout> OUT=<dir> [GATE=ci|full] [CHROME=<chrome binary>] \
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-settings-ui-gate.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-ui-gate";
const REPO = process.env.REPO ?? process.cwd();
const GATE = process.env.GATE === "full" ? "full" : "ci";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const { SETTINGS_SECTIONS } = await import(REPO + "/src/ui/shared/app-route.js");
const SECTIONS: string[] = process.env.SECTIONS ? process.env.SECTIONS.split(",") : [...SETTINGS_SECTIONS];
const CASES = GATE === "full" ? matrix("full") : matrix("desk-light-en,phone-dark-zh-TW");
const WIDTHS = GATE === "full" ? [900, 1024, 1180, 1280] : [1024];
const LONG = "claude-opus-5-5-20261101-extended-context-preview-with-a-very-long-model-identifier [1m] (Windows PC DESKTOP-ABCDEFGHIJ)";

const TAP_LIST = join(REPO, "scripts/manual/smoke/ui-gate-tap-allowlist.json");
const tapAllowed: Record<string, number> = JSON.parse(readFileSync(TAP_LIST, "utf8"));
const tapSeen: Record<string, number> = {};
/** One phone section's small controls: the larger count of the drawn and the opened state, per place (never their sum). */
export function tapCounts(drawn: Record<string, number>, opened: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...drawn };
  for (const [k, n] of Object.entries(opened)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
}

const r: Record<string, unknown> = { gate: GATE };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

/** The section as drawn: overflow, its cards' frames, its buttons. */
const MEASURE = `(() => {
  const col = document.querySelector(".p-settings .panel-body > .col");
  if (!col) return { missing: true };
  const cb = col.getBoundingClientRect();
  const vis = (el) => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0 && !el.closest("[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const path = (el) => { const p = []; for (let e = el; e && e !== col && p.length < 3; e = e.parentElement) p.unshift(name(e)); return p.join(" > "); };
  const over = [];
  for (const el of col.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect();
    let clipped = false;
    for (let a = el.parentElement; a && a !== col; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible") { clipped = a.getBoundingClientRect().right <= cb.right + 1; break; } }
    if (!clipped && b.right > cb.right + 1) over.push(path(el) + " +" + Math.round(b.right - cb.right));
  }
  const inBox = (el) => !!el.parentElement.closest("details, .drawer-body, .s-disclosure-body, .s-look-disclosure-body, dialog");
  const cards = [...col.querySelectorAll(".card")].filter((el) => vis(el) && !inBox(el) && !el.matches(".s-dev, .s-access-terminal") && !el.closest("nav, .pending-stack"))
    .map((el) => { const s = getComputedStyle(el); return { el: path(el), frame: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft, s.borderTopWidth, s.borderTopStyle, s.borderTopLeftRadius].join(" ") }; });
  const kinds = {};
  for (const el of col.querySelectorAll("button, a.btn")) {
    if (!vis(el) || el.closest("nav, [role=tablist], .s-row, dialog, .pending-stack")) continue;
    const cls = String(el.className || "").split(/\\s+/).filter((c) => /^(btn|icon-btn)/.test(c)).sort().join(".");
    if (!cls) continue;
    const h = Math.round(el.getBoundingClientRect().height);
    // A button sized to the input controls of its own row (a filter bar's Clear beside its 40 px selects) is that row's
    // control size, not a second button style.
    const row = el.parentElement, peers = row ? [...row.querySelectorAll(":scope > select, :scope > input, :scope > label select, :scope > label input, :scope > * > select")] : [];
    if (peers.some((f) => vis(f) && Math.abs(Math.round(f.getBoundingClientRect().height) - h) <= 1)) continue;
    (kinds[cls] ||= {})[h] = (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24);
  }
  // The user's report on #3367: a coloured left edge on a rounded box (a border-left curving into its corners) — never the
  // house style, which is the straight left bar (.lbar). A box's own all-round border (same width and colour as its top) passes.
  const accents = [];
  // Whether a computed colour paints at all (#3407 review): "transparent", or an alpha of 0 in any computed form —
  // rgba(r, g, b, 0), rgb(r g b / 0), color(srgb r g b / 0) (what color-mix(…, transparent) computes to). A rgb() without
  // an alpha is opaque, whatever its last channel.
  const painted = (c) => {
    if (!c || c === "transparent") return false;
    let m = /\\/\\s*([\\d.]+)(%?)\\s*\\)$/.exec(c);
    if (!m && c.startsWith("rgba(")) m = /,\\s*([\\d.]+)(%?)\\s*\\)$/.exec(c);
    return !m || parseFloat(m[1]) / (m[2] ? 100 : 1) > 0;
  };
  for (const el of col.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el), lw = parseFloat(s.borderLeftWidth) || 0;
    if (lw < 2 || s.borderLeftStyle === "none" || !painted(s.borderLeftColor)) continue;
    const edge = lw > (parseFloat(s.borderTopWidth) || 0) || s.borderLeftColor !== s.borderTopColor;
    const round = (parseFloat(s.borderTopLeftRadius) || 0) > 0 || (parseFloat(s.borderBottomLeftRadius) || 0) > 0;
    if (edge && round) accents.push(path(el) + " " + s.borderLeftWidth + " " + s.borderLeftColor + " r" + s.borderTopLeftRadius);
  }
  // Style guide rule 7: a phone tap target is at least --tap (44px) both ways; a checkbox or radio counts by its label.
  const tap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap")) || 44;
  const small = {};
  for (const el of col.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch], [role=tab], [role=checkbox]")) {
    if (!vis(el) || el.matches(":disabled")) continue;
    // A checkbox or radio is tapped through its label (wrapping or label[for]): the largest associated box counts.
    let w = el.getBoundingClientRect().width, h = el.getBoundingClientRect().height;
    if (el.matches("input[type=checkbox], input[type=radio]")) for (const l of el.labels || []) { if (!vis(l)) continue; const lb = l.getBoundingClientRect(); if (Math.min(lb.width, lb.height) > Math.min(w, h)) { w = lb.width; h = lb.height; } }
    if (Math.min(w, h) + 0.5 >= tap) continue;
    const k = path(el); small[k] = (small[k] || 0) + 1;
  }
  return { over: over.slice(0, 8), overCount: over.length, cards, kinds, accents: accents.slice(0, 8), accentCount: accents.length, small, tap, pageX: document.documentElement.scrollWidth - innerWidth };
})()`;

const fx = await bootFixture({ port: Number(process.env.GATE_PORT ?? 47510), instances: 12 });
const started = Date.now();
/**
 * #3407 review: the left-accent rule checks itself before it judges anything — controls drawn into a Settings column and
 * measured by MEASURE as sent to the browser. Exactly the opaque rounded accent is flagged; a border that paints nothing
 * (transparent, rgba(…, 0), color(… / 0), color-mix(…, transparent)), a square divider and a box's own all-round border pass.
 */
const CONTROLS = [
  ["opaque", "border-left: 4px solid rgb(200, 0, 0); border-radius: 8px", true],
  ["transparent", "border-left: 4px solid transparent; border-radius: 8px", false],
  ["rgba-zero", "border-left: 4px solid rgba(255, 0, 0, 0); border-radius: 8px", false],
  ["color-zero", "border-left: 4px solid color(srgb 1 0 0 / 0); border-radius: 8px", false],
  ["mix-transparent", "border-left: 4px solid color-mix(in srgb, red 0%, transparent); border-radius: 8px", false],
  ["square-divider", "border-left: 4px solid rgb(200, 0, 0); border-radius: 0", false],
  ["uniform-border", "border: 2px solid rgb(200, 0, 0); border-radius: 8px", false],
] as const;
async function selfTest(page: any): Promise<void> {
  await page.evaluate((controls: readonly (readonly [string, string, boolean])[]) => {
    const col = document.querySelector(".p-settings .panel-body > .col")!;
    const box = document.createElement("div"); box.id = "ui-gate-controls";
    for (const [name] of controls) { const d = document.createElement("div"); d.className = "ui-gate-control-" + name; d.textContent = name; box.appendChild(d); }
    col.appendChild(box);
    // Inline style= is refused by the page's CSP (style-src without unsafe-inline): set each control's style through the CSSOM.
    controls.forEach(([name, css]) => { const el = box.querySelector(".ui-gate-control-" + name) as HTMLElement; for (const decl of css.split(";")) { const [k, v] = decl.split(/:(.*)/s).map((x) => x.trim()); if (k) el.style.setProperty(k, v); } el.style.setProperty("width", "40px"); el.style.setProperty("height", "20px"); });
  }, CONTROLS as any);
  const m = await page.evaluate(MEASURE) as any;
  await page.evaluate(() => document.getElementById("ui-gate-controls")?.remove());
  const flagged = (m.accents as string[]).filter((a) => a.includes("ui-gate-control-")).map((a) => /ui-gate-control-([\w-]+)/.exec(a)![1]);
  const want = CONTROLS.filter(([, , bad]) => bad).map(([n]) => n);
  check("gate:left-accent-self-test", JSON.stringify(flagged) === JSON.stringify(want), { flagged, want });
}
/**
 * The tap rule checks itself too, through the same drawn/opened combination as the sections: a 30px button is small, a
 * 44px one isn't; a checkbox counts by its 44px label, wrapping or label[for]; a 30px button in a disabled fieldset is not
 * a target; and a 30px button that only an opened disclosure shows is caught (Prism #3417).
 */
async function tapSelfTest(page: any): Promise<void> {
  // A string, like MEASURE: a named helper inside a compiled function would reach the page as an undefined __name.
  await page.evaluate(`(() => {
    const col = document.querySelector(".p-settings .panel-body > .col");
    const box = document.createElement("div"); box.id = "ui-gate-tap-controls";
    box.innerHTML = '<button class="ui-gate-tap-small">a</button><button class="ui-gate-tap-big">b</button>'
      + '<label class="ui-gate-tap-label"><input type="checkbox" class="ui-gate-tap-check"> c</label>'
      + '<input type="checkbox" id="ui-gate-tap-for" class="ui-gate-tap-forcheck"><label for="ui-gate-tap-for" class="ui-gate-tap-forlabel">d</label>'
      + '<fieldset disabled><button class="ui-gate-tap-disabled">e</button></fieldset>'
      + '<details><summary>f</summary><button class="ui-gate-tap-openonly">g</button></details>';   // hidden by CSS until open (below)
    col.appendChild(box);
    for (const [sel, w, h] of [[".ui-gate-tap-small", "30px", "30px"], [".ui-gate-tap-big", "44px", "44px"], [".ui-gate-tap-label", "120px", "44px"],
        [".ui-gate-tap-forlabel", "120px", "44px"], [".ui-gate-tap-disabled", "30px", "30px"], [".ui-gate-tap-openonly", "30px", "30px"]]) {
      const el = box.querySelector(sel);
      for (const [k, v] of [["display", "inline-block"], ["width", w], ["height", h], ["min-height", "0"], ["min-width", "0"], ["padding", "0"]]) el.style.setProperty(k, v);
    }
    // Prism's #3417 shape: content a stylesheet hides until its disclosure opens (details[open] > button { display: block }).
    box.querySelector(".ui-gate-tap-openonly").style.setProperty("display", "none");
  })()`);
  const drawn = await page.evaluate(MEASURE) as any;
  await page.evaluate(`(() => { document.querySelector("#ui-gate-tap-controls details").open = true; document.querySelector(".ui-gate-tap-openonly").style.setProperty("display", "inline-block"); })()`);
  const opened = await page.evaluate(MEASURE) as any;
  await page.evaluate(() => document.getElementById("ui-gate-tap-controls")?.remove());
  const flagged = Object.keys(tapCounts(drawn.small, opened.small)).map((k) => /\.ui-gate-tap-([\w-]+)$/.exec(k)?.[1]).filter(Boolean).sort();
  const closedMissed = !Object.keys(drawn.small).some((k) => k.endsWith(".ui-gate-tap-openonly"));
  check("gate:tap-self-test", JSON.stringify(flagged) === JSON.stringify(["openonly", "small"]) && closedMissed && drawn.tap === 44, { flagged, closedMissed, tap: drawn.tap });
}
let tapSelfTested = false;
let selfTested = false;
try {
  for (const c of CASES) {
    const cn = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    for (const section of SECTIONS) {
      await page.setViewportSize(VIEWPORTS[c.device]);
      await page.goto(`${fx.base}/settings/${section}`);
      await page.waitForSelector(".p-settings .panel-body > .col", { timeout: 15000 });
      await page.waitForTimeout(700);
      if (!selfTested) { await selfTest(page); selfTested = true; }
      const drawn = await page.evaluate(MEASURE) as any;
      await page.screenshot({ path: shotPath(SMOKE, cn, section), fullPage: false });
      await page.evaluate(`(() => { document.querySelectorAll(".p-settings .panel-body details").forEach((d) => { d.open = true; });
        document.querySelectorAll(".p-settings .panel-body select").forEach((s) => { const o = document.createElement("option"); o.textContent = ${JSON.stringify(LONG)}; s.appendChild(o); }); })()`);
      await page.waitForTimeout(250);
      const opened = await page.evaluate(MEASURE) as any;
      const tag = `${cn}:${section}`;
      if (drawn.missing) { check(`${tag}:drawn`, false, "no Settings column"); continue; }
      const frames = [...new Set((drawn.cards as any[]).map((x) => x.frame))];
      check(`${tag}:frame`, frames.length <= 1, drawn.cards);
      const mixed = Object.entries(drawn.kinds as Record<string, Record<string, string>>).filter(([, hs]) => Object.keys(hs).length > 1);
      check(`${tag}:buttons`, mixed.length === 0, mixed);
      check(`${tag}:overflow`, drawn.overCount === 0 && opened.overCount === 0 && drawn.pageX <= 0 && opened.pageX <= 0, { drawn: drawn.over, opened: opened.over, pageX: [drawn.pageX, opened.pageX] });
      check(`${tag}:left-accent`, drawn.accentCount === 0 && opened.accentCount === 0, { drawn: drawn.accents, opened: opened.accents });
      if (c.device === "phone") {
        if (!tapSelfTested) { await tapSelfTest(page); tapSelfTested = true; }
        const over: string[] = [];
        for (const [where, n] of Object.entries(tapCounts(drawn.small, opened.small))) {
          const k = `${section} ${where}`;
          tapSeen[k] = Math.max(tapSeen[k] ?? 0, n);
          if (n > (tapAllowed[k] ?? 0)) over.push(`${k} ×${n} (allowed ${tapAllowed[k] ?? 0})`);
        }
        check(`${tag}:tap`, over.length === 0, over);
      }
    }
    for (const width of WIDTHS) for (const section of SECTIONS) {
      if (c.device !== "desk") break;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fx.base}/settings/${section}`);
      await page.waitForSelector(".p-settings .panel-body > .col", { timeout: 15000 }); await page.waitForTimeout(500);
      await page.evaluate(`document.querySelectorAll(".p-settings .panel-body details").forEach((d) => { d.open = true; })`);
      const m = await page.evaluate(MEASURE) as any;
      check(`${cn}@${width}:${section}:overflow`, m.overCount === 0 && m.pageX <= 0, { over: m.over, pageX: m.pageX });
    }
    const cspNow = await csp();
    check(`${cn}:no-errors`, errs.length === 0 && cspNow.length === 0, { errs, csp: cspNow });
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  // The list only shrinks (Prism #3417): over the complete matrix, an allowance no case reached is stale.
  const complete = GATE === "full" && !process.env.SECTIONS && !r.error;
  if (complete) {
    const stale = Object.entries(tapAllowed).filter(([k, n]) => (tapSeen[k] ?? 0) < n).map(([k, n]) => `${k} (${tapSeen[k] ?? 0} now, ${n} listed)`);
    check("gate:tap-allowlist-stale", stale.length === 0, stale);
  }
  const merged = Object.fromEntries(Object.entries(tapSeen).sort(([a], [b]) => a.localeCompare(b)));
  if (process.env.TAP_UPDATE === "reset" && complete) {
    writeFileSync(TAP_LIST, JSON.stringify(merged, null, 1) + "\n"); console.log(`TAP_UPDATE=reset: new baseline, ${Object.keys(merged).length} entries`);
  } else if (process.env.TAP_UPDATE === "1" && complete) {
    const rises = Object.entries(merged).filter(([k, n]) => n > (tapAllowed[k] ?? 0));
    if (rises.length) console.log(`TAP_UPDATE: refused, ${rises.length} count(s) would rise; the list is unchanged`);
    else { writeFileSync(TAP_LIST, JSON.stringify(merged, null, 1) + "\n"); console.log(`TAP_UPDATE: lowered to ${Object.keys(merged).length} entries`); }
  } else if (process.env.TAP_UPDATE) console.log("TAP_UPDATE: needs GATE=full over every section; the list is unchanged");
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 600)}`);
  console.log(fail.length ? `UI gate FAILED (${fail.length}) in ${r.seconds}s — pictures and result.json in ${OUT}` : `UI gate passed in ${r.seconds}s (${Object.keys(r).length - 2} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
