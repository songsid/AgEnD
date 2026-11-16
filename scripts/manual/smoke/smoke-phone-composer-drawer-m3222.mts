// M-3222 (the user, iPhone, beta.6):
//   1. the composer: one line of text sat ~3 px under the box's middle (Send centred, 📎 low with the text). The row aligns
//      its items to the bottom, and on a phone Send is a 44 px tap target while the one-line box was 38 px tall.
//   2. the drawer: the reminders were big boxes — rows with a fresh reply got a tinted block (and a pulse), a tapped row
//      kept its hover tint, blocks of uneven height with a lighter band between neighbours. A reminder is a quiet,
//      uniform marker at the row's own height (its reply time in the accent); no counts, no red dots.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents), a phone
// (390×844, touch), light/dark; headless. Two agents' last replies are made fresh in the page (one under a minute: its
// pulse too) and a third agent's chat is open (the selected row). Pictured per case: 1-composer-empty, 2-composer-line,
// 3-composer-lines, 4-drawer-compact, 5-drawer-detailed.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-composer-drawer-m3222.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";
import { clearDensity, density } from "../smoke-fixture/faces.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-composer-drawer-m3222";
const webkit = process.env.PW_ENGINE === "webkit";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 8 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
/** Two agents replied just now (names[1] 30 s ago: its pulse too; names[2] 4 min ago), kept so across status frames. */
const fresh = (page: any) => page.evaluate(async (all: string[]) => {
  const m = await import("/assets/app-store.js");
  const store = m.appStore as any;
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const patch = (it: any) => it.name === all[1] ? { ...it, last_reply: at(30) } : it.name === all[2] ? { ...it, last_reply: at(240) } : it;
  if (!store.__fresh) {
    const set = store.set.bind(store);
    store.set = (p: any) => set((s: any) => { const n = typeof p === "function" ? p(s) : { ...s, ...p }; return n === s || !Array.isArray(n.instances) ? n : { ...n, instances: n.instances.map(patch) }; });
    store.__fresh = true;
  }
  store.set((s: any) => ({ ...s }));
}, names);

