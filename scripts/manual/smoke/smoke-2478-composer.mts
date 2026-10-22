// #2478 (the user's report, beta.26 on iOS Safari) from defaults (fleet decision a78ebdc5), through visible UI:
// 1. The composer's placeholder names the agent by its display name (its id when it has none), on one line ending in
//    "…" — a long id used to wrap the box to two lines.
// 3. On a touch screen (a coarse pointer) the keyboard's Return is a new line, not Send; only the Send button sends.
//    enterkeyhint is "enter". On a desk (a fine pointer) Enter still sends and Shift+Enter is a new line.
// Cases: phone (390×844, touch) light en and dark zh-TW, desk light en. Agents: one with a long display name, one with a
// long id and none. The box's height is measured empty against one line of typed text.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2478-composer.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2478-composer", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48822), instances: 6 });
const NICK = "agend-leader-t1503382358143799511", BARE = "agend-dev-claude-t1519896892392083558";
const nick = String(fx.fm.fleetConfig.instances[NICK]?.display_name ?? "");
const r: any = { label: LABEL, nick, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const BOX = `(() => { const el = document.querySelector("#msgIn"); if (!el) return null; const cs = getComputedStyle(el);
  return { h: Math.round(el.getBoundingClientRect().height), placeholder: el.placeholder, value: el.value, hint: el.getAttribute("enterkeyhint"),
    lineH: parseFloat(cs.lineHeight) || 0, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c, { path: `/ui/chat/${NICK}` }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const sends: string[] = [];
  page.on("request", (q: any) => { if (q.method() === "POST" && /\/ui\/send\b/.test(q.url())) sends.push(q.postData() ?? ""); });
  try {
    ok(res, "mounted", await mounted(page));
    const box = page.locator("#msgIn");
    await box.waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const empty = await page.evaluate(BOX) as any;
    await page.locator(".dock").screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-placeholder`) });
    // One line of typed text: the height a one-line box has.
    await box.fill("x"); await page.waitForTimeout(100);
    const one = await page.evaluate(BOX) as any;
    await box.fill(""); await page.waitForTimeout(100);
    ok(res, "placeholderNamesDisplayName", empty.placeholder.includes(nick) && !empty.placeholder.includes(NICK), empty.placeholder);
    ok(res, "emptyBoxIsOneLine", empty.h <= one.h, [empty.h, one.h]);
    // The agent with no display name: its id, still one line.
    await page.goto(`${p.base}/ui/chat/${BARE}`); await box.waitFor({ timeout: 10000 }); await page.waitForTimeout(300);
    const bare = await page.evaluate(BOX) as any;
    await page.locator(".dock").screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-id-placeholder`) });
    ok(res, "placeholderFallsBackToId", bare.placeholder.includes(BARE), bare.placeholder);
    ok(res, "idBoxIsOneLine", bare.h <= one.h, [bare.h, one.h]);
    // Return / Enter.
    await box.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const afterEnter = await page.evaluate(BOX) as any;
    await page.locator(".dock").screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-after-return`) });
    if (c.device === "phone") {
      ok(res, "returnIsNewline", afterEnter.value === "first line\n" && sends.length === 0, [JSON.stringify(afterEnter.value), sends.length]);
      ok(res, "enterKeyHintNotSend", afterEnter.hint === "enter", afterEnter.hint);
      await page.keyboard.type("second line");
      await page.locator("#sendBtn").tap();
      await page.waitForTimeout(600);
      const afterSend = await page.evaluate(BOX) as any;
      ok(res, "sendButtonSends", sends.length === 1 && sends[0].includes("first line\\nsecond line") && afterSend.value === "", [sends.length, JSON.stringify(afterSend.value)]);
    } else {
      ok(res, "deskEnterSends", sends.length === 1 && afterEnter.value === "", [sends.length, JSON.stringify(afterEnter.value)]);
      await page.keyboard.type("a"); await page.keyboard.press("Shift+Enter"); await page.keyboard.type("b");
      const shift = await page.evaluate(BOX) as any;
      ok(res, "deskShiftEnterNewline", shift.value === "a\nb" && sends.length === 1, JSON.stringify(shift.value));
      ok(res, "deskNoEnterKeyHint", afterEnter.hint === null, afterEnter.hint);
    }
    ok(res, "noOverflow", !empty.overflow && !bare.overflow);
    res.measured = { empty, one, bare };
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
