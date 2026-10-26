// #581 e2e, the browser leg: sign in to the containerised dashboard with a code from `agend web --code`, open the
// instance's chat, send a message, and wait for the instance's reply (claude → mock API → AgEnD's reply tool).
//   PW_DIR=<dir with playwright-core> CHROME=<chrome> URL=http://localhost:19381 CODE=XXXX-XXXX INSTANCE=dev OUT=<dir> npx tsx e2e-browser.mts
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(process.env.PW_DIR + "/");
const { chromium } = require("playwright-core");
const URL = process.env.URL ?? "http://localhost:19381", OUT = process.env.OUT ?? ".", INSTANCE = process.env.INSTANCE ?? "dev";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const result: Record<string, unknown> = {};
try {
  await page.goto(`${URL}/signin`);
  await page.fill("#code", process.env.CODE!);
  await page.click("#go");
  await page.waitForURL(u => !u.pathname.startsWith("/signin"), { timeout: 15_000 });
  result.signedIn = page.url();
  await page.goto(`${URL}/ui/chat/${encodeURIComponent(INSTANCE)}`);
  await page.waitForSelector("#msgIn", { timeout: 20_000 });
  await page.screenshot({ path: join(OUT, "1-chat.png") });
  const said = `hello from the container e2e ${Date.now()}`;
  await page.fill("#msgIn", said);
  await page.keyboard.press("Enter");
  result.sent = said;
  const started = Date.now();
  await page.waitForFunction((s: string) => document.body.innerText.includes(`pong: ${s}`), said, { timeout: 120_000 });
  result.replyAfterMs = Date.now() - started;
  result.reply = `pong: ${said}`;
  await page.screenshot({ path: join(OUT, "2-reply.png") });
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = (err as Error).message;
  await page.screenshot({ path: join(OUT, "fail.png") }).catch(() => {});
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}
