/**
 * #2636 smoke: an Office share link's page in a real browser — the share gateway on loopback (no tunnel: its Host check
 * is satisfied by the server wrapper below, as the tunnel would present it), fed by a fake fleet (8 people in two teams,
 * a stored office on the built-in Studio style, some traffic and a "needs you"). Shots: desk light en, phone dark
 * zh-TW, then the link revoked ("ended"). It also asserts the page only ever asks the share's own addresses and the
 * named static files.
 *
 *   PW_DIR=<dir with playwright-core> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2636-office-share.mts
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { OfficeShares, createOfficeShareGateway, type OfficeShareSource } from "../../../src/office-share.js";
import { OFFICE_SHARE_PAGE, OFFICE_SHARE_PAGE_CSP, officeShareStatic } from "../../../src/office-share-page.js";

const PW = process.env.PW_DIR, OUT = process.env.OUT ?? "/tmp/smoke-2636";
if (!PW) throw new Error("set PW_DIR");
mkdirSync(OUT, { recursive: true });
const HOST = "abc-office.trycloudflare.com";

const people = [
  ["atlas", "Atlas", "working"], ["quill", "Quill", "idle"], ["sage", "Sage", "working"], ["nova", "Nova", "idle"],
  ["tide", "Tide", "working"], ["orbit", "Orbit", "idle"], ["pixel", "Pixel", "working"], ["ghost", "Ghost", "working"],
] as const;
const source: OfficeShareSource = {
  status: () => ({ instances: people.map(([name, display_name, exec], k) => ({ name, display_name, backend: k % 2 ? "codex" : "claude-code", status: k === 5 ? "paused" : "running",
    execution_state: exec, model: "secret-model", last_reply: "secret reply", ...(name === "quill" ? { state: "awaiting_input", interaction_summary: "secret question" } : {}) })) }),
  org: () => ({ general: ["atlas"], teams: [{ name: "Core", members: ["quill", "sage", "nova", "ghost"] }, { name: "Web", members: ["tide", "orbit", "pixel"] }], instances: {} }),
  offices: () => ({ rev: 1, offices: [{ id: "hq", name: "HQ", skin: "studio", members: ["atlas", "team:Core", "team:Web"] }] }),
  acts: () => [],
  traffic: () => ({ now: new Date().toISOString(), items: [{ id: "a1", from: "atlas", to: "sage", kind: "task", state: "delivering", at: new Date().toISOString() }], delegations: [] }),
  needs: () => [],
  hidden: name => name === "ghost",
  skins: { list: () => ({ packs: [] }), get: () => null, picture: () => null },
};
const shares = new OfficeShares();
const made = shares.create({ office: "hq", owner: "smoke", exists: () => true });
if (!made.ok) throw new Error(made.error);
const gw = createOfficeShareGateway({
  shares, source, page: () => ({ body: OFFICE_SHARE_PAGE, csp: OFFICE_SHARE_PAGE_CSP }), statics: officeShareStatic,
  // What the tunnel presents: its own Host on every request.
  create: (handler => createServer((req, res) => { req.headers.host = HOST; (handler as (a: typeof req, b: typeof res) => void)(req, res); })) as typeof createServer,
});
const base = await gw.listen();
gw.setHost(HOST);
const url = `${base.origin}/o/${made.token}`;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const asked: string[] = [], problems: string[] = [];
const shoot = async (name: string, o: { width: number; height: number; scheme: "light" | "dark"; locale: string; mobile?: boolean }) => {
  const ctx = await browser.newContext({ viewport: { width: o.width, height: o.height }, colorScheme: o.scheme, locale: o.locale, isMobile: !!o.mobile, hasTouch: !!o.mobile, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("request", (r: { url(): string }) => asked.push(new URL(r.url()).pathname.replace(made.token, "<t>")));
  page.on("console", (m: { type(): string; text(): string }) => { if (m.type() === "error") problems.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e: Error) => problems.push(`${name}: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(2500);
  const opened = await page.$eval("select.oo-office", (e: { value: string }) => e.value);
  if (opened !== "hq") problems.push(`${name}: opened on "${opened}", not the shared office`);
  if (await page.$(".oo-edit")) problems.push(`${name}: an Edit button shows`);
  const text = await page.textContent("body");
  for (const leak of ["secret", "Ghost", "ghost"]) if (text?.includes(leak)) problems.push(`${name}: page shows "${leak}"`);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await ctx.close();
};
await shoot("desk-light-en", { width: 1366, height: 900, scheme: "light", locale: "en-US" });
await shoot("phone-dark-zh", { width: 390, height: 844, scheme: "dark", locale: "zh-TW", mobile: true });
// Revoked while open: the page's next poll says it ended.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  shares.revoke(made.share.id);
  await page.waitForSelector(".share-ended", { timeout: 12000 });
  await page.screenshot({ path: join(OUT, "ended.png") });
  await ctx.close();
}
await browser.close();
gw.close();
const odd = [...new Set(asked)].filter(p => !p.startsWith("/o/<t>") && !officeShareStatic(p));
if (odd.length) problems.push(`asked outside the share: ${odd.join(", ")}`);
console.log(JSON.stringify({ shots: OUT, asked: [...new Set(asked)].length, problems }, null, 1));
process.exit(problems.length ? 1 : 0);
