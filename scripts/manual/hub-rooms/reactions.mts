/**
 * M-3127 A browser acceptance: people's emoji reactions in a Hub group room (docs/design/hub-rooms-reactions-polls-search.md §A).
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback;
 * every /hub/v1/* call is answered by the rooms fixture (tests/support/hub-rooms-fixture.ts) — no fleet, CLI or account.
 * Cases: desktop-en-light, desktop-zh-TW-dark, phone-zh-TW-light, phone-en-dark. For each:
 *   reactions-after — 每週主管會議 with reactions already there (mine pressed, others' named), then the quick picker open on
 *                     a message, a pick added (its chip pressed, count 1), and mine taken back by pressing it;
 *   reactions-skew  — the same room on BASE_REF's hub-room-thread.js + chat-thread.js (a tab open before the upgrade) while
 *                     the Hub sends messages with `reactions`: drawn as before, no chips, no page error.
 * Writes PNGs and receipt.json (sourceHead, baseRef, inputs' digests, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] npx tsx scripts/manual/hub-rooms/reactions.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-rooms-reactions"));
const base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", "-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture, FIXTURE_ME } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(out, ".keys-")), port = 49600 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));

const SKEW_FILES: Record<string, string> = { "**/ui/js/hub-room-thread.js": "src/ui/hub-room-thread.js", "**/assets/chat-thread.js": "src/ui/shared/chat-thread.js" };
const baseOf = (path: string) => git("show", `${base}:${path}`);
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const INPUTS = ["src/ui/hub-room-thread.js", "src/ui/shared/chat-thread.js", "src/ui/chat-msg-actions.js", "src/ui/hub-room-strings.js", "src/ui/hub-client.js", "src/ui/shared/hub-rooms-u2.css", "tests/support/hub-rooms-fixture.ts"];
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), baseRef: git("rev-parse", base), dirty: git("status", "--porcelain", "--", "src", "tests").split("\n").filter(Boolean),
  inputs: [...Object.values(SKEW_FILES).map(p => ({ path: p, base: sha(baseOf(p)) })), ...INPUTS.map(p => ({ path: p, sha256: sha(readFileSync(join(repo, p))) }))], checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const cases = [["desktop", "en", "light"], ["desktop", "zh-TW", "dark"], ["phone", "zh-TW", "light"], ["phone", "en", "dark"]];
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };

async function open(variant: "after" | "skew", [device, lang, theme]: string[]) {
  const fx = createHubRoomsFixture();
  // Reactions already in the room: on two people's messages, one of them mine (王經理), the others the room's people.
  const room = fx.rooms.find((x: any) => x.id === "room-weekly"), said = room.messages.filter((m: any) => m.author?.kind === "person" && m.text);
  said.at(-1).reactions = [{ emoji: "👍", count: 3, members: ["person-chen", FIXTURE_ME.id, "person-wu"] }, { emoji: "🎉", count: 1, members: ["person-chen"] }];
  said.at(-2).reactions = [{ emoji: "👀", count: 2, members: ["person-wu", "person-chen"] }];
  // An agent's own reaction (room-react-v1) on the @所有 Agent question: stored under the agent's id, named on the chip.
  const askAll = room.messages.find((m: any) => m.mentions?.includes("all")), budget = room.members.find((m: any) => m.name === "budget-check");
  askAll.reactions = [{ emoji: "👍", count: 1, members: [budget.id] }];
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
    return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
  });
  if (variant === "skew") for (const [glob, path] of Object.entries(SKEW_FILES)) await ctx.route(glob, (q: any) => q.fulfill({ status: 200, contentType: "text/javascript", body: baseOf(path) }));
  const p = await ctx.newPage(), errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  p.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (lang !== "en") await p.addInitScript(() => localStorage.setItem("agend_lang", "zh-TW"));
  await p.goto(`${origin}/ui/hub?room=room-weekly`);
  await p.waitForFunction(() => document.querySelectorAll(".hub-room-page .thread .msg").length > 5, undefined, { timeout: 15000 });
  await p.waitForTimeout(500);
  return { ctx, p, errors, said };
}
const shotPage = async (p: any, name: string) => { const file = join(out, name); await p.screenshot({ path: file }); receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) }); };
const chipsOf = (p: any, id: string) => p.evaluate((key: string) => {
  const node = [...document.querySelectorAll(".hub-room-page .thread .msg[data-key]")].find((n) => n.querySelector(".md")?.textContent?.includes(key));
  return node ? [...node.querySelectorAll(".react-bar .react-chip")].map((c) => `${c.querySelector(".e")?.textContent}${c.querySelector(".n")?.textContent}${c.getAttribute("aria-pressed") === "true" ? "*" : ""}|${c.getAttribute("aria-label")}`) : null;
}, id);

