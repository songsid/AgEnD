// Measures what a screenshot only suggests: text clipped with no ellipsis, boxes running past their card, and content
// the phone tab bar covers at the end of a scroller — on the busiest pages, with the realistic fixture.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [MATRIX=quick] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-overflow.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedPerson, seedAvatars, seedCards, seedWidgets, seedChat, seedUsage } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48900) });
const names = fx.instances.map(i => i.name);
const card = [names[4], names[33], "研一官網-t1544335726169165914"];
seedPerson(fx); await seedAvatars(fx, 30); await seedCards(fx, card); await seedWidgets(fx, card[0]); await seedChat(fx, card, 20); await seedUsage(fx);
const enc = encodeURIComponent;
const pages: Array<[string, string]> = [["org", "/ui/fleet/org"], ["chat", `/ui/chat/${enc(card[0])}`], ["details", `/ui/fleet/agent/${enc(card[0])}`],
  ["settings", "/settings/appearance"], ["fleet", "/ui/fleet"], ["view", `/view/${enc(card[1])}`]];

// A string, not a function: tsx wraps functions with a __name helper the page does not have.
const MEASURE = `(() => {
  const W = document.documentElement.clientWidth, H = innerHeight, out = { clipped: [], escapes: [], covered: null, styleAttrs: document.querySelectorAll("[style]").length };
  const label = e => (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : e.tagName.toLowerCase());
  const shown = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < H && getComputedStyle(e).visibility !== "hidden"; };
  for (const e of document.querySelectorAll("main *, .panel *, .p-settings *")) {
    if (!shown(e) || e.closest(".sr-only, [aria-hidden=true], .xterm, canvas, svg")) continue;
    const s = getComputedStyle(e), own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    // Text cut by its own box with no ellipsis to say so.
    if (own && e.scrollWidth > e.clientWidth + 1 && s.overflowX !== "visible" && s.textOverflow !== "ellipsis" && s.overflowX !== "auto" && s.overflowX !== "scroll")
      out.clipped.push(label(e) + " «" + e.textContent.trim().slice(0, 30) + "» " + e.scrollWidth + ">" + e.clientWidth);
    // A box drawn past the card or panel that holds it.
    const host = e.parentElement && e.parentElement.closest(".card, .org-card, .oc-card, .oc-team, section.card, .bubble");
    if (host && host !== e) { const b = e.getBoundingClientRect(), h = host.getBoundingClientRect();
      if (b.right > h.right + 2 || b.left < h.left - 2) out.escapes.push(label(e) + " in " + label(host) + " by " + Math.round(Math.max(b.right - h.right, h.left - b.left)) + "px «" + (e.textContent || "").trim().slice(0, 24) + "»"); }
  }
  // At the very end of the main scroller, is the last content above a fixed bottom bar?
  const bar = [...document.querySelectorAll("nav, .tabbar, .bottom-nav")].find(n => { const s = getComputedStyle(n), b = n.getBoundingClientRect(); return s.position === "fixed" && b.bottom >= H - 1 && b.height > 0 && b.height < 120; });
  const scroller = [...document.querySelectorAll(".panel-body, main, .p-settings")].find(e => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  if (bar && scroller) { scroller.scrollTop = scroller.scrollHeight;
    const last = [...scroller.querySelectorAll("button, a, input, select, p, h3")].filter(x => x.getBoundingClientRect().height > 0).pop();
    out.covered = last ? { last: label(last) + " «" + (last.textContent || "").trim().slice(0, 24) + "»", bottom: Math.round(last.getBoundingClientRect().bottom), barTop: Math.round(bar.getBoundingClientRect().top) } : null; }
  out.clipped = [...new Set(out.clipped)].slice(0, 15); out.escapes = [...new Set(out.escapes)].slice(0, 15);
  return out; })()`;

const out: any = { cases: {} };
for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const { ctx, page, csp } = await fx.page(c);
  const r: any = {};
  for (const [name, path] of pages) {
    await page.goto(fx.base + path); await page.waitForTimeout(1800);
    r[name] = await page.evaluate(MEASURE).catch((e: unknown) => String(e).slice(0, 200));
    // The org canvas is SVG: names are shortened by character count, so measure the drawn text against its card.
    if (name === "org") r[name].svg = await page.evaluate(`(() => { const over = [];
      for (const g of document.querySelectorAll("g.oc-node")) { const w = +g.querySelector("rect.oc-card").getAttribute("width");
        for (const t of g.querySelectorAll("text.oc-name, text.oc-sub")) { const end = +t.getAttribute("x") + t.getComputedTextLength();
          if (end > w - 4) over.push(t.getAttribute("class") + " +" + Math.round(end - w) + "px «" + t.textContent + "» card " + w); } }
      for (const g of document.querySelectorAll("g.oc-team")) { const box = g.querySelector("rect"), t = g.querySelector("text.oc-team-name"); if (!box || !t) continue;
        const end = +t.getAttribute("x") + t.getComputedTextLength(), right = +box.getAttribute("x") + +box.getAttribute("width");
        if (end > right - 4) over.push("team +" + Math.round(end - right) + "px «" + t.textContent + "»"); }
      return { nodes: document.querySelectorAll("g.oc-node").length, over: over.slice(0, 20), count: over.length }; })()`);
    if (name === "view") r[name].term = await page.evaluate(`(() => { const t = document.querySelector(".xterm-rows, .xterm-screen"); return t ? (t.textContent || "").trim().length : null; })()`);
    await page.screenshot({ path: shotPath("overflow", c, name), fullPage: false });
  }
  r.csp = await csp();
  out.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath("overflow", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 12000));
await fx.close(); process.exit(0);
