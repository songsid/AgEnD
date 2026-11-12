// #3724: the working bar above the web chat composer keeps one height, so the agent's state changing (idle → working →
// stuck → waiting for your permission → idle) never moves the conversation or the composer. In a real Chrome, on the
// shared fixture (in-process FleetManager, scratch home, loopback only) with a long seeded thread, per case and per
// reader position (reading history mid-thread / at the bottom): in every state the composer's top edge, the thread's
// visible height and scrollTop, the last message's top and the bar's own height must equal the first (idle) state's; the
// bar's status text stays on one line (a long "waiting for" text is cut, not wrapped). Each state's dock is pictured
// (OUT/<case>-<reader>-<n>-<state>.png).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW] \
//   npx tsx scripts/manual/smoke/smoke-work-bar-height.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, seedChat } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "smoke-work-bar-height");
mkdirSync(OUT, { recursive: true });
const LONG = "Allow Bash: npm test -- --run tests/web-chat-c3.test.ts tests/web-chat-1307.test.ts tests/web-app-panels-1408.test.ts and then rebuild the whole UI bundle?";
/** exec (the raw execution state) and awaiting (what it waits for), as the status frame sets them. */
const STATES: Array<[string, string | null, string | null]> = [
  ["idle", "idle", null], ["working", "working", null], ["stuck", "stuck", null],
  ["awaiting-long", "working", LONG], ["working-again", "working", null], ["idle-again", "idle", null],
];
const fail: string[] = [];
const scrollerSeen: string[] = [];
const result: Record<string, unknown> = {};
const fx = await bootFixture({ port: Number(process.env.PORT ?? 19660), instances: 4 } as never);
try {
  const name = (fx as unknown as { instances: Array<{ name: string }> }).instances[1]!.name;
  // Every agent gets a long thread: the split leg's second pane (whichever the picker offers first) must scroll too.
  await seedChat(fx as never, (fx as unknown as { instances: Array<{ name: string }> }).instances.map((i) => i.name), Number(process.env.N ?? 60));
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const { page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const errors: string[] = []; page.on("pageerror", (e: unknown) => errors.push(String(e).slice(0, 200)));
    await page.waitForSelector("#msgIn", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    for (const reader of ["mid", "bottom"] as const) {
      await page.evaluate((r: string) => {
        // The element that scrolls is the thread's nearest scrolling ancestor (.thread itself grows with its messages).
        let t = document.querySelector(".thread") as HTMLElement;
        while (t.parentElement && !(/auto|scroll/.test(getComputedStyle(t).overflowY) && t.scrollHeight > t.clientHeight)) t = t.parentElement;
        t.scrollTop = r === "bottom" ? t.scrollHeight : Math.floor((t.scrollHeight - t.clientHeight) / 2);
        return [t.className || t.tagName, t.scrollHeight, t.clientHeight, t.scrollTop];
      }, reader).then((v: unknown) => { scrollerSeen.push(`${caseName(c)}/${reader}: ${JSON.stringify(v)}`); });
      await page.waitForTimeout(400);
      const seen: Array<Record<string, number | string | boolean>> = [];
      for (const [i, [state, exec, awaiting]] of STATES.entries()) {
        await page.evaluate(async ([n, e, a]: [string, string | null, string | null]) => {
          const m = await import("/assets/app-store.js");
          m.appStore.set((s: { exec: Record<string, unknown>; awaiting: Record<string, unknown> }) => {
            const aw = { ...s.awaiting }; if (a == null) delete aw[n]; else aw[n] = a;
            return { ...s, exec: { ...s.exec, [n]: e }, awaiting: aw };
          });
        }, [name, exec, awaiting]);
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
          const th = document.querySelector(".thread") as HTMLElement, bar = document.querySelector(".work-bar") as HTMLElement | null;
          let t = th;
          while (t.parentElement && !(/auto|scroll/.test(getComputedStyle(t).overflowY) && t.scrollHeight > t.clientHeight)) t = t.parentElement;
          const items = th.querySelectorAll("[data-msg], .msg, .bubble"), last = items[items.length - 1] as HTMLElement | undefined;
          const lbl = bar?.querySelector(".lbl, .note") as HTMLElement | null;
          const line = lbl ? parseFloat(getComputedStyle(lbl).lineHeight) || 20 : 0;
          return {
            composerTop: (document.getElementById("msgIn") as HTMLElement).getBoundingClientRect().top,
            threadHeight: t.clientHeight, scrollTop: t.scrollTop, atBottom: t.scrollHeight - t.clientHeight - t.scrollTop < 2,
            lastTop: last ? last.getBoundingClientRect().top : -1,
            barHeight: bar ? bar.getBoundingClientRect().height : -1, barClass: bar ? bar.className : "none",
            textLines: lbl ? Math.round(lbl.getBoundingClientRect().height / line) : 0,
          };
        });
        seen.push({ state, ...m });
        if (Number(m.textLines) > 1) fail.push(`${caseName(c)}/${reader}/${state}: the status text wraps to ${m.textLines} lines`);
        await page.locator(".dock").screenshot({ path: join(OUT, `${caseName(c)}-${reader}-${i}-${state}.png`) });
      }
      const key = `${caseName(c)}/${reader}`;
      result[key] = seen;
      const first = seen[0]!;
      for (const s of seen.slice(1)) for (const k of ["composerTop", "threadHeight", "lastTop", "barHeight", ...(reader === "mid" ? ["scrollTop"] : [])] as const) {
        if (Math.abs(Number(s[k]) - Number(first[k])) > 0.5) fail.push(`${key}: ${s.state} ${k} ${Number(s[k]).toFixed(1)} (idle ${Number(first[k]).toFixed(1)})`);
      }
      if (reader === "bottom") for (const s of seen) if (!s.atBottom) fail.push(`${key}: ${s.state} is no longer at the bottom`);
      if (reader === "mid" && !(Number(first.scrollTop) > 0)) fail.push(`${key}: the reader is not mid-thread (scrollTop ${first.scrollTop}) — the scroll container was not found`);
      if (Number(first.barHeight) <= 0) fail.push(`${key}: no working-bar strip while idle (height ${first.barHeight})`);
    }
    // One thing more on the open page: the full chat, idle and working, for the PR's pictures.
    for (const [state, exec] of [["idle", "idle"], ["working", "working"]] as const) {
      await page.evaluate(async ([n, e]: [string, string]) => { const m = await import("/assets/app-store.js");
        m.appStore.set((s: { exec: Record<string, unknown> }) => ({ ...s, exec: { ...s.exec, [n]: e } })); }, [name, exec]);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${caseName(c)}-page-${state}.png`) });
    }
    if (errors.length) fail.push(`${caseName(c)}: page errors ${errors.join(" | ")}`);
    await page.context().close();
  }
  // SPLIT=1 (alpha's two-pane workspace): open a second agent beside the first, then flip the FIRST pane's agent through
  // every state. In both panes the composer's top, the scroller's height and scrollTop and the bar's height stay put.
  if (process.env.SPLIT === "1") for (const c of matrix(process.env.SPLIT_MATRIX ?? "desk-light-en,desk-dark-zh-TW")) {
    const { page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const errors: string[] = []; page.on("pageerror", (e: unknown) => errors.push(String(e).slice(0, 200)));
    await page.waitForSelector("#msgIn", { timeout: 20_000 }); await page.waitForTimeout(1500);
    // Before any split exists the entry is the chat page's own "Split chat" action (appStore.chatWorkspace.pick); a pane's
    // split button exists only once the workspace is up.
    const opened = await page.evaluate(async () => { const m = await import("/assets/app-store.js"); const w = m.appStore.get().chatWorkspace;
      if (w && typeof w.pick === "function") { w.pick(); return "pick"; } const b = document.querySelector(".ws-pane-split") as HTMLElement | null; b?.click(); return b ? "button" : null; });
    if (!opened) { fail.push(`${caseName(c)}/split: no "Split chat" entry (the workspace is not on this build)`); await page.context().close(); continue; }
    await page.waitForSelector(".ws-agent-choices button", { timeout: 10_000 });
    await page.click(".ws-agent-choices button"); await page.waitForTimeout(2500);
    const panes = await page.evaluate(() => document.querySelectorAll(".p-chat").length);
    if (panes !== 2) { fail.push(`${caseName(c)}/split: ${panes} chat panes after opening a second one`); await page.context().close(); continue; }
    await page.evaluate(() => { for (const p of document.querySelectorAll(".p-chat")) { const sc = p.querySelector(".scroller") as HTMLElement | null; if (sc) sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) / 2); } });
    await page.waitForTimeout(400);
    const seen: Array<Record<string, unknown>> = [];
    for (const [i, [state, exec, awaiting]] of STATES.entries()) {
      await page.evaluate(async ([n, e, a]: [string, string | null, string | null]) => {
        const m = await import("/assets/app-store.js");
        m.appStore.set((s: { exec: Record<string, unknown>; awaiting: Record<string, unknown> }) => {
          const aw = { ...s.awaiting }; if (a == null) delete aw[n]; else aw[n] = a;
          return { ...s, exec: { ...s.exec, [n]: e }, awaiting: aw };
        });
      }, [name, exec, awaiting]);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => [...document.querySelectorAll(".p-chat")].map((p) => {
        const sc = p.querySelector(".scroller") as HTMLElement | null, ta = p.querySelector("textarea") as HTMLElement | null, bar = p.querySelector(".work-bar") as HTMLElement | null;
        return { composerTop: ta ? ta.getBoundingClientRect().top : -1, threadHeight: sc ? sc.clientHeight : -1, scrollTop: sc ? sc.scrollTop : -1,
          barHeight: bar ? bar.getBoundingClientRect().height : -1, barClass: bar ? bar.className : "none" };
      }));
      seen.push({ state, panes: m });
      await page.screenshot({ path: join(OUT, `split-${caseName(c)}-${i}-${state}.png`) });
    }
    result[`split/${caseName(c)}`] = seen;
    const first = seen[0]!.panes as Array<Record<string, number>>;
    for (const s of seen.slice(1)) (s.panes as Array<Record<string, number>>).forEach((p, j) => {
      for (const k of ["composerTop", "threadHeight", "scrollTop", "barHeight"]) if (Math.abs(p[k]! - first[j]![k]!) > 0.5)
        fail.push(`split/${caseName(c)}: pane ${j + 1} ${s.state} ${k} ${p[k]!.toFixed(1)} (idle ${first[j]![k]!.toFixed(1)})`);
    });
    if (first.some((p) => !(p.barHeight! > 0))) fail.push(`split/${caseName(c)}: a pane has no working-bar strip while idle`);
    if (first.some((p) => !(p.scrollTop! > 0))) fail.push(`split/${caseName(c)}: a pane's reader is not mid-thread (the second agent's thread may be short)`);
    if (errors.length) fail.push(`split/${caseName(c)}: page errors ${errors.join(" | ")}`);
    await page.context().close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify({ scrollerSeen, result, fail }, null, 2));
console.log("scroller [class, scrollHeight, clientHeight, scrollTop]:\n" + scrollerSeen.join("\n"));
console.log(JSON.stringify(result, null, 1));
if (fail.length) { console.error("FAIL\n" + fail.join("\n")); process.exitCode = 1; } else console.log("PASS: the thread and the composer stay put in every state");
