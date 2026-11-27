/**
 * M-3842 real-app capture: the chat's empty composer, whose Send button is off (the shared `.btn:disabled`, with the round
 * Send drawn as a quiet filled circle). Desk light en, desk dark zh-TW, phone light en, phone dark zh-TW.
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
try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c);
    const { page, ctx } = await fx.page(c, { path: "/ui/chat/general" });
    try {
      await page.goto(fx.base + "/ui/chat/general"); await page.waitForSelector(".btn-send", { timeout: 20000 }); await page.waitForTimeout(800);
      const s = await page.evaluate(`(() => { const b = document.querySelector(".btn-send"); const cs = getComputedStyle(b); return { disabled: b.disabled, opacity: cs.opacity, color: cs.color, bg: cs.backgroundColor, border: cs.borderStyle }; })()`) as any;
      check(`${tag}: the empty composer's Send is off, not faded`, s.disabled && s.opacity === "1", s);
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