try {
  for (const c of cases) {
    const tag = c.join("-"), [device] = c;
    {
      const { ctx, p, errors, said } = await open("after", c);
      const last = String(said.at(-1).text).slice(0, 10), prev = String(said.at(-2).text).slice(0, 10);
      const before = await chipsOf(p, last);
      check(`${tag} after: the chips as stored — 👍3 mine pressed and named, 🎉1 not mine; no page error`,
        before?.length === 2 && /^👍3\*\|/.test(before[0]) && /^🎉1\|/.test(before[1]) && /(You|你)/.test(before[0]) && errors.length === 0, { before, errors });
      const agentChip = await chipsOf(p, "請各自用三行回報");
      check(`${tag} after: an agent's reaction is named as the agent (budget-check), not as "others"`, agentChip?.length === 1 && /budget-check/.test(agentChip[0]), { agentChip });
      // The target message on screen, its picker open (phone: the hover strip is hidden; the button is still the thread's).
      const target = p.locator(".hub-room-page .thread .msg[data-key]", { has: p.locator(".md", { hasText: prev }) }).first();
      await target.scrollIntoViewIfNeeded();
      if (device === "phone") await target.locator('[data-act="reactPick"]').evaluate((b: HTMLElement) => b.click()); else { await target.hover(); await target.locator('[data-act="reactPick"]').click(); }
      await p.waitForTimeout(250);
      const opts = await target.locator(".react-pick .react-opt").allTextContents();
      check(`${tag} after: Add reaction opens the quick picker (8 emoji), focus on the first`, opts.length === 8 && await p.evaluate(() => document.activeElement?.classList.contains("react-opt")), { opts });
      await shotPage(p, `reactions-picker.${tag}.png`);
      await target.locator('.react-opt[data-emoji="🎉"]').click(); await p.waitForTimeout(400);
      const added = await chipsOf(p, prev);
      check(`${tag} after: a pick adds mine (🎉1 pressed) beside the others' 👀2, and closes the picker`, added?.some((x: string) => x.startsWith("🎉1*")) && added?.some((x: string) => x.startsWith("👀2|")) && await target.locator(".react-pick").count() === 0, { added });
      await shotPage(p, `reactions-after.${tag}.png`);
      await target.locator('.react-chip[aria-pressed="true"]').click(); await p.waitForTimeout(400);
      const back = await chipsOf(p, prev);
      check(`${tag} after: pressing my chip takes it back (👀2 left); no page error`, back?.length === 1 && back[0].startsWith("👀2|") && errors.length === 0, { back, errors });
      await ctx.close();
    }
    {
      const { ctx, p, errors } = await open("skew", c);
      const chips = await p.locator(".react-bar, [data-act=\"reactPick\"]").count();
      check(`${tag} skew: BASE_REF's thread draws the room as before (no chips, no Add reaction) while the Hub sends reactions; no page error`, chips === 0 && errors.length === 0, { chips, errors });
      await shotPage(p, `reactions-skew.${tag}.png`);
      await ctx.close();
    }
  }
} finally {
  receipt.passed = receipt.checks.every((x: any) => x.ok);
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close(); await r.close();
}
console.log(receipt.passed ? "ALL PASS" : "SOME FAILED");
process.exit(receipt.passed ? 0 : 1);
