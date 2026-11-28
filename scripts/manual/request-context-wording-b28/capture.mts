/**
 * Beta.28 wording pass, real app (the S-230 fixture's control stub, no Fleet start, no activation): Settings → Access and
 * security → request-based approvals, desk light en and phone dark zh-TW.
 *   A off-unavailable: turning it on isn't available yet (#4597): the switch is off and disabled, its reason shown, and no
 *     "can't downgrade after turning it on" warning under it.
 *   B blocked-work: an attempt waits for an agent's current work: EN "Request-based approvals aren't on yet." / zh
 *     「依請求核准聯絡尚未開啟。」, and zh 「請先等這些 Agent 完成目前的工作：…」.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/request-context-wording-b28/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, OUT = process.env.OUT!; mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const { permitWebContinuation } = await import(REPO + "/src/web-continuation.ts");
const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", displayName: "General", backend: "claude-code", general: true },
  { name: "worker", displayName: "Demo worker", backend: "codex" },
] });
const fm: any = fx.fm;
let view: any;
fm.requestContextControl = {
  principal(req: any) { const owner = fm.liveOwner(req, { hostOnly: false }); return owner && { binding: owner.handle, verified: true, current: owner.current }; },
  permitContinuation: (req: any, res: any) => permitWebContinuation(req, res, fm),
  read: () => structuredClone(view), recheck: () => structuredClone(view), snapshot: () => view ? structuredClone(view) : null,
  change() { throw Error("Capture fixture never changes the setting"); },
};
const never = () => { throw Error("Capture fixture must never start, mutate or deliver"); };
fm.deliverToInstance = never; fm.deliverHumanToInstance = never; fm.saveFleetConfig = never;
const STATES: Record<string, any> = {
  "off-unavailable": { revision: 1, enabled: false, everActivated: false, attempted: false, phase: "off", canChange: true, blockers: [], enableUnavailable: true },
  // An attempt that waits is not on yet: the real controller reports enabled only once the mode is active (and then
  // everActivated with it), so the switch is drawn off here (M-3900; request-context-controller.ts).
  "blocked-work": { revision: 2, enabled: false, everActivated: false, attempted: true, phase: "blocked", canChange: true, enableUnavailable: false,
    blockers: [{ id: "working-fixture", kind: "owners", ownerCause: "work", labels: ["Demo worker"], agents: [{ id: "worker", label: "Demo worker" }] }] },
};
try {
  for (const variant of matrix("desk-light-en,phone-dark-zh-TW")) for (const [state, v] of Object.entries(STATES)) {
    view = v;
    const tag = `${caseName(variant)}-${state}`, zh = variant.lang === "zh-TW";
    const { ctx, page } = await fx.page(variant, { path: "/settings/access#request-context", host: true });
    try {
      await page.locator("#request-context").waitFor({ timeout: 20000 }); await page.waitForTimeout(600);
      await page.evaluate(`document.querySelector("#request-context").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
      const card = await page.locator("#request-context").innerText();
      const warn = await page.locator("#request-context .notice.warn").count();
      if (state === "off-unavailable") {
        check(`${tag}: the switch is off and disabled, with its reason`, await page.locator("#request-context input[type=checkbox]").isDisabled() && card.includes(zh ? "這一版還不能開啟依請求核准聯絡。" : "Request-based approvals can't be turned on in this version yet."), card);
        check(`${tag}: no downgrade warning under the disabled switch`, warn === 0 && !card.includes(zh ? "降回舊版" : "older AgEnD"), { warn, card });
      } else {
        check(`${tag}: blocked says it isn't on yet, and the switch is off`, card.includes(zh ? "依請求核准聯絡尚未開啟。" : "Request-based approvals aren't on yet.") && !(await page.locator("#request-context input[type=checkbox]").isChecked()), card);
        check(`${tag}: the agents' work line asks to wait, not to end it`, zh ? card.includes("請先等這些 Agent 完成目前的工作：Demo worker。") && !card.includes("結束") : card.includes("Finish the current work for these agents first: Demo worker."), card);
      }
      const wb = await page.evaluate(`[...document.querySelectorAll("#request-context p")].map((e) => getComputedStyle(e).wordBreak)`) as string[];
      check(`${tag}: the card keeps zh words whole`, wb.length > 0 && wb.every((w) => w === "keep-all"), wb);
      const banner = await page.evaluate(`(() => { const p = document.querySelector(".s-access-banner > p"); return p ? getComputedStyle(p).wordBreak : null; })()`);
      check(`${tag}: the Access banner keeps zh words whole`, banner === "keep-all", banner);
      const shot = `b28-${tag}.png`;
      await page.screenshot({ path: join(OUT, shot) });
      receipt.pictures.push({ path: shot, sha256: createHash("sha256").update(readFileSync(join(OUT, shot))).digest("hex") });
    } finally { await ctx.close(); }
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length; receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(`checks ${receipt.summary}`); process.exitCode = failed ? 1 : 0;
}
