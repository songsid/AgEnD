// M-3674 captures (scratch): the sidebar's activity times. Fixture agents (zero real names): one whose last reply to a
// person was 33 days ago but another agent started a turn 2 minutes ago (Forge's case), one with only a person's reply,
// one with only agent turns. LABEL=before|after.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const ROSTER = [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "busy-agent", backend: "codex", displayName: "Busy helper", status: "running" },
  { name: "chat-agent", backend: "claude-code", displayName: "Chat helper", status: "running" },
  { name: "relay-agent", backend: "kiro-cli", displayName: "Relay helper", status: "running" },
];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49053), classic: false, roster: ROSTER });
const fm = fx.fm, now = Date.now(), iso = (ms: number) => new Date(now - ms).toISOString();
const day = 86_400_000, min = 60_000;
fm.webChatHistory.record({ instance: "busy-agent", sender: "busy-agent", role: "agent", text: "Done.", ts: iso(33 * day) });
fm.webChatHistory.record({ instance: "chat-agent", sender: "chat-agent", role: "agent", text: "Here you go.", ts: iso(5 * min) });
// The agent-started side (the delivery outbox's newest message from another instance), as the fleet reads it.
const turns: Record<string, string> = { "busy-agent": iso(2 * min), "relay-agent": iso(3 * 3_600_000) };
if (typeof fm.lastAgentTurnOf === "function") fm.lastAgentTurnOf = (n: string) => turns[n] ?? null;
const report: any = { label: LABEL, cases: {} };
// The desk's sidebar is one line a row by default (compact); "detailed" is two; a phone's drawer is detailed.
const ALL = [{ device: "desk", theme: "light", lang: "en", density: "compact" }, { device: "desk", theme: "dark", lang: "zh-TW", density: "compact" },
  { device: "desk", theme: "light", lang: "en", density: "detailed" }, { device: "desk", theme: "dark", lang: "zh-TW", density: "detailed" },
  { device: "phone", theme: "dark", lang: "zh-TW", density: "detailed" }, { device: "phone", theme: "light", lang: "en", density: "detailed" }] as const;
const cases = process.env.PHONE_ONLY ? ALL.filter((c) => c.device === "phone") : ALL;
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}-${c.density}`, errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c as any, { path: "/ui", storage: c.device === "desk" ? { agend_nav_density: c.density } : {} });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    if (c.device === "phone") {
      // Prism #4430: the drawer opened for real (its toggle must be there), the rows then visible on the screen.
      const b = page.locator("#sbOpen");   // the phone's "Open the sidebar" (the drawer's own close button sits off screen)
      if (!(await b.count())) throw new Error(`${key}: no sidebar toggle`);
      await b.click(); await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, `${key}.png`) });
    const rows = await page.evaluate(() => [...document.querySelectorAll("[data-agent-row]")].map((li) => {
      const w = li.querySelector(".inst-when") as HTMLElement | null, r = w ? w.getBoundingClientRect() : null, a = li.querySelector("a") as HTMLElement, ar = a.getBoundingClientRect();
      const nm = li.querySelector(".inst-name") as HTMLElement | null, nr = nm ? nm.getBoundingClientRect() : null;
      return { name: li.getAttribute("data-agent-row"), nameW: nr ? Math.round(nr.width) : null, nameCut: !!nm && nm.scrollWidth > nm.clientWidth + 1, text: w ? (w.textContent || "").trim() : null, title: w ? w.getAttribute("title") : null,
        inRow: !!r && r.right <= ar.right + 0.5 && r.left >= ar.left - 0.5, timeWhole: !!w && w.scrollWidth <= w.clientWidth + 1,
        visible: ar.width > 0 && ar.height > 0 && ar.left >= -0.5 && ar.right <= innerWidth + 0.5 && ar.top >= 0 && ar.bottom <= innerHeight && document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2)?.closest("[data-agent-row]") === li };
    }));
    if (c.device === "phone" && !rows.filter((r: any) => r.name !== "general").every((r: any) => r.visible)) throw new Error(`${key}: rows not visible after opening the drawer: ${JSON.stringify(rows)}`);
    report.cases[key] = { errors, csp: await csp(), rows };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("done");
