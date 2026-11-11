// The chat composer keeps one width (card "composer width jumps"): while you type, the agent flipping between idle,
// working, stuck and waiting for your permission must not change the input box's width, or a multi-line draft re-wraps
// under your fingers. In a real Chrome, on the shared fixture (in-process FleetManager, scratch home, loopback only): per
// case (desk / phone) and draft (empty / a multi-line one), every state's #msgIn width and the draft's height must equal
// the first state's. The composer is pictured in each state (OUT/<case>-<draft>-<n>-<state>.png).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=desk-light-en,phone-dark-zh-TW] [CHROME=<chrome>] \
//   npx tsx scripts/manual/smoke/smoke-composer-width.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "smoke-composer-width");
mkdirSync(OUT, { recursive: true });
const DRAFT = "Please look at the failing test in src/ui/panel-chat.js and tell me why the composer\nwidth changes when you start working — then fix it, keeping the Send button where it is.";
/** exec (the raw execution state) and awaiting (what it waits for), as the status frame sets them. */
const STATES: Array<[string, string | null, string | null]> = [
  ["idle", "idle", null], ["working", "working", null], ["stuck", "stuck", null],
  ["awaiting", "working", "Allow Bash: npm test?"], ["idle-again", "idle", null],
];
const fail: string[] = [];
const result: Record<string, unknown> = {};
const fx = await bootFixture({ port: Number(process.env.PORT ?? 19640), instances: 4 } as never);
try {
  const name = (fx as unknown as { instances: Array<{ name: string }> }).instances[0]!.name;
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    const { page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const errors: string[] = []; page.on("pageerror", (e: unknown) => errors.push(String(e).slice(0, 200)));
    await page.waitForSelector("#msgIn", { timeout: 20_000 });
    for (const [label, draft] of [["empty", ""], ["draft", DRAFT]] as const) {
      await page.fill("#msgIn", draft);
      const seen: Array<{ state: string; width: number; height: number }> = [];
      for (const [i, [state, exec, awaiting]] of STATES.entries()) {
        await page.evaluate(async ([n, e, a]: [string, string | null, string | null]) => {
          const m = await import("/assets/app-store.js");
          m.appStore.set((s: { exec: Record<string, unknown>; awaiting: Record<string, unknown> }) => {
            const aw = { ...s.awaiting }; if (a == null) delete aw[n]; else aw[n] = a;
            return { ...s, exec: { ...s.exec, [n]: e }, awaiting: aw };
          });
        }, [name, exec, awaiting]);
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
          const ta = document.getElementById("msgIn") as HTMLTextAreaElement;
          return { width: ta.getBoundingClientRect().width, height: ta.getBoundingClientRect().height };
        });
        seen.push({ state, ...m });
        // Stop is in the working bar while the agent is busy (never in the composer row); on a phone, a full tap target.
        const stop = await page.evaluate(() => {
          const b = document.getElementById("stopBtn"); if (!b) return null;
          const r = b.getBoundingClientRect();
          return { inBar: !!b.closest(".work-bar"), inComposer: !!b.closest(".composer"), w: r.width, h: r.height, label: b.getAttribute("aria-label") };
        });
        const busy = exec === "working" || exec === "stuck";
        if (busy !== !!stop || (stop && (!stop.inBar || stop.inComposer))) fail.push(`${caseName(c)}/${label}/${state}: Stop ${JSON.stringify(stop)} (busy ${busy})`);
        if (stop && c.device === "phone" && (stop.w < 44 || stop.h < 44)) fail.push(`${caseName(c)}/${label}/${state}: phone Stop ${stop.w}×${stop.h} < 44`);
        await page.locator(".dock").screenshot({ path: join(OUT, `${caseName(c)}-${label}-${i}-${state}.png`) });
      }
      const key = `${caseName(c)}/${label}`;
      result[key] = seen;
      const w0 = seen[0]!.width, h0 = seen[0]!.height;
      const bad = seen.filter(s => Math.abs(s.width - w0) > 0.5 || Math.abs(s.height - h0) > 0.5);
      if (bad.length) fail.push(`${key}: ${bad.map(b => `${b.state} ${b.width.toFixed(1)}×${b.height.toFixed(1)} (idle ${w0.toFixed(1)}×${h0.toFixed(1)})`).join("; ")}`);
    }
    if (errors.length) fail.push(`${caseName(c)}: page errors ${errors.join(" | ")}`);
    await page.context().close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify({ result, fail }, null, 2));
console.log(JSON.stringify(result, null, 1));
if (fail.length) { console.error("FAIL\n" + fail.join("\n")); process.exitCode = 1; } else console.log("PASS: one composer width in every state");
