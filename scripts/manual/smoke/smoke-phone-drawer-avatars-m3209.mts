// M-3209 (the user, iPhone, beta.6: 「大頭被改壞了」): in the phone's ☰ drawer every agent row showed a squashed ~10 px avatar
// with its status dot beside it. #4008's drawer shrank `.av` to 10 px and hid only the letters, so a picture or an emoji
// stayed, squashed. The fixture's agents had no pictures, so its smoke never saw one. A real browser on the shared fixture
// (in-process FleetManager, scratch home, loopback only, fake agents), a phone (390×844, touch), light/dark; the agents get
// faces in the page (a picture for most, an emoji for one, a letter for one; the pictures are served by a route). Per case and
// density, judged and pictured with the drawer open:
//   detailed  every row's avatar at its normal size (≥ 24 px, round, not squashed), its picture filling it, its letter shown
//             where it has no picture; the dot on the avatar's bottom-right corner (not beside it, not on its face)
//   compact   no avatar at all; the dot alone, small
// Run it on the base too (SMOKE_NAME=…-before): detailed FAILs there, compact PASSes.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-drawer-avatars-m3209.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-drawer-avatars-m3209";
const webkit = process.env.PW_ENGINE === "webkit";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 8 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
// A face per agent: a round coloured picture with two eyes (so a squashed one shows in the pictures).
const FACE = (hue: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 60% 55%)"/>`
  + `<circle cx="22" cy="26" r="6" fill="#fff"/><circle cx="42" cy="26" r="6" fill="#fff"/><path d="M18 42 q14 12 28 0" stroke="#fff" stroke-width="5" fill="none"/></svg>`;
// Agents' faces as the status frame would carry them: names 0–5 a picture, 6 an emoji, 7 a letter (none).
const faces = (page: any) => page.evaluate(async (all: string[]) => {
  const m = await import("/assets/app-store.js");
  const face = (it: any) => {
    const i = all.indexOf(it.name);
    if (i >= 0 && i < 6) return { ...it, avatar: { kind: "image", src: `/ui/img/avatar/${encodeURIComponent(it.name)}?v=m3209` } };
    if (i === 6) return { ...it, avatar: { kind: "emoji", text: "🦊" } };
    return it;
  };
  const store = m.appStore as any;
  if (!store.__m3209) {
    const set = store.set.bind(store);
    store.set = (patch: any) => set((s: any) => {
      const n = typeof patch === "function" ? patch(s) : { ...s, ...patch };
      return n === s || !Array.isArray(n.instances) ? n : { ...n, instances: n.instances.map(face) };
    });
    store.__m3209 = true;
  }
  store.set((s: any) => ({ ...s }));
}, names);
const density = (page: any, value: "detailed" | "compact") => page.evaluate(async (v: string) => {
  const m = await import("/assets/instance-nav.js"); m.setSidebarDensity(v);
}, value);

try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW")) {
    if (c.device !== "phone") continue;
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route("**/ui/img/avatar/**", (route: any) => {
        const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() || "");
        route.fulfill({ status: 200, contentType: "image/svg+xml", body: FACE((Math.max(0, names.indexOf(name)) * 47) % 360) });
      });
      if (!webkit) { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(webkit && /ResizeObserver loop/.test(m))) errs.push(m.slice(0, 200)); });
    const boot: string[] = [];
    if (!(await mounted(page, 30000))) boot.push("the app mounted");
    await faces(page); await page.waitForTimeout(800);
    await page.locator("#sbOpen").tap(); await page.waitForTimeout(700);
    for (const d of ["detailed", "compact"] as const) {
      const failed = [...boot];
      const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
      await density(page, d); await faces(page); await page.waitForTimeout(900);   // the pictures load
      const r = await page.evaluate(() => {
        const sb = document.querySelector("#sidebar") as HTMLElement;
        const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0;
        const box = (e: Element) => { const b = (e as HTMLElement).getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; };
        return { open: !!sb && sb.getBoundingClientRect().left >= -1 && shown(sb),
          rows: [...sb.querySelectorAll(".v-inst")].filter(shown).map((row) => {
            const av = row.querySelector(".av"), img = av?.querySelector("img"), txt = av?.querySelector(".av-text"), dot = row.querySelector(".av-dot, .inst-status");
            return { av: av && shown(av) ? box(av) : null, img: img && shown(img) ? { ...box(img), loaded: (img as HTMLImageElement).naturalWidth > 0 } : null,
              txt: txt && shown(txt) ? (txt.textContent || "").trim() : null, dot: dot && shown(dot) ? box(dot) : null,
              dotAbs: dot ? getComputedStyle(dot).position === "absolute" : false, compactDot: !!dot?.classList.contains("inst-status") };
          }) };
      });
      need(r.open && r.rows.length >= 8, `the drawer is open with the agents (${r.open}, ${r.rows.length} rows)`);
      if (d === "detailed") {
        const bad = r.rows.map((x, i) => {
          if (!x.av) return `row ${i}: no avatar`;
          const why: string[] = [];
          if (x.av.w < 24 || Math.abs(x.av.w - x.av.h) > 0.5) why.push(`avatar ${x.av.w}×${x.av.h}`);
          if (!x.img && !x.txt) why.push("no picture, no letter");
          if (x.img && (!x.img.loaded || x.img.w < x.av.w - 1 || x.img.h < x.av.h - 1)) why.push(`picture ${x.img.w}×${x.img.h} loaded=${x.img.loaded}`);
          if (!x.dot) why.push("no dot");
          else {
            // On the avatar's bottom-right corner: its centre in the avatar's last quarter on both axes, and it overlaps the avatar.
            const cx = x.dot.l + x.dot.w / 2, cy = x.dot.t + x.dot.h / 2;
            const onCorner = cx >= x.av.l + x.av.w * 0.75 && cy >= x.av.t + x.av.h * 0.75 && x.dot.l < x.av.l + x.av.w && x.dot.t < x.av.t + x.av.h;
            if (!onCorner || !x.dotAbs) why.push(`dot ${JSON.stringify(x.dot)} not on the corner of ${JSON.stringify(x.av)}`);
          }
          return why.length ? `row ${i}: ${why.join(", ")}` : "";
        }).filter(Boolean);
        need(!bad.length, `detailed: each row's whole avatar with its dot on its corner (${bad.slice(0, 3).join(" | ")})`);
        need(r.rows.filter((x) => x.img).length >= 6 && r.rows.some((x) => x.txt), `pictures, an emoji and a letter all drawn (${r.rows.filter((x) => x.img).length} pictures, letters ${JSON.stringify(r.rows.map((x) => x.txt).filter(Boolean))})`);
      } else {
        const bad = r.rows.map((x, i) => x.av ? `row ${i}: an avatar ${x.av.w}×${x.av.h}` : !x.dot || !x.compactDot || x.dot.w > 12 ? `row ${i}: dot ${JSON.stringify(x.dot)}` : "").filter(Boolean);
        need(!bad.length, `compact: the dot alone, no avatar (${bad.slice(0, 3).join(" | ")})`);
      }
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), `drawer-${d}`) });
      results.push({ name: `${caseName(c)}-${d}`, ok: failed.length === 0, failed });
    }
    await p.ctx.close();
    // The density is a synced pref: put it back unset so the next case starts from the defaults (freshPage checks).
    (fx as any).fm.webPrefs.writeForViewer("operator", new Map<string, unknown>([["nav.density", null]]));
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
