// AGEND-256: Settings → Agents and Settings → Chat & connections keep one set of columns for every row. Before, each
// row was its own grid whose last ("auto") column took that row's buttons, so a paused agent (Wake, no Stop) sat
// 8–24px right of a running one, and a connection with a longer bot name or a Retry button moved its facts left.
// Judged on the real page (desktop 1920, both themes, both languages): for every column, every row's cell starts at
// the header's x (±1px); in a connection's actions, the token chip and the state start at one x in every row. The phone case only takes a picture (the rows stack there; no columns to line up).
// A third of the agents are paused; three connections with different bot names and states.
//   PW_DIR=… REPO=… OUT=… CHROME=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-agend-256-settings-columns.mts
import { writeFileSync, readFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-agend-256-settings-columns";
const TAG = process.env.TAG ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48760), instances: 24 });
const fm = fx.fm;

// A third of the agents paused, the rest running: the mix the report showed.
fm.getInstanceStatus = (n: string) => (fx.instances.findIndex(i => i.name === n) % 3 === 2 ? "paused" : "running");

// Three connections: two Discord, one Telegram; a short and a long bot name, one not connected (it gets Retry).
const web = readFileSync(fm.configPath, "utf8").split("\nweb:\n");
writeFileSync(fm.configPath, `${web[0]}
channels:
  - id: discord
    type: discord
    bot_token_env: DEMO_DISCORD_TOKEN
    group_id: "1496407196106494055"
    access: { mode: open, allowed_users: ["368442200000000001"] }
  - id: grok-persona
    type: discord
    bot_token_env: DEMO_PERSONA_TOKEN
    group_id: "1496407196106494055"
    access: { mode: locked }
  - id: telegram
    type: telegram
    mode: topic
    bot_token_env: DEMO_TELEGRAM_TOKEN
    group_id: "-1003833855730"
    access: { mode: locked, allowed_users: ["951494522"] }
web:
${web[1]}`);
fm.loadConfig(fm.configPath);
for (const k of ["DEMO_DISCORD_TOKEN", "DEMO_PERSONA_TOKEN", "DEMO_TELEGRAM_TOKEN"]) process.env[k] = "x";
const BOTS: Record<string, any> = {
  discord: { status: "connected", identity: { username: "DemoBot" } },
  "grok-persona": { status: "connected", identity: { username: "長一點的機器人名稱Bot" } },
  telegram: { status: "retrying" },
};
const listed = fm.listSecureConnections.bind(fm);
fm.listSecureConnections = () => listed().map((c: any) => ({ ...c, ...BOTS[c.id] }));
fm.isFleetRunning = () => true;

// For each column: the header cell's left and every row's cell's left in that column.
// A string, not a function: tsx would wrap a function's inner helpers in __name(), which the page does not have.
const measure = (page: any, list: string, header: string, row: string) => page.evaluate(`(() => {
  const root = document.querySelector(${JSON.stringify(list)});
  if (!root) return { error: "no " + ${JSON.stringify(list)} };
  const lefts = (el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left * 10) / 10);
  const head = root.querySelector(${JSON.stringify(header)});
  return { header: head ? lefts(head) : [], rows: [...root.querySelectorAll(${JSON.stringify(row)})].map((r) => ({ name: (r.querySelector(".s-name")?.textContent || "").trim(), lefts: lefts(r) })) };
})()`);

let failed = 0;
const judge = (what: string, m: any) => {
  if (m.error) { console.log(`FAIL ${what}: ${m.error}`); failed++; return; }
  if (!m.header.length || m.header.every((x: number) => x === 0)) { console.log(`FAIL ${what}: no column header shown (page under 900px?)`); failed++; return; }
  const worst = m.header.map((x: number, col: number) => Math.max(...m.rows.map((r: any) => Math.abs(r.lefts[col] - x))));
  const ok = worst.every((d: number) => d <= 1);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${m.rows.length} rows, worst column drift from header (px) = [${worst.map((d: number) => d.toFixed(1)).join(", ")}]`);
};

for (const c of matrix(process.env.MATRIX ?? "desk-dark-zh-TW,desk-light-en,phone-dark-zh-TW")) {
  const desk = c.device === "desk";
  const p = await fx.page(c, { path: "/settings/agents" });
  // The columns start at a 900px settings page; at the fixture's 1366 the page is narrower (sidebar + nav), so the
  // desktop case is a 1920 window, as in the report.
  if (desk) { await p.page.setViewportSize({ width: 1920, height: 1080 }); await p.page.waitForTimeout(300); }
  await p.page.waitForSelector(".s-agents-list .s-agent-row");
  await p.page.waitForTimeout(600);
  if (desk) judge(`${caseName(c)} agents`, await measure(p.page, ".s-agents-list", ".s-agent-columns", ".s-agent-row"));
  // The top of the list (header, the first groups, running and paused rows mixed): the whole list is too tall to read.
  const box = await p.page.locator(".s-agents-list").boundingBox();
  await p.page.screenshot({ path: shotPath(SMOKE, c, `${TAG}-agents`), fullPage: true, clip: { ...box, height: Math.min(box.height, desk ? 760 : 1100) } });
  await p.page.goto(`${fx.base}/settings/chat`);
  await p.page.waitForSelector(".s-connections-list .s-conn");
  await p.page.waitForTimeout(600);
  if (desk) {
    judge(`${caseName(c)} connections`, await measure(p.page, ".s-connections-list", ".s-connection-columns", ".s-conn"));
    // Inside the actions: the token chip and the state start at one x in every row (the first row is the reference).
    const inner = await measure(p.page, ".s-connections-list", ".s-conn .s-actions", ".s-conn .s-actions");
    // ClassicBot rooms (same page, further down): the same shared columns.
    judge(`${caseName(c)} classic rooms`, await measure(p.page, ".s-classic-list", ".s-classic-columns", ".s-classic-row"));
    judge(`${caseName(c)} connection token + state`, { header: inner.header.slice(0, 2), rows: inner.rows.map((r: any) => ({ ...r, lefts: r.lefts.slice(0, 2) })) });
  }
  await p.page.locator(".s-chat-connections").screenshot({ path: shotPath(SMOKE, c, `${TAG}-connections`) });
  await p.ctx.close();
}
await fx.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
