// Effect safety through the product: a chat effect plays on the real /ui/chat page; the page's main thread is kept busy
// until the host budget pauses it; the person resumes it from ⋯ → Effects. The third pause turns it durably off: it stays
// off after a reload, and Resume is refused. (Unit-level sequence: scripts/manual/effect-safety-1629.mts.)
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [MATRIX=desk-light-en] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-effect-safety.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedPerson, seedChat, addSnowEffect } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48800) });
const target = fx.instances[6].name;
seedPerson(fx); await seedChat(fx, [target], 20);
const effect = addSnowEffect(fx, { kind: "agent", id: target });
const applied = fx.fm.effectTools.apply(target, { id: effect });
const out: any = { target, applied, cases: {} };
const enc = encodeURIComponent;

for (const c of matrix(process.env.MATRIX ?? "desk-light-en")) {
  const { ctx, page, csp } = await fx.page(c, { storage: { agend_html_preview: "on" }, prefs: { "preview.optIn": true, "fx.show": true } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  const steps: any[] = [];
  const shot = (n: string) => page.screenshot({ path: shotPath("effect-safety", c, n), fullPage: false });
  const frames = () => page.evaluate(`document.querySelectorAll("iframe.agend-effect-frame").length`) as Promise<number>;
  // A function predicate: a string one is compiled in the page, and the dashboard's CSP refuses eval.
  const waitFrames = (playing: boolean, ms: number) => page.waitForFunction((on: boolean) => (document.querySelectorAll("iframe.agend-effect-frame").length > 0) === on, playing, { timeout: ms, polling: 250 }).then(() => true).catch(() => false);
  const history = () => page.evaluate(`Object.keys(localStorage).filter(k => k.startsWith("agend_effect_safety_v1:")).map(k => k.split(":")[1]).sort().join(",")`);
  const blur = () => page.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  const toasts = () => page.evaluate(`[...document.querySelectorAll(".toast, [role=status], [role=alert]")].map(t => t.textContent.trim()).filter(Boolean).slice(-3)`);
  const dialog = async (n: string, resume: boolean) => {
    await page.locator(".p-chat button[aria-haspopup=menu]").first().click(); await page.waitForTimeout(300);
    await page.locator(".menu-list [role=menuitem]", { hasText: c.lang === "zh-TW" ? "效果" : "Effects" }).click(); await page.waitForTimeout(1000);
    const text = await page.evaluate(`[...document.querySelectorAll("dialog[open] section, dialog[open] p")].map(s => s.textContent.replace(/\\s+/g, " ").trim()).slice(0, 6)`);
    await shot(n);
    let toast = null;
    if (resume) {
      await page.locator("dialog[open] section button", { hasText: c.lang === "zh-TW" ? "恢復" : "Resume" }).first().click(); await page.waitForTimeout(600);
      toast = await toasts();
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(400); await blur();
    return { text, toast };
  };
  const stress = async () => {
    const t0 = Date.now();
    // About 75% of each 200 ms busy: well over the long-task budget and below the frame-rate floor.
    await page.evaluate(`window.__busy = setInterval(() => { const t = performance.now(); while (performance.now() - t < 150); }, 200)`);
    const paused = await waitFrames(false, 45000);
    await page.evaluate(`clearInterval(window.__busy)`);
    return { paused, ms: Date.now() - t0 };
  };

  await page.goto(`${fx.base}/ui/chat/${enc(target)}`); await page.waitForTimeout(1500); await blur();
  steps.push({ step: "open", playing: await waitFrames(true, 20000), frames: await frames() });
  await shot("0-playing");
  for (let round = 1; round <= 3; round++) {
    const s = await stress();
    await page.waitForTimeout(800);
    const view = await dialog(`${round}-paused`, false);
    steps.push({ step: `pause ${round}`, ...s, history: await history(), dialog: view.text });
    // A reload, as a person would, then Resume from the dialog.
    await page.reload(); await page.waitForTimeout(2000); await blur();
    const before = await frames();
    const resumed = await dialog(`${round}-resume`, true);
    const playing = await waitFrames(true, 15000);
    steps.push({ step: `resume ${round}`, framesAfterReload: before, toast: resumed.toast, dialog: resumed.text, playing, history: await history() });
    if (round === 3 || !playing) break;
  }
  await page.reload(); await page.waitForTimeout(2500); await blur();
  const finalView = await dialog("4-off-after-reload", true);
  steps.push({ step: "final", frames: await frames(), stillOff: !(await waitFrames(true, 8000)), dialog: finalView.text, toast: finalView.toast, history: await history() });
  await shot("5-final");
  out.cases[caseName(c)] = { steps, csp: await csp(), errs };
  await ctx.close();
}
writeFileSync(shotPath("effect-safety", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 8000));
await fx.close(); process.exit(0);
