// Mod import with effects, end to end: import a mod near its caps (eight effects, two placed in its theme) from
// Settings → Web appearance, install it on an agent, then open that agent's chat and see the effects play.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [MATRIX=quick] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-mod-effects.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath, seedPerson, seedAvatars, seedChat, bigMod } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48600) });
const names = fx.instances.map(i => i.name);
const target = names[5];
seedPerson(fx); await seedAvatars(fx, 12); await seedChat(fx, [target], 30);
const file = join(process.env.OUT ?? ".", "mod-effects-bundle.agendmod.json");
writeFileSync(file, await bigMod(fx));
const enc = encodeURIComponent;
const out: any = { target, bytes: (await import("node:fs")).statSync(file).size, cases: {} };

for (const c of matrix(process.env.MATRIX ?? "quick")) {
  for (const m of fx.fm.mods.list().mods) fx.fm.mods.uninstall(m.id);
  fx.fm.themeStore.reset(target, "human");
  const { ctx, page, csp } = await fx.page(c, { storage: { agend_html_preview: "on" }, prefs: { "preview.optIn": true, "fx.show": true } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (process.env.DEBUG_ALLOC) await page.route("**/effect-policy.js", async (route: any) => { const res = await route.fetch(); let body = await res.text();
    body = body.replace("    }\n  }\n  return result;\n}", "    }\n  }\n  console.log('ALLOC ' + JSON.stringify({ result, context, d: descriptors.map(d => ({ ...d, element: undefined })) }).slice(0, 1500));\n  return result;\n}");
    await route.fulfill({ response: res, body }); });
  const r: any = { errs, preview: [] as string[], console: [] as string[] };
  page.on("request", (q: any) => { const u = q.url(); if (/:\d+\/(frame|effect|fx)/.test(u) || u.includes(String(Number(process.env.HP ?? 48600) + 1))) r.preview.push(q.method() + " " + u.slice(0, 120)); });
  page.on("console", (m: any) => { if (m.type() !== "debug") r.console.push(m.type() + ": " + m.text().slice(0, 200)); });
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(1500);
  await page.locator(".s-mods input[type=file]").setInputFiles(file);
  await page.waitForSelector(".s-mod-plan", { timeout: 15000 }).catch(() => {});
  r.stageError = await page.evaluate(`document.querySelector(".s-mods .err")?.textContent ?? null`);
  r.plan = await page.evaluate(`(() => { const p = document.querySelector(".s-mod-plan"); if (!p) return null;
    return { title: p.querySelector("h4")?.textContent, warn: p.querySelector(".s-mod-warn")?.textContent ?? null, text: p.textContent.replace(/\\s+/g, " ").slice(0, 600),
      hscroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth }; })()`);
  await page.locator(".s-mod-plan").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: shotPath("mod-effects", c, "1-plan"), fullPage: false });
  try {
    await page.selectOption(".s-mod-plan select", target); await page.waitForTimeout(200);
    await page.click(".s-mod-plan .btn-primary"); await page.waitForTimeout(2000);
  } catch (e) { r.installError = String(e).slice(0, 200); }
  r.installed = fx.fm.mods.list().mods.map((m: any) => ({ name: m.name, target: m.target, parts: m.parts }));
  r.placed = (fx.fm.themeStore.get(target).theme as any)?.effects ?? null;
  await page.screenshot({ path: shotPath("mod-effects", c, "2-installed"), fullPage: false });

  // The chat: the placed effects mount as sandboxed frames over the thread and draw.
  await page.goto(`${fx.base}/ui/chat/${enc(target)}`);
  const frames = (ms: number) => page.waitForFunction(() => { const f = [...document.querySelectorAll("iframe.agend-effect-frame")];
    return f.length > 0 && f.every(x => getComputedStyle(x).visibility === "visible") ? f.length : 0; }, undefined, { timeout: ms }).then((h: any) => h.jsonValue()).catch(() => 0);
  await page.waitForTimeout(1500);
  // A focused composer is a foreground barrier: agent front effects wait until focus leaves it.
  r.focused = await page.evaluate(`document.activeElement?.matches?.("input,textarea,[contenteditable]") ? document.activeElement.className || document.activeElement.tagName : null`);
  r.framesWhileFocused = await frames(6000);
  await page.screenshot({ path: shotPath("mod-effects", c, "3-chat-focused"), fullPage: false });
  await page.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  r.frames = await frames(20000);
  r.gate = await page.evaluate(`({ preview: window.AgendPreview?.availability?.() ?? null, optedIn: localStorage.getItem("agend_html_preview"),
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, visible: document.visibilityState, previewOrigin: document.body.dataset.previewOrigin ?? null })`);
  await page.waitForTimeout(1500);
  const a = await page.screenshot({ path: shotPath("mod-effects", c, "4-chat-a"), fullPage: false });
  await page.waitForTimeout(700);
  const b = await page.screenshot({ path: shotPath("mod-effects", c, "5-chat-b"), fullPage: false });
  r.animates = Buffer.compare(a, b) !== 0;
  // An effect frame must stay see-through: a colour-scheme mismatch with the page makes Chromium paint it opaque.
  r.frameScheme = await page.evaluate(`[...document.querySelectorAll("iframe.agend-effect-frame")].map(f => getComputedStyle(f).colorScheme)`);
  r.seeThrough = await page.locator("iframe.agend-effect-frame").first().screenshot({ path: shotPath("mod-effects", c, "4b-frame") }).then(() => true).catch(() => null);
  // A string, not a function: tsx wraps arrow functions with a __name helper the page does not have.
  r.layout = await page.evaluate(`(() => { const W = innerWidth, H = innerHeight;
    const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const msgs = [...document.querySelectorAll(".p-chat .msg, .p-chat [data-msg], .p-chat .bubble")].filter(m => { const b = m.getBoundingClientRect(); return b.height > 0 && b.bottom > 0 && b.top < H; }).length;
    const at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0] : null; };
    return { msgs, frames: [...document.querySelectorAll("iframe.agend-effect-frame")].map(rect), layer: rect(document.querySelector(".agend-effect-layer")),
      thread: rect(document.querySelector(".p-chat .thread, .p-chat .msgs")), composer: rect(document.querySelector(".composer")), nav: rect(document.querySelector(".tabbar, .bottom-nav, nav.tabs")),
      center: at(W / 2, H / 2), bottom: at(W / 2, H - 30), bodyBg: getComputedStyle(document.body).backgroundColor, path: location.pathname }; })()`);
  // The ⋯ menu → Effects: each placed effect should say Running.
  try {
    await page.locator(".p-chat button[aria-haspopup=menu]").first().click(); await page.waitForTimeout(300);
    await page.locator(".menu-list [role=menuitem]", { hasText: c.lang === "zh-TW" ? "效果" : "Effects" }).click(); await page.waitForTimeout(1200);
    r.dialog = await page.evaluate(`[...document.querySelectorAll("dialog[open] section")].map(s => s.textContent.replace(/\\s+/g, " ").trim().slice(0, 120))`);
    await page.screenshot({ path: shotPath("mod-effects", c, "6-effects-dialog"), fullPage: false });
  } catch (e) { r.dialogError = String(e).slice(0, 200); }
  r.csp = await csp();
  out.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath("mod-effects", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 6000));
await fx.close(); process.exit(0);
