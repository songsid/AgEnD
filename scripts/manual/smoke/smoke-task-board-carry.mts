// The task board after the carry (#2306 step 3, #2313 looks, #2316 instance work, #2341 summary, #2352 lanes): the
// design-direction shots for the user. A board seeded through the board's own rules (a person's and instances' moves),
// then the real pages: Home, a project's board, a blocked card's dialog, who works on what, the project dialog with its
// lead, and General's web chat with the daily summary (the real postTaskBoardSummary). The chat platforms' messages
// (the lead's Needs you list, the summary) are drawn from the real renderer's text on a neutral page styled like each
// platform: this fixture runs no Telegram or Discord bot.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-board-carry.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, type MatrixCase } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!, OUT = process.env.OUT!;
mkdirSync(OUT, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 48830) });
const fm = fx.fm as any;
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { deriveNeedsYou, renderLiveMessage } = await import(REPO + "/src/needs-you.ts");
const { t, setLocale } = await import(REPO + "/src/locale.ts");
const names = Object.keys(fm.fleetConfig.instances);
const GENERAL = names.find((n) => fm.fleetConfig.instances[n].general_topic === true)!;
// Short, plain names read best in the shots (the fixture also has long and CJK ones).
const [LEAD, DEV1, DEV2] = names.filter((n) => n !== GENERAL && /^[a-z][a-z0-9-]{2,18}$/.test(n));
fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: [], deliveries: [], tasks: fm.needsYouTasks(), ownerOf: () => undefined });

