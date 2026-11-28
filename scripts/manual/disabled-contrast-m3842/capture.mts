/**
 * M-3842 real-app capture: the chat's empty composer, whose Send button is off (the shared `.btn:disabled`, with the round
 * Send drawn as a quiet filled circle); and an agent's reply buttons once answered (the chosen one solid green, the rest off),
 * once expired (all off), and a closed poll (its tallies in --text-2). Desk light en, desk dark zh-TW, phone light en, phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/disabled-contrast-m3842/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const OUT = process.env.OUT!, REPO = process.env.REPO!; mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, classic: false, roster: [{ name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" }] });
const hist: any = (fx.fm as any).webChatHistory;
const at = (m: number) => new Date(Date.now() - m * 60000).toISOString();
hist.record({ instance: "general", sender: "general", role: "agent", ts: at(9), text: "The release notes are ready. Publish them now?",
  buttons: { id: "a".repeat(32), labels: ["Publish now", "Wait for review"], state: "chosen", chosen: 0, by: "Example owner" } });
hist.record({ instance: "general", sender: "general", role: "agent", ts: at(6), text: "Restart the build agent tonight?",
  buttons: { id: "b".repeat(32), labels: ["Yes, tonight", "Not yet"], state: "expired" } });
hist.record({ instance: "general", sender: "general", role: "agent", ts: at(3), text: "Which day suits the team demo?",
  buttons: { id: "c".repeat(32), labels: ["Tuesday", "Wednesday", "Friday"], state: "closed", poll: { deadline: Date.now() - 60000, answered: 5, multi: false, reveal: "close", rev: 2, counts: [3, 1, 1] } } });
try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c);
    const { page, ctx } = await fx.page(c, { path: "/ui/chat/general" });
    try {
      await page.goto(fx.base + "/ui/chat/general"); await page.waitForSelector(".btn-send", { timeout: 20000 }); await page.waitForTimeout(800);
      const s = await page.evaluate(`(() => { const b = document.querySelector(".btn-send"); const cs = getComputedStyle(b); return { disabled: b.disabled, opacity: cs.opacity, color: cs.color, bg: cs.backgroundColor, border: cs.borderStyle }; })()`) as any;
      check(`${tag}: the empty composer's Send is off, not faded`, s.disabled && s.opacity === "1", s);
      const rb = await page.evaluate(`[...document.querySelectorAll(".rb-btn")].map((b) => { const cs = getComputedStyle(b); return { t: b.innerText.trim(), off: b.disabled, chosen: b.classList.contains("chosen"), poll: !!b.closest(".rb-row.poll"), opacity: cs.opacity, border: cs.borderStyle, color: cs.color }; })`) as any[];
      check(`${tag}: reply and poll buttons: 7 drawn, all off, none faded`, rb.length === 7 && rb.every((b) => b.off && b.opacity === "1"), rb);
      check(`${tag}: the chosen answer keeps its solid edge; the others are dashed`, rb.filter((b) => b.chosen).length === 1 && rb.find((b) => b.chosen)?.border === "solid" && rb.filter((b) => !b.chosen).every((b) => b.border === "dashed"), rb);
      check(`${tag}: a closed poll's choices show their tallies`, rb.filter((b) => b.poll).every((b) => /· \d/.test(b.t)), rb.filter((b) => b.poll));
      const thread = await page.locator(".rb-row").first().boundingBox();
      if (thread) {
        const top = Math.max(0, thread.y - 70);
        const shotR = `m3842-${tag}-chat-replies.png`;
        await page.screenshot({ path: join(OUT, shotR), clip: { x: 0, y: top, width: c.device === "phone" ? 390 : 1366, height: c.device === "phone" ? 520 : 420 } });
        receipt.pictures.push({ path: shotR, sha256: createHash("sha256").update(readFileSync(join(OUT, shotR))).digest("hex") });
      }
      const shot = `m3842-${tag}-chat-send.png`;
      const box = await page.locator(".composer, .composer-row").first().boundingBox();
      await page.screenshot({ path: join(OUT, shot), ...(box ? { clip: { x: 0, y: Math.max(0, box.y - 40), width: c.device === "phone" ? 390 : 1366, height: Math.min(260, box.height + 80) } } : {}) });
      receipt.pictures.push({ path: shot, sha256: createHash("sha256").update(readFileSync(join(OUT, shot))).digest("hex") });
    } finally { await ctx.close(); }
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length; receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt-chat.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(`checks ${receipt.summary}`); process.exitCode = failed ? 1 : 0;
}