try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(names[3])}`, beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(webkit && /ResizeObserver loop/.test(m))) errs.push(m.slice(0, 200)); });
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
      // ── 1. the composer: the text's line and the placeholder in the middle with Send and 📎 ──
      const centres = () => page.evaluate(() => {
        const mid = (e: Element | null) => { if (!e) return null; const r = (e as HTMLElement).getBoundingClientRect(); return r.width ? r.top + r.height / 2 : null; };
        const ta = document.querySelector("#msgIn") as HTMLTextAreaElement, cs = getComputedStyle(ta), r = ta.getBoundingClientRect();
        const ph = document.querySelector(".composer-ph") as HTMLElement, pcs = getComputedStyle(ph);
        const line = r.top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight) / 2;       // the first line's middle
        const phShown = ph.getBoundingClientRect().width > 0;
        return { line, ph: phShown ? ph.getBoundingClientRect().top + parseFloat(pcs.lineHeight) / 2 : null, send: mid(document.querySelector(".composer .btn-send")),
          attach: mid(document.querySelector(".composer #attachBtn")), h: Math.round(r.height), lh: parseFloat(cs.lineHeight) };
      });
      const empty = await centres();
      need(empty.send && empty.ph && Math.abs(empty.ph - empty.send) <= 1 && Math.abs(empty.line - empty.send) <= 1 && (!empty.attach || Math.abs(empty.attach - empty.send) <= 1),
        `empty: the placeholder's line, the box's line and 📎 in the middle with Send (${JSON.stringify(empty)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-composer-empty") });
      await page.locator("#msgIn").fill("Hello 你好 — one line");
      await page.waitForTimeout(300);
      const one = await centres();
      need(one.send && Math.abs(one.line - one.send) <= 1 && (!one.attach || Math.abs(one.attach - one.send) <= 1), `one line: its middle with Send's (${JSON.stringify(one)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-composer-line") });
      await page.locator("#msgIn").fill("one\ntwo\nthree");
      await page.waitForTimeout(300);
      const three = await centres();
      need(three.h >= one.h + 2 * three.lh - 1, `three lines: the box grows (${one.h} → ${three.h})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-composer-lines") });
      await page.locator("#msgIn").fill("");
      // ── 2. the drawer: a reminder is a quiet marker at the row's own height ──
      await fresh(page); await page.waitForTimeout(400);
      await page.locator("#sbOpen").tap(); await page.waitForTimeout(700);
      for (const d of ["compact", "detailed"] as const) {
        await density(page, d); await fresh(page); await page.waitForTimeout(700);
        // What a finger leaves behind on a touch screen: a plain row "hovered" (the pointer stays where the finger was).
        const box = await page.locator(`#sidebar .v-inst[href$="/${encodeURIComponent(names[5])}"]`).first().boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        const rows = await page.evaluate((all: string[]) => {
          const sb = document.querySelector("#sidebar") as HTMLElement;
          const shown = (e: Element) => (e as HTMLElement).getBoundingClientRect().width > 0;
          const alpha = (bg: string) => { const m = /\/\s*([\d.]+)\s*\)$/.exec(bg) || /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(bg); return m ? parseFloat(m[1]!) : /^rgb\(/.test(bg) ? 1 : 0; };
          const probe = document.createElement("span"); probe.style.color = "var(--accent)"; sb.appendChild(probe);
          const accent = getComputedStyle(probe).color; probe.remove();
          return [...sb.querySelectorAll(".v-li")].filter(shown).map((li) => {
            const a = li.querySelector(".v-inst") as HTMLElement, cs = getComputedStyle(a), name = a.querySelector(".inst-name") as HTMLElement;
            const when = a.querySelector(".inst-when") as HTMLElement | null;
            const row = a.getAttribute("href") || "";
            return { who: all.find((n) => row.endsWith(`/${encodeURIComponent(n)}`)) ?? "", h: Math.round(a.getBoundingClientRect().height), li: Math.round(li.getBoundingClientRect().height),
              replied: a.classList.contains("replied"), active: a.classList.contains("active"), bg: alpha(cs.backgroundColor), anim: cs.animationName,
              weight: Number(getComputedStyle(name).fontWeight), fresh: !!when?.classList.contains("fresh") && (when.getBoundingClientRect().width > 0),
              whenColour: when ? getComputedStyle(when).color : "", accent };
          });
        }, names);
        const r1 = rows.find((x) => x.who === names[1]), r2 = rows.find((x) => x.who === names[2]);
        const plain = rows.filter((x) => !x.replied && !x.active);
        const heights = new Set(rows.filter((x) => x.h).map((x) => x.h));
        need(r1?.replied && r2?.replied, `two rows with a fresh reply (${JSON.stringify([r1, r2])})`);
        need(rows.filter((x) => !x.active).every((x) => x.bg < 0.01) && rows.every((x) => x.anim === "none"), `${d}: no tinted block or pulse on any row but the open one (${JSON.stringify(rows.filter((x) => x.bg >= 0.01 || x.anim !== "none").map((x) => ({ who: x.who, bg: x.bg, anim: x.anim })))})`);
        // The marker: the reply time shown, in a colour of its own (the accent), where other rows' times are muted.
        need([r1, r2].every((x) => x && x.fresh && x.whenColour === x.accent), `${d}: a fresh reply's marker — its reply time in the accent (${JSON.stringify([r1, r2].map((x) => x && [x.fresh, x.whenColour, x.accent]))})`);
        need(plain.length && plain.every((x) => !x.fresh), `${d}: other rows have no marker (${JSON.stringify(plain.filter((x) => x.fresh).map((x) => x.who))})`);
        need(d === "compact" ? heights.size === 1 : rows.every((x) => x.h >= 72 && x.h <= 76), `${d}: every row the same height (${JSON.stringify([...heights])})`);
        await page.screenshot({ path: shotPath(SMOKE, caseName(c), d === "compact" ? "4-drawer-compact" : "5-drawer-detailed") });
      }
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
    clearDensity(fx);
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