// ── The board ──
fm.scheduler = new Scheduler(join(fm.dataDir, "carry.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
fm.attachTaskBoard(fm.scheduler.db);
const b = fm.scheduler.db.board;
const ann = { kind: "person", name: "Ann" }, lead = { kind: "instance", name: LEAD }, d1 = { kind: "instance", name: DEV1 }, d2 = { kind: "instance", name: DEV2 };
const game = b.createProject(ann, { name: "Leaderboard", description: "Weekly leaderboard for the fish game", leadInstance: LEAD });
const billing = b.createProject(ann, { name: "Billing", description: "Invoices and refunds" });
const main = b.createCards(ann, { project: game.id, cards: [{ title: "Serve the weekly leaderboard", assignee: LEAD, acceptance: ["Top 100 by score", "Ties share a rank", "Cached for 5 minutes"] }] }).cards[0];
const subs = b.createCards(lead, { parent: main.code, cards: [
  { title: "Score query and ranking", assignee: DEV1, acceptance: ["ranked games only?"] },
  { title: "Leaderboard page", assignee: DEV2, dependsOn: ["S-1"] },
  { title: "Public link port", assignee: DEV2 },
] }).cards;
b.moveCard(d1, subs[0].code, "claimed"); b.moveCard(d1, subs[0].code, "blocked", { reason: "Which scores count: ranked games only, or casual too?" });
b.moveCard(d2, subs[2].code, "claimed"); b.moveCard(d2, subs[2].code, "review", { result: "Port 8443 behind the proxy" });
const own = b.createCards(ann, { project: game.id, cards: [{ title: "Cache the top 100", assignee: DEV1, acceptance: ["5 minute TTL", "Invalidate on a new score"] }] }).cards[0];
b.moveCard(d1, own.code, "claimed"); b.moveCard(d1, own.code, "review", { result: "Redis, 5 min TTL", reason: "Invalidation lands with the score service next week" });
const done = b.createCards(ann, { project: billing.id, cards: [{ title: "Refund flow", assignee: DEV2 }, { title: "Invoice PDF", assignee: DEV1 }] }).cards;
b.moveCard(d2, done[0].code, "claimed"); b.moveCard(d2, done[0].code, "review", { result: "done" }); b.moveCard(ann, done[0].code, "done");
b.updateCard(ann, subs[1].code, { comment: "Use the game's palette" });

// ── The daily summary, through the real path (it lands in General's web chat; no chat world here) ──
setLocale("en");
fm.postTaskBoardSummary(new Date(Date.now() - 24 * 3600_000), new Date(Date.now() + 60_000));

// ── The pages ──
const result: Record<string, unknown> = {};
const shot = (p: any, name: string) => p.page.screenshot({ path: join(OUT, `${name}.png`) });
const top = (page: any) => page.locator("dialog[open]").last();
const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as unknown as MatrixCase, {});
await p.page.setViewportSize({ width: 1440, height: 900 });
await mounted(p.page);
await p.page.goto(`${fx.base}/ui/fleet`); await p.page.waitForSelector(".tb-home"); await p.page.waitForTimeout(800);
await shot(p, "1-home");
await p.page.locator(".tb-project-open").first().click(); await p.page.waitForSelector(".tb-columns"); await p.page.waitForTimeout(800);
await shot(p, "2-board");
// A sub task opens as Needs you's link does (?card=…): the board shows main tasks as tiles, sub tasks inside them.
await p.page.goto(`${fx.base}/ui/fleet?card=${subs[0].code}`); await p.page.waitForSelector("dialog[open]"); await p.page.waitForTimeout(800);
await shot(p, "3-card-blocked");
await p.page.keyboard.press("Escape"); await p.page.waitForTimeout(300);
await p.page.locator("button", { hasText: "Instances" }).first().click(); await p.page.waitForSelector("dialog[open]"); await p.page.waitForTimeout(800);
await shot(p, "4-instances");
await p.page.keyboard.press("Escape"); await p.page.waitForTimeout(300);
await p.page.goto(`${fx.base}/ui/fleet`); await p.page.waitForSelector(".tb-board-page, .tb-home");
if (await p.page.locator(".tb-home").count() === 0) await p.page.locator(".tb-bar-head .btn-ghost").first().click();   // the project last looked at reopens: back to Home
await p.page.waitForSelector(".tb-home"); await p.page.waitForTimeout(500);
await p.page.locator(".tb-project-menu button").first().click(); await p.page.waitForTimeout(200);
await p.page.locator("[role=menuitem]", { hasText: "Edit project" }).first().click(); await p.page.waitForSelector("dialog[open] select.tb-project-lead");
result.leadSelected = await top(p.page).locator("select.tb-project-lead").inputValue();
await shot(p, "5-project-lead");
await p.page.keyboard.press("Escape");
await p.page.goto(`${fx.base}/ui/chat/${encodeURIComponent(GENERAL)}`); await p.page.waitForSelector(".msg.status-line"); await p.page.waitForTimeout(800);
await shot(p, "6-summary-web-general");
result.errors = p.errors;
await p.ctx.close();

// ── The chat platforms' messages, from the real text ──
const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], tasks: fm.needsYouTasks().map((x: any) => ({ ...x, lane: LEAD })), ownerOf: () => "w" });
const lines = items.filter((i: any) => i.card).map((item: any) => ({ item, title: `${t(`needs.reason.${item.reason}`)}: ${item.detail}`, link: "" }));
const live = renderLiveMessage(lines, Date.now(), (k: string, ...a: unknown[]) => t(k, ...a), "needs.live_header_lane");
const buttons = live.ackable.flatMap((i: any) => i.reason === "task_review" ? [t("needs.task_confirm_button", i.card.code), t("needs.task_back_button", i.card.code)] : [t("needs.task_answer_button", i.card.code)]);
const summary = (fm.webChatHistory.list(GENERAL, 50) as any[]).filter((m) => m.role === "status").at(-1)?.text ?? "";
result.lane = live.text; result.buttons = buttons; result.summary = summary;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const fmt = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
const tg = (who: string, topic: string, text: string, btns: string[]) => `<div class="tg"><div class="tg-top">${topic}</div><div class="tg-msg"><div class="tg-name">${who}</div>${fmt(text)}</div>
  ${btns.length ? `<div class="tg-kb">${btns.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}</div>`;
const dc = (who: string, channel: string, text: string, btns: string[]) => `<div class="dc"><div class="dc-top"># ${channel}</div><div class="dc-row"><div class="dc-av">A</div><div><div class="dc-name">${who} <span>BOT</span></div>
  <div class="dc-text">${fmt(text)}</div>${btns.length ? `<div class="dc-btns">${btns.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}</div></div></div>`;
const css = `body{margin:0;padding:24px;font:15px/1.45 -apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;background:#ddd}.note{font:12px sans-serif;color:#555;margin:0 0 8px}
.tg{width:560px;background:#9bb7d1 linear-gradient(#a9c2d8,#8fb0cc);padding:0 0 16px;border-radius:8px;overflow:hidden}.tg-top{background:#fff;padding:10px 16px;font-weight:600}
.tg-msg{background:#fff;margin:16px 16px 4px;padding:8px 12px;border-radius:12px 12px 12px 4px;max-width:480px}.tg-name{color:#3a8fd6;font-weight:600;margin-bottom:2px}
.tg-kb{margin:0 16px;display:grid;grid-template-columns:1fr 1fr;gap:4px;max-width:504px}.tg-kb span{background:rgba(70,110,140,.55);color:#fff;text-align:center;padding:8px;border-radius:8px;font-size:14px}
.dc{width:640px;background:#313338;color:#dbdee1;border-radius:8px;overflow:hidden}.dc-top{padding:12px 16px;border-bottom:1px solid #1f2023;font-weight:600;color:#f2f3f5}
.dc-row{display:flex;gap:12px;padding:16px}.dc-av{flex:none;width:40px;height:40px;border-radius:50%;background:#5865f2;color:#fff;display:grid;place-items:center;font-weight:700}
.dc-name{color:#f2f3f5;font-weight:600}.dc-name span{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-left:4px}.dc-text{margin-top:2px}
.dc-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.dc-btns span{background:#4e5058;color:#fff;padding:6px 14px;border-radius:4px;font-size:14px}`;
// The mock pages are written as files: this host has no colour emoji font, so they are shot in the Playwright image.
const page = (body: string) => `<!doctype html><meta charset="utf-8"><style>${css}</style><p class="note">Drawn from AgEnD's real message text and buttons; the platform's chrome is a mock.</p>${body}`;
writeFileSync(join(OUT, "7-lead-channel-telegram.html"), page(tg("AgEnD", `🧭 ${LEAD} — the lead's topic`, live.text, buttons)));
writeFileSync(join(OUT, "8-lead-channel-discord.html"), page(dc("AgEnD", `${LEAD}`, live.text, buttons)));
writeFileSync(join(OUT, "9-summary-discord.html"), page(dc("AgEnD", "general", summary, [])));

writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await fx.close(); process.exit(0);
