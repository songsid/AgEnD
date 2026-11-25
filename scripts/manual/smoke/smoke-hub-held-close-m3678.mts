/** Real dashboard/server, synthetic held-work port; no Fleet, CLI, vendor or real account. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const before = process.env.STAGE === "before";
const copyOnly = process.env.CAPTURE_ONLY === "copy";
const fx = await bootFixture({ port: 0, classic: false, host: true,
  roster: [{ name: "demo-helper", backend: "codex", displayName: "Demo helper" }] });
const fm = fx.fm, results: unknown[] = [];
let held: any[] = [], closes = 0;
fm.attachHubExecutionAttention(() => held, () => "queued", async (id: string) => {
  closes++; held = held.filter(item => item.id !== id); return "closed";
});
fm.startNeedsYou();
try {
  for (const c of matrix()) {
    held = [{ id: "hold:demo-uncertain", kind: "hold", agent: "demo-helper", messageId: "demo-uncertain", exposureId: "demo-exposure", since: Date.now() - 9 * 60_000, close: true },
      { id: "hold:demo-retry", kind: "hold", agent: "demo-helper", messageId: "demo-retry", exposureId: "demo-exposure", since: Date.now() - 4 * 60_000, retry: true, close: true }];
    fm.needsYou.recompute();
    const { page, ctx } = await fx.page(c, { path: "/ui/needs", host: true });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    const retry = c.lang === "en" ? "Try again" : "再試一次";
    const close = c.lang === "en" ? "Close this question" : "不處理這題";
    await page.getByRole("button", { name: retry, exact: true }).waitFor();
    const stem = `${c.device}-${c.theme}-${c.lang}`;
    await page.screenshot({ path: join(out, `${stem}-held.png`) });
    if (before) {
      if (await page.getByRole("button", { name: close, exact: true }).count()) throw Error("Base unexpectedly offers close");
    } else {
      const uncertain = page.locator(".n-item").filter({ has: page.getByRole("button", { name: close, exact: true }) })
        .filter({ hasNot: page.getByRole("button", { name: retry, exact: true }) });
      const button = uncertain.getByRole("button", { name: close, exact: true });
      const box = await button.boundingBox();
      if (c.device === "phone" && (!box || box.height < 44 || box.width < 44)) throw Error("Small close tap target");
      const count = closes;
      await button.click(); await page.getByRole("dialog").waitFor();
      if (closes !== count) throw Error("Closed before confirmation");
      if (await page.getByText(c.lang === "en" ? "Closing…" : "結束中…", { exact: true }).count()) throw Error("Premature closing label");
      await page.screenshot({ path: join(out, `${stem}-confirm.png`) });
      await page.getByRole("dialog").getByRole("button", { name: c.lang === "en" ? "Cancel" : "取消", exact: true }).click();
      await button.click(); await page.getByRole("dialog").waitFor();
      const response = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/needs/hub-close");
      await page.getByRole("dialog").getByRole("button", { name: c.lang === "en" ? "Close question" : "不處理這題", exact: true }).click();
      if ((await response).status() !== 200) throw Error("Close refused");
      await page.waitForFunction(() => document.querySelectorAll(".n-item").length === 1);
      await page.waitForFunction(() => { const e = document.querySelector(".toast.ok"); return !!e && Number(getComputedStyle(e).opacity) > .99; });
      if (closes !== count + 1) throw Error("Wrong close count");
      if (!copyOnly) await page.screenshot({ path: join(out, `${stem}-closed.png`) });
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw Error(JSON.stringify({ overflow, errors }));
    results.push({ ...c, overflow, errors, closes }); await ctx.close();
  }
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ stage: before ? "before" : "after", captureOnly: copyOnly ? "held-confirm" : "all",
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.REPO, encoding: "utf8" }).trim(), results }, null, 2));
} finally { await fm.needsYou.stop(); await fx.close(); }
