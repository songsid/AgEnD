/**
 * M-3765 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services), for one checkout (REPO):
 * an agent whose folder is a scratch git repository that ignores soul.md, node_modules/, dist/, *.log and .env. In the chat's
 * ⋯ → Files & changes → Files:
 *  1 the folder's top: soul.md listed ("ignored by git"), the other ignored entries not;
 *  2 soul.md opened;
 *  3 "Show git-ignored files" on: node_modules, dist, debug.log, .env listed and marked; .env still hidden (not openable).
 * Desk and phone × light / dark × en / zh-TW on the fleet's own address, and desk light en + phone dark zh-TW over the public
 * link (the real gateway; only the tunnel and the Discord-side owner check are stubbed).
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/files-soul-ignored-m3765/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";
import { openPublicLink } from "../smoke-fixture/from-defaults.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], seen: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `m3765-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

// The agent's folder: a scratch repository with made-up content.
const work = mkdtempSync(join(tmpdir(), "m3765-work-"));
const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "example", GIT_AUTHOR_EMAIL: "example@example.test", GIT_COMMITTER_NAME: "example", GIT_COMMITTER_EMAIL: "example@example.test" } });
g("init", "-q", "-b", "main");
writeFileSync(join(work, ".gitignore"), "soul.md\nnode_modules/\ndist/\n*.log\n.env\n");
writeFileSync(join(work, "README.md"), "# Example project\n");
mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "app.js"), "console.log('example');\n");
g("add", "."); g("commit", "-q", "-m", "example");
writeFileSync(join(work, "soul.md"), "# Example agent — soul.md\n\n## Current state\n- Working on the example project.\n\n## Rules\n- Keep notes short.\n");
writeFileSync(join(work, "debug.log"), "example log\n");
writeFileSync(join(work, ".env"), "API_KEY=example-not-a-secret\n");
mkdirSync(join(work, "node_modules", "left-pad"), { recursive: true }); writeFileSync(join(work, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
mkdirSync(join(work, "dist")); writeFileSync(join(work, "dist", "app.js"), "built\n");

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "dev", backend: "claude-code", displayName: "Example developer", status: "running" },
] });
fx.fm.fleetConfig.instances.dev.working_directory = work;

const LIST = `(() => [...document.querySelectorAll(".ws-panel .ws-entry")].map((e) => ({ name: e.querySelector(".ws-name").textContent,
  meta: e.querySelector(".ws-meta").textContent, ignored: e.classList.contains("is-ignored"), disabled: e.querySelector("button").disabled })))()`;
async function openFiles(page: any, zh: boolean, phone: boolean) {
  const label = zh ? "檔案與變更" : "Files & changes";
  if (phone) {
    // A phone's ⋯ is a sheet (agent-sheet.js): its "Files & changes" tile.
    await page.locator(".chat-sheet-more").first().click();
    await page.locator(".chat-sheet-tile", { hasText: label }).first().click();
  } else {
    await page.getByRole("button", { name: zh ? "更多動作" : "More actions", exact: true }).first().click();   // the chat header's ⋯
    await page.locator("[role=menu]").first().waitFor({ timeout: 10000 }); await page.waitForTimeout(500);   // (a menu just opened can re-render once)
    await page.getByRole("menuitem", { name: label }).click();
  }
  await page.waitForSelector(".ws-panel", { timeout: 15000 });
  await page.locator(".ws-panel .seg-inline button").nth(1).click();
  await page.waitForSelector(".ws-panel .ws-entry", { timeout: 15000 });
  await page.waitForTimeout(500);
}
async function walk(page: any, tag: string, zh: boolean, phone: boolean) {
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await openFiles(page, zh, phone);
  const top = await page.evaluate(LIST) as any[];
  receipt.seen[`${tag}-top`] = top;
  const soul = top.find((e) => e.name === "soul.md");
  check(`${tag}: soul.md listed, marked ignored by git`, !!soul && soul.ignored && soul.meta.includes(zh ? "git 已忽略" : "ignored by git") && !soul.disabled, soul);
  check(`${tag}: the other ignored entries are not listed`, !top.some((e) => ["node_modules/", "dist/", "debug.log", ".env"].includes(e.name)), top.map((e) => e.name));
  const toggle = await page.evaluate(`(() => { const l = document.querySelector(".ws-ignored-toggle"), r = l && l.getBoundingClientRect(); return l ? { text: l.innerText.trim(), h: Math.round(r.height), checked: l.querySelector("input").checked } : null; })()`) as any;
  check(`${tag}: the toggle is there, off`, !!toggle && toggle.text === (zh ? "顯示 git 忽略的檔案" : "Show git-ignored files") && !toggle.checked, toggle);
  if (phone) check(`${tag}: the toggle is a 44 px row`, !!toggle && toggle.h >= 44, toggle);
  // A folder opens as its own listing: its chevron points right (collapsed), never down with nothing under it.
  const chevrons = await page.evaluate(`[...document.querySelectorAll(".ws-panel .ws-entry.t-dir .ws-entry-btn > .icon")].map((i) => getComputedStyle(i).transform)`) as string[];
  check(`${tag}: folders show a collapsed (right-pointing) chevron`, chevrons.length > 0 && chevrons.every((m) => /^matrix\(\s*0(\.0+)?(e-\d+)?,\s*-1/.test(m) || /^matrix\(\s*-?\d(\.\d+)?e-\d+,\s*-1/.test(m)), chevrons);
  await shot(page, `${tag}-1-top`);
  if (!soul || !toggle) { check(`${tag}: no page errors`, errors.length === 0, errors); return; }   // the release tip ("before"): nothing more to walk
  await page.locator(".ws-panel .ws-entry", { hasText: "soul.md" }).locator("button").click();
  await page.waitForSelector(".ws-panel .ws-text code", { timeout: 15000 });
  const text = await page.evaluate(`document.querySelector(".ws-panel .ws-text code").innerText`) as string;
  check(`${tag}: soul.md opens`, text.includes("Example agent — soul.md"), text.slice(0, 80));
  await shot(page, `${tag}-2-soul`);
  await page.locator(".ws-panel .ws-viewer-head button").first().click();
  await page.waitForSelector(".ws-panel .ws-ignored-toggle", { timeout: 15000 });
  await page.locator(".ws-panel .ws-ignored-toggle input").check();
  await page.locator(".ws-panel .ws-entry .ws-name", { hasText: /^node_modules\/$/ }).waitFor({ timeout: 15000 });   // (a string waitForFunction is eval: the page's CSP refuses it)
  await page.waitForTimeout(400);
  const all = await page.evaluate(LIST) as any[];
  receipt.seen[`${tag}-all`] = all;
  const by = (n: string) => all.find((e) => e.name === n);
  check(`${tag}: with the toggle, node_modules, dist and debug.log listed and marked`, ["node_modules/", "dist/", "debug.log"].every((n) => by(n)?.ignored), all.map((e) => [e.name, e.ignored]));
  check(`${tag}: .env listed, still hidden (not openable)`, !!by(".env") && by(".env").disabled && by(".env").meta.includes(zh ? "可能含有機密" : "may contain secrets"), by(".env"));
  check(`${tag}: tracked files unmarked`, !!by("README.md") && !by("README.md").ignored, by("README.md"));
  const scroll = await page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`) as any;
  check(`${tag}: no sideways scroll`, scroll.s <= scroll.w, scroll);
  await shot(page, `${tag}-3-ignored`);
  check(`${tag}: no page errors`, errors.length === 0, errors);
}

try {
  // Over the public link first (its viewer must start from defaults: the fleet's own pages below save theme and language):
  // the real gateway and routes, only the tunnel and the owner check stubbed.
  const link = await openPublicLink(fx);
  try {
    for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
      const tag = `link-${caseName(c)}`;
      const p = await link.publicPage(c, { path: "/ui/chat/dev" });
      try { check(`${tag}: on the public link`, p.page.url().startsWith(`https://${link.host}`) || p.base.includes(link.host), p.page.url()); await walk(p.page, tag, c.lang === "zh-TW", c.device === "phone"); }
      finally { await p.ctx.close(); }
    }
  } finally { await link.close(); }
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en")) {
    const tag = caseName(c);
    const { page, ctx } = await fx.page(c, { path: "/ui/chat/dev" });
    try { await page.goto(fx.base + "/ui/chat/dev"); check(`${tag}: mounted`, await mounted(page, 30000)); await walk(page, tag, c.lang === "zh-TW", c.device === "phone"); }
    finally { await ctx.close(); }
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
