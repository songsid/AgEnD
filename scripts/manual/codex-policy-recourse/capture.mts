/** M-3804: real dashboard, synthetic confirmed wait/task; no Fleet start, CLI, account or model.
 * Before frames retain the previous generic projection; dashboard layout is unchanged.
 * REPO=$PWD OUT=... PW_DIR=<playwright-core parent> CHROME=... tsx scripts/manual/codex-policy-recourse/capture.mts
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
import { publicRoster } from "../smoke-fixture/public-roster.mts";
import { codexPolicyRecourseCard } from "../../../src/backend/codex-policy-recourse.js";
import { setLocale } from "../../../src/locale.js";
import { deriveNeedsYou } from "../../../src/needs-you.js";
const out = resolve(process.env.OUT!); mkdirSync(out, { recursive: true });
const roster = publicRoster(3).map((r, i) => ({ ...r, displayName: ["General", "Review helper", "Build helper"][i] }));
const fx = await bootFixture({ roster, port: 0, instances: 3, classic: false });
const name = fx.instances[1]!.name, since = Date.now() - 12 * 60_000;
const checks: unknown[] = [];
try {
  for (const stage of (process.env.STAGES ?? "before,after").split(",")) {
    fx.fm.needsYouItems = () => deriveNeedsYou({ prompts: stage === "after" ? fx.fm.needsYouPrompts() : [], instances: [{ name, state: "awaiting_input",
      interaction: { kind: stage === "after" ? "policy_recourse" : "dialog", owner: "fixture", episode: 1, since },
      interactionSummary: "", ...(process.env.STATE === "handed" ? { policyHandoff: { done: 1, total: 1 } } : {}), policyTasks: ["M-100 — Review the proposed change"],
    }], deliveries: [], ownerOf: () => undefined });
    for (const c of matrix(process.env.MATRIX ?? "full")) {
      setLocale(c.lang);
      if (stage === "after") {
        const pane = readFileSync(new URL("../../../tests/fixtures/codex-policy-recourse-m3804/cyber-recourse.pane.txt", import.meta.url), "utf8");
        const card = codexPolicyRecourseCard(pane)!;
        await fx.fm.postRemoteCard(name, card);
        if (fx.fm.needsYouPrompts().filter((p: any) => p.policyRecourse).length !== 1) throw Error("actual remote-card projection missing");
      }
      const { page, ctx } = await fx.page(c, { path: "/ui/needs" });
      const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(err.message));
      try {
        fx.fm.emitSseEvent("needs", { items: fx.fm.needsYouItems() });
        const expected = stage === "before" ? (c.lang === "en" ? "Waiting at a dialog" : "停在對話框")
          : (c.lang === "en" ? "Codex's safety check blocked this turn" : "Codex 的安全檢查擋下了這一輪");
        await page.getByText(expected, { exact: false }).first().waitFor({ timeout: 12000 });
        await page.evaluate(() => document.fonts.ready);
        const card = page.locator(".n-item").first();
        const text = await card.innerText();
        if (stage === "after") {
          if (!text.includes("M-100") || !text.includes("Review helper")) throw Error("task or in-item agent missing");
          const labels = await card.locator("button").allTextContents();
          const handoff = c.lang === "en" ? "Hand to the dispatcher" : "交給派工的人處理";
          if (process.env.STATE === "handed") {
            if (labels.includes(handoff) || !text.includes(c.lang === "en" ? "Handed to the dispatcher" : "已交給派工的人處理")) throw Error("handoff status missing");
          } else if (labels[0] !== handoff || !await card.locator("button").first().evaluate((el: Element) => el.classList.contains("btn-primary"))) throw Error("primary handoff action missing");
          if (!text.includes(c.lang === "en" ? "1–3 are rewordings Codex suggests" : "範圍可能變小") || !text.includes(c.lang === "en" ? "doesn't continue the work" : "不會繼續工作")) throw Error("localized choice explanation missing");
          if (!["1. Explain the topic", "2. Describe safe practices", "3. Explain the risks", "4. Give feedback"].every(label => labels.includes(label))) throw Error("CLI choices missing: " + JSON.stringify(labels));
          if (!text.includes(c.lang === "en" ? "Pick a suggested rewrite to continue" : "可以選一個建議的改寫繼續")) throw Error("next step missing");
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        if (overflow || errors.length) throw Error(JSON.stringify({ overflow, errors }));
        const file = `${process.env.STATE === "handed" ? "handed" : stage}-${caseName(c)}.png`;
        await page.screenshot({ path: join(out, file), fullPage: false });
        checks.push({ stage, case: caseName(c), file, text, overflow, pageErrors: errors.length });
      } finally { await ctx.close(); fx.fm.retireRemoteCard(name, null, "fixture closed"); }
    }
  }
  if (process.env.PROBE_LONG === "1") {
    setLocale("en");
    const pane = readFileSync(new URL("../../../tests/fixtures/codex-policy-recourse-m3804/cyber-recourse.pane.txt", import.meta.url), "utf8")
      .replace("Explain the topic", "Explain the topic and its implications in detail without changing the scope of the existing task");
    await fx.fm.postRemoteCard(name, codexPolicyRecourseCard(pane)!);
    const { page, ctx } = await fx.page(matrix("phone-light-en")[0]!, { path: "/ui/needs" });
    try {
      fx.fm.emitSseEvent("needs", { items: fx.fm.needsYouItems() });
      await page.getByText("1. Explain the topic and its implications", { exact: false }).first().waitFor();
      const readGeometry = () => page.evaluate(() => {
        const button = [...document.querySelectorAll(".n-policy-recourse button")].find(e => e.textContent?.includes("1. Explain the topic")) as HTMLElement;
        return { pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, buttonOverflow: button.scrollWidth > button.clientWidth + 1,
          whiteSpace: getComputedStyle(button).whiteSpace, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, viewport: innerWidth };
      });
      // Use the already-loaded same-origin sheet for this temporary control; keep the real CSP intact.
      const control = await page.evaluate(() => {
        const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).origin === location.origin)!;
        const index = sheet.cssRules.length;
        sheet.insertRule(".n-policy-recourse .n-actions > button { white-space: nowrap !important; }", index);
        return { href: sheet.href, index };
      });
      const noWrap = await readGeometry();
      if (!noWrap.pageOverflow && !noWrap.buttonOverflow) throw Error("nowrap control was vacuous");
      await page.evaluate((c: { href: string; index: number }) => [...document.styleSheets].find(s => s.href === c.href)!.deleteRule(c.index), control);
      const geometry = await readGeometry();
      if (geometry.pageOverflow || geometry.buttonOverflow || geometry.whiteSpace !== "normal" || geometry.width > geometry.viewport) throw Error(JSON.stringify(geometry));
      writeFileSync(join(out, "long-choice-probe.json"), JSON.stringify({ controlledNoWrap: noWrap, final: geometry }, null, 2));
    } finally { await ctx.close(); fx.fm.retireRemoteCard(name, null, "probe closed"); }
  }
} finally { await fx.close(); }
writeFileSync(join(out, "checks.json"), JSON.stringify(checks, null, 2));
console.log(JSON.stringify({ count: checks.length, closed: true }));
