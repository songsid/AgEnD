/** Serial headless WSL browser; scratch Fleet web server only. No agent/CLI or live Fleet is started. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const out = process.env.OUT!;
mkdirSync(out, { recursive: true });
// Fixture launch uses Playwright's headless default; never override it with headed mode.
const fixture = await bootFixture({ port: Number(process.env.HP ?? 19679), instances: 3, classic: false, host: true });
const checks: unknown[] = [];
const check = (key: string, ok: boolean, detail?: unknown) => { checks.push({ key, ok, detail }); if (!ok) throw Error(key); };
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const { page, ctx, csp } = await fixture.page(c, { path: "/settings/chat" });
    try {
      const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
      const card = page.locator("#connector"); await card.getByRole("button", { name: c.lang === "en" ? "Copy setup prompt" : "複製設定提示詞", exact: true }).waitFor();
      await card.scrollIntoViewIfNeeded();
      const selects = card.locator("select");
      for (const app of ["claude", "codex", "generic"]) {
        await selects.first().selectOption(app);
        await card.getByRole("button").click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        check(`${caseName(c)}:${app}:copy`, copied.includes("connect") && copied.includes("--home") && !copied.includes(fixture.fm.webToken));
      }
      const metrics = await card.evaluate((el: HTMLElement) => ({ width: el.scrollWidth, frame: el.clientWidth,
        controls: [...el.querySelectorAll("button,select,summary")].map(node => ({ tag: node.tagName, h: node.getBoundingClientRect().height, w: node.getBoundingClientRect().width })) }));
      check(`${caseName(c)}:no-overflow`, metrics.width <= metrics.frame + 1, metrics);
      check(`${caseName(c)}:tap`, metrics.controls.every((r: any) => r.h >= 44 && r.w >= 44), metrics);
      await card.screenshot({ path: join(out, `${caseName(c)}-card.png`) });
      await card.locator("summary").click();
      check(`${caseName(c)}:prompt`, (await card.locator("textarea").inputValue()).includes("mcpServers"));
      check(`${caseName(c)}:prompt-scroll`, await card.locator("textarea").evaluate((el: HTMLTextAreaElement) => {
        el.scrollTop = el.scrollHeight; const reached = el.scrollHeight - el.scrollTop <= el.clientHeight + 1; el.scrollTop = 0; return reached;
      }));
      // A phone card is taller than one viewport. Extend capture height only after the original 390×844 layout/tap
      // checks, so the image records the whole card instead of stitching a white band below the viewport.
      if (c.device === "phone") await page.setViewportSize({ width: 390, height: Math.ceil(await card.evaluate((el: HTMLElement) => el.getBoundingClientRect().height)) + 160 });
      await card.screenshot({ path: join(out, `${caseName(c)}-prompt.png`) });
      check(`${caseName(c)}:errors`, errors.length === 0 && (await csp()).length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally { await fixture.close(); writeFileSync(join(out, "receipt.json"), JSON.stringify({ checks }, null, 2)); }
