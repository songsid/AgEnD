// Settings → Web appearance, the whole tab, filled with realistic state: an installed mod with effects, a long owner
// CSS sheet, a placed effect, cards and widgets. Full-page shots per case, plus overflow checks at phone width.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [MATRIX=full] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-appearance.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedPerson, seedAvatars, seedCards, seedWidgets, ownerCss, addSnowEffect, bigMod } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48700) });
const names = fx.instances.map(i => i.name);
const card = [names[4], names[33], "研一官網-t1544335726169165914"];
const seeded: any = { person: seedPerson(fx), avatars: Object.keys(await seedAvatars(fx, 20)).length, cards: await seedCards(fx, card), widgets: await seedWidgets(fx, card[0]) };
try { const id = addSnowEffect(fx, { kind: "human", id: "operator" }); seeded.effect = fx.fm.effectTools.apply(card[1], { id }); } catch (e) { seeded.effect = String(e).slice(0, 200); }
const PERSON = "person:operator";
try { const r: any = fx.fm.mods.stage(PERSON, await bigMod(fx));
  seeded.mod = !r.ok ? r : (({ ok, id, applied, error, detail }: any) => ({ ok, id, applied, error, detail }))(fx.fm.mods.commit(PERSON, { stage: r.stage, plan_hash: r.plan_hash, include: { theme: true, identity: true, effects: true }, target: card[2] }));
} catch (e) { seeded.mod = String(e).slice(0, 200); }
try { const r: any = fx.fm.ownerCss.save(PERSON, ownerCss()); seeded.css = r.ok ? fx.fm.ownerCss.keep(PERSON, r.trial ?? r.value?.trial) : r; } catch (e) { seeded.css = String(e).slice(0, 200); }
const out: any = { seeded, cases: {} };

for (const c of matrix(process.env.MATRIX ?? "full")) {
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(2500);
  const r: any = { errs };
  r.layout = await page.evaluate(`(() => { const W = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll(".p-settings *")].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > W + 1 || b.left < -1) && getComputedStyle(e).position !== "fixed"; })
      .filter(e => !e.closest("[aria-hidden=true], .sr-only") && !e.matches(".sr-only")).slice(0, 12)
      .map(e => (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).join(".") : e.tagName) + " " + Math.round(e.getBoundingClientRect().right) + " " + (e.textContent || "").trim().slice(0, 40));
    const small = [...document.querySelectorAll(".p-settings input, .p-settings select, .p-settings textarea")].filter(e => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).length;
    const tiny = [...document.querySelectorAll(".p-settings button, .p-settings a, .p-settings summary")].filter(e => { const b = e.getBoundingClientRect(); return e.offsetParent && b.height > 0 && b.height < 24; }).length;
    return { hscroll: document.scrollingElement.scrollWidth > W, height: document.scrollingElement.scrollHeight, over, iosZoomInputs: small, smallTargets: tiny,
      sections: [...document.querySelectorAll(".p-settings section.card > h3, .p-settings .card > h3")].map(h => h.textContent.trim()) }; })()`);
  // The tab is long: one full-page shot plus viewport shots of each section.
  await page.screenshot({ path: shotPath("settings-appearance", c, "0-full"), fullPage: true });
  const sections = await page.locator(".p-settings section.card").count();
  for (let i = 0; i < Math.min(sections, 12); i++) {
    const s = page.locator(".p-settings section.card").nth(i);
    await s.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(150);
    await s.screenshot({ path: shotPath("settings-appearance", c, `s${String(i).padStart(2, "0")}`) }).catch(() => {});
  }
  r.csp = await csp();
  out.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath("settings-appearance", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 6000));
await fx.close(); process.exit(0);
