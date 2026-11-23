// Product server/components in an isolated scratch Fleet; no CLI, account, live pane or model call.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [{ name: "demo-codex", backend: "codex", displayName: "Demo assistant" }] });
const { codexPrecaution } = await import(process.env.REPO + "/src/backend/codex-precaution.ts");
const { setLocale } = await import(process.env.REPO + "/src/locale.ts");
const fm = fx.fm, results = [];
let answers = 0;
const presentation = { state: "awaiting_input", execution_state: "working", interaction_summary: "Codex safety review", interaction: { phase: "waiting", kind: "safety_review", episode: 1, owner: { bootId: "demo", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 }, since: Date.now(), stale: false } };
fm.instancePresentation = () => presentation;
fm.getInstanceInteraction = () => presentation.interaction;
fm.daemons.set("demo-codex", { answerRemoteCard: async () => { answers++; return { outcome: "answered" }; } });
fm.startNeedsYou();
try {
  for (const c of matrix()) {
    setLocale(c.lang);
    const card = codexPrecaution(readFileSync(join(process.env.REPO!, "tests/fixtures/codex-0169-precaution-stopped.pane.txt"), "utf8"))!.card;
    await fm.postRemoteCard("demo-codex", card); fm.needsYou.recompute();
    const { page, ctx } = await fx.page(c, { path: "/ui/chat/demo-codex", host: true });
    const label = c.lang === "en" ? "1. Start a new chat" : "1. 開始新對話";
    const prefix = `${c.device}-${c.theme}-${c.lang}`;
    await page.getByRole("button", { name: label, exact: true }).waitFor();
    await page.screenshot({ path: join(out, `${prefix}-card.png`) });
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({ path: join(out, `${prefix}-confirm.png`) });
    if (answers !== 0) throw new Error("An action happened before confirmation");
    await page.getByRole("dialog").getByRole("button", { name: c.lang === "en" ? "Cancel" : "取消", exact: true }).click();
    await page.goto(fx.base + "/ui/needs");
    await page.getByRole("button", { name: label, exact: true }).waitFor();
    await page.screenshot({ path: join(out, `${prefix}-needs.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    results.push({ ...c, overflow, answers });
    if (overflow) throw new Error("Horizontal overflow");
    await ctx.close();
  }
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
} finally { await fm.needsYou.stop(); fm.daemons.clear(); await fx.close(); }
