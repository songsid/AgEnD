// M-3730 real-app captures: zh-TW times are a 24-hour clock (00:19, never 上午12:19) and zh durations say 小時/分鐘;
// English keeps its format. Three screens, en and zh-TW: a chat thread's message times, the session menu (its expiry
// time and idle span) and Fleet → Usage (when it was read). Real web HTTP, sessions and DOM
// (scripts/manual/smoke-fixture), inert agents, two synthetic chat messages; headless Linux only. The
// browser's zone is set so that "now" is in the midnight hour, the case the user saw.
//   REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir> npx tsx scripts/manual/zh-clock-m3730/capture.mts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const smoke = "zh-clock-m3730", OUT = process.env.OUT!, REPO = process.env.REPO!;
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
// A fixed-offset zone in which the current hour is 0 (Etc/GMT-N is UTC+N).
const utcHour = new Date().getUTCHours(), plus = (24 - utcHour) % 24, offset = plus > 14 ? plus - 24 : plus;
const zone = offset === 0 ? "Etc/UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
receipt.zone = zone;

const fx = await bootFixture({ port: 0, classic: false, roster: [
  { name: "agent-alpha", displayName: "Atlas", backend: "codex" }, { name: "agent-beta", displayName: "Beacon", backend: "claude-code" },
] });
const now = Date.now();
fx.fm.webChatHistory.record({ instance: "agent-alpha", sender: "you", role: "user", text: "Ready for the release notes?", ts: new Date(now - 4 * 60_000).toISOString() });
fx.fm.webChatHistory.record({ instance: "agent-alpha", sender: "agent-alpha", role: "agent", text: "Yes, drafting them now.", ts: new Date(now - 3 * 60_000).toISOString() });
const AMPM = /上午|下午|凌晨|清晨|中午|晚上|\bAM\b|\bPM\b/;
try {
  for (const lang of ["en", "zh-TW"] as const) {
    const c = { device: "desk", theme: lang === "en" ? "light" : "dark", lang } as const, tag = `desk-${lang}-${c.theme}`;
    const { ctx, page } = await fx.page(c, { path: "/ui/chat/agent-alpha" });
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: zone });
    await page.reload(); await page.locator("#filterInput").waitFor({ state: "attached" });
    const hour = await page.evaluate(() => new Date().getHours());
    check(`${tag}: the browser's clock is in the midnight hour (${zone})`, hour === 0, hour);

    // 1. The chat thread: each message's time (in the fleet's zone, as chat logs are; the page body names it).
    const stamps = page.locator(".meta .time[data-ts]");
    await page.getByText("Yes, drafting them now.").waitFor();
    const times = (await stamps.allInnerTexts()).map(s => s.trim()).filter(s => /\d:\d\d/.test(s));
    check(`${tag} chat: message times read ${JSON.stringify(times)}`, times.length >= 2 && (lang === "en" ? times.every(s => /\d\d:\d\d/.test(s)) : times.every(s => /^(昨天 )?\d\d:\d\d$/.test(s) && !AMPM.test(s))), times);
    let path = shotPath(smoke, tag, "1-chat-times"); await page.screenshot({ path }); receipt.pictures.push(path);

    // 2. The session menu: until when, and the idle span.
    await page.locator(".session > .side-row").click();
    const sub = page.locator(".session .pop .sub").first();
    await sub.waitFor({ state: "visible" });
    const subText = (await sub.innerText()).trim();
    check(`${tag} session menu: "${subText}"`, lang === "en" ? /\d\d:\d\d/.test(subText) && /\b(h|min)\b/.test(subText) : /\d\d:\d\d/.test(subText) && !AMPM.test(subText) && /小時|分鐘/.test(subText) && !/\d (h|min)\b/.test(subText), subText);
    path = shotPath(smoke, tag, "2-session-menu"); await page.screenshot({ path }); receipt.pictures.push(path);
    await page.keyboard.press("Escape");

    // 3. Fleet → Usage: "Updated HH:mm".
    await page.goto(fx.base + "/ui/fleet/usage");
    const fresh = page.locator(".us-fresh");
    await fresh.waitFor({ state: "visible", timeout: 20_000 });
    const freshText = (await fresh.innerText()).trim();
    check(`${tag} Fleet → Usage: "${freshText}"`, /\d\d:\d\d/.test(freshText) && (lang === "en" || (!AMPM.test(freshText) && /00:\d\d/.test(freshText))), freshText);
    path = shotPath(smoke, tag, "3-fleet-usage"); await page.screenshot({ path }); receipt.pictures.push(path);
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
} finally {
  receipt.pictures = receipt.pictures.map((p: string) => ({ path: p.split("/").slice(-2).join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }));
  writeFileSync(join(OUT, smoke, "receipt.json"), JSON.stringify(receipt, null, 2));
  await fx.close();
}
const failed = receipt.checks.filter((c: any) => !c.ok);
console.log(failed.length ? `FAIL ${failed.length}` : `PASS ${receipt.checks.length}`);
process.exit(failed.length ? 1 : 0);
