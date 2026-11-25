// M-3757 real-app captures: the Needs-you card for Claude Code 2.1.332's usage-credits prompt, and the confirm step a
// credits choice asks for. Real web HTTP, sessions and DOM (scripts/manual/smoke-fixture), inert agents; the card is the
// one AgEnD reads from the live 2.1.332 capture (tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt),
// posted through FleetManager.postRemoteCard as the daemon's remote_card would. No CLI, account or Fleet start.
//   REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir> npx tsx scripts/manual/claude-usage-credits-m3757/capture.mts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const smoke = "claude-usage-credits-m3757", OUT = process.env.OUT!, REPO = process.env.REPO!;
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const { claudeUsageCreditsPrompt } = await import(REPO + "/src/backend/claude-usage-credits.ts");
const { setLocale } = await import(REPO + "/src/locale.ts");
const LIVE = readFileSync(join(REPO, "tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt"), "utf8");

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "lumen", displayName: "Lumen", backend: "claude-code" }, { name: "atlas", displayName: "Atlas", backend: "codex" },
] });
// The daemon's side, as smoke-codex-stopped-m3519 does: the instance waits at a dialog, and an answer would go to its daemon
// (counted: the confirmation must come before any key).
const fm = fx.fm;
let answers = 0;
const presentation = { state: "awaiting_input", execution_state: "working", interaction_summary: "Waiting at a dialog",
  interaction: { phase: "waiting", kind: "dialog", episode: 1, owner: { bootId: "demo", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 }, since: Date.now(), observedAt: Date.now(), confirmedAt: Date.now(), stale: false, suspected: false } };
fm.instancePresentation = () => presentation;
fm.getInstanceInteraction = () => presentation.interaction;
fm.daemons.set("lumen", { answerRemoteCard: async () => { answers++; return { outcome: "answered" }; } });
fm.startNeedsYou();
try {
  for (const [device, lang, theme] of [["desk", "en", "light"], ["desk", "zh-TW", "dark"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    const c = { device, lang, theme } as const, tag = `${device}-${lang}-${theme}`;
    setLocale(lang === "zh-TW" ? "zh-TW" : "en");                   // the card's confirmation words are the fleet's language
    const card = claudeUsageCreditsPrompt(LIVE)!.card;
    await fm.postRemoteCard("lumen", card); fm.needsYou.recompute();
    const { ctx, page } = await fx.page(c, { path: "/ui/needs", host: true });
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    try {
      const item = page.getByText("Switch to Opus 5.5 and continue").first();
      await item.waitFor({ state: "visible", timeout: 20_000 });
      const body = await page.locator("body").innerText();
      check(`${tag}: Needs you shows the prompt and both of its choices`, body.includes("Fable 5.2 now uses usage credits") && body.includes("Continue with Fable 5.2"), body.slice(0, 400));
      check(`${tag}: no Esc / Skip choice is offered`, !/\bSkip\b|略過/.test(body.split("Fable 5.2 now uses usage credits")[1] ?? ""), null);
      let path = shotPath(smoke, tag, "1-needs-card"); await page.screenshot({ path }); receipt.pictures.push(path);
      await page.getByRole("button", { name: "2. Continue with Fable 5.2", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const words = await dialog.innerText();
      check(`${tag}: the credits choice asks to be confirmed first`, lang === "en" ? /Spend usage credits\?/.test(words) : /要使用用量點數嗎？/.test(words), words);
      check(`${tag}: no key went to the pane before the confirmation`, answers === 0, answers);
      path = shotPath(smoke, tag, "2-confirm-credits"); await page.screenshot({ path }); receipt.pictures.push(path);
      await dialog.getByRole("button", { name: lang === "en" ? "Cancel" : "取消", exact: true }).click();
      await page.waitForTimeout(300);
      check(`${tag}: cancelled, still no answer sent`, answers === 0, answers);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      check(`${tag}: no horizontal overflow`, !overflow, overflow);
      check(`${tag}: cancelling the confirmation leaves the card (nothing answered)`, (await page.getByText("Continue with Fable 5.2").count()) > 0, null);
      check(`${tag}: no page errors`, errors.length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally {
  await fm.needsYou?.stop?.(); fm.daemons.clear();
  receipt.pictures = receipt.pictures.map((p: string) => ({ path: p.split("/").slice(-2).join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }));
  writeFileSync(join(OUT, smoke, "receipt.json"), JSON.stringify(receipt, null, 2));
  await fx.close();
}
const failed = receipt.checks.filter((x: any) => !x.ok);
console.log(failed.length ? `FAIL ${failed.length}` : `PASS ${receipt.checks.length}`);
process.exit(failed.length ? 1 : 0);
