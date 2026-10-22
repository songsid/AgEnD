// Fixture probe: boots the shared realistic fixture, seeds everything, and shoots the main pages, to prove it loads.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [MATRIX=quick] npx --prefix <checkout> tsx scripts/manual/smoke/probe-fixture.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedPerson, seedAvatars, seedCards, seedIdentityColors, seedWidgets, seedChat, seedUsage, addSnowEffect } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48100) });
const names = fx.instances.map(i => i.name);
const card = [names[4], names[33], "研一官網-t1544335726169165914"];
const seeded = {
  person: seedPerson(fx),
  avatars: await seedAvatars(fx, 30),
  cards: await seedCards(fx, card),
  colors: seedIdentityColors(fx, names.slice(1, 13)),
  widgets: await seedWidgets(fx, card[0]),
  chat: await seedChat(fx, card, 40),
  usage: await seedUsage(fx),
  effect: (() => { try { const id = addSnowEffect(fx, { kind: "agent", id: card[0] }); return fx.fm.effectTools.apply(card[0], { id }); } catch (e) { return String(e); } })(),
};
const out: any = { instances: fx.instances.length, seeded, cases: {} };
const enc = encodeURIComponent;
for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const { ctx, page, csp } = await fx.page(c);
  const shots: Array<[string, string]> = [["chat", `/ui/chat/${enc(card[0])}`], ["chat-cjk", `/ui/chat/${enc(card[2])}`], ["details", `/ui/fleet/agent/${enc(card[0])}`],
    ["org", "/ui/fleet/org"], ["look", "/settings/look"], ["view", `/view/${enc(card[1])}`], ["needs", "/ui/needs"]];
  for (const [name, path] of shots) {
    await page.goto(fx.base + path); await page.waitForTimeout(1500);
    await page.screenshot({ path: shotPath("probe", c, name), fullPage: false });
  }
  out.cases[caseName(c)] = { csp: await csp(), lang: await page.evaluate("document.documentElement.lang"), theme: await page.evaluate("document.documentElement.getAttribute('data-theme')") };
  await ctx.close();
}
writeFileSync(shotPath("probe", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
await fx.close(); process.exit(0);
