/** Real app surfaces and owner HTTP path with synthetic transition status. No Fleet start or activation. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const repo = process.env.REPO!, out = join(process.env.OUT!, "request-context-cutover-s230");
mkdirSync(out, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const sourceHead = git("rev-parse", "HEAD"), dirty = git("status", "--porcelain", "--", "src", "scripts/manual/request-context-cutover-s230");
if (dirty) throw Error("Commit the capture source first");
const receipt: any = { sourceHead, fixture: "Real web server, settings/needs/chat renderers and control route; synthetic installer states, not activation or full-mode proof.", pictures: [], checks: [] };
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", displayName: "General", backend: "claude-code", general: true },
  { name: "worker", displayName: "Demo worker", backend: "codex" },
] });
const { permitWebContinuation } = await import(repo + "/src/web-continuation.ts");
const { requestContextEnabledNotice } = await import(repo + "/src/request-context-control-copy.ts");
let view: any, revision = 0, writes = 0, failAfterWrite = false;
const fm = fx.fm;
// The real private-host session supplies the principal. This fixture exposes no CLI/model/lifecycle sink.
fm.requestContextControl = {
  principal(req: any) { const owner = fm.liveOwner(req, { hostOnly: false }); return owner && { binding: owner.handle, verified: true, current: owner.current }; },
  permitContinuation: (req: any, res: any) => permitWebContinuation(req, res, fm),
  read: () => structuredClone(view),
  recheck: () => structuredClone(view),
  snapshot: () => view ? structuredClone(view) : null,
  change(input: any, actor: any) {
    if (!actor.current() || !actor.verified) throw Error("owner-required");
    if (input.revision !== view.revision) throw Error("stale");
    writes++;
    if (input.action === "disable") view = { ...view, enabled: false, phase: "draining", revision: ++revision };
    if (failAfterWrite) throw Error("unavailable");
    return structuredClone(view);
  },
};
fm.needsYouItems = () => view.phase === "blocked" ? [{ id: "cutover-fixture", type: "config", reason: "request_context_cutover", instance: "", detail: "", since: Date.now(), requestContextCutover: structuredClone(view) }] : [];
const never = () => { throw Error("Capture fixture must never start, mutate or deliver to an agent"); };
fm.deliverToInstance = never; fm.deliverHumanToInstance = never; fm.saveFleetConfig = never;
const allStates = ["on", "off", "off-before", "draining", "blocked-legacy", "blocked-peers", "blocked-owners", "blocked-recovery", "on-confirm", "on-confirm-go-back", "stop-work-confirm", "blocked-update", "off-confirm", "unconfirmed-change", "general-notice"];
const states = process.env.STATES ? allStates.filter(state => process.env.STATES!.split(",").includes(state)) : allStates;
try {
  for (const variant of matrix()) for (const state of states) {
    failAfterWrite = state === "unconfirmed-change";
    const blocked = state.startsWith("blocked-") || state === "stop-work-confirm", kind = state === "stop-work-confirm" ? "recovery" : state.slice(8), phase = blocked ? "blocked" : (state.startsWith("off") && state !== "off-confirm" || state.startsWith("on-confirm")) ? "off" : state === "draining" ? "draining" : "on";
    view = { revision: ++revision, enabled: !["off", "off-before", "draining", "on-confirm", "on-confirm-go-back"].includes(state), attempted: state !== "off-before", everActivated: state === "blocked-recovery" || state === "stop-work-confirm" || !blocked && !["off-before", "on-confirm", "on-confirm-go-back"].includes(state), phase, canChange: true,
      blockers: blocked ? [{ id: "readiness-fixture", kind, labels: kind === "peers" ? ["Demo Windows computer"] : kind === "legacy" ? ["Demo worker → Demo helper #R1234"] : ["owners", "recovery"].includes(kind) ? ["Demo worker"] : [], ...(kind === "recovery" ? { action: "stop-work" } : kind === "legacy" ? { action: "inspect" } : {}) }]
        : state === "draining" ? [{ id: "return-fixture", kind: "returns", labels: ["Demo worker"], action: "stop-waiting" }] : [] };
    if (state === "on-confirm-go-back") view.goBack = { attemptIds: ["20261126T010203Z-0a1b2c3d"], availableUntil: "2026-12-03T02:30:00Z", timeZone: "Asia/Taipei" };
    const tag = `${caseName(variant)}-${state}`, path = blocked ? "/ui/needs" : state === "general-notice" ? "/ui/chat/general" : "/settings/access#request-context";
    fm.webChatHistory.forget("general");
    if (state === "general-notice") fm.emitSseEvent("message", { instance: "general", sender: "AgEnD", role: "status", text: requestContextEnabledNotice(variant.lang), ts: new Date().toISOString(), wrap: true });
    const { ctx, page, csp } = await fx.page(variant, { path, host: true });
    try {
      const dictionary = await page.evaluate(async () => {
        const m = await import("/ui/js/request-context-control.js");
        return { title: m.requestContextControlText("title"), off: m.requestContextControlText("off"), offBefore: m.requestContextControlText("offBefore"), notice: m.requestContextControlText("notice"), floor: m.requestContextControlText("floor"), floorBefore: m.requestContextControlText("floorBefore"), previous: m.requestContextControlText("previous"), failed: m.requestContextControlText("failed") };
      });
      check(`${tag}: General words match server`, dictionary.notice === requestContextEnabledNotice(variant.lang));
      if (state === "general-notice") {
        await page.getByText(dictionary.notice, { exact: true }).last().waitFor();
      } else if (blocked) {
        await page.getByRole("heading", { name: dictionary.title, exact: true }).waitFor();
        const text = await page.locator(".request-context-blocked").innerText();
        check(`${tag}: concrete blocker`, ["legacy", "update"].includes(kind) || text.includes(kind === "peers" ? "Demo Windows computer" : "Demo worker"));
        check(`${tag}: no invented raw code`, !text.includes("request_context"));
        check(`${tag}: inline recheck`, await page.locator(".request-context-blocked button").last().isVisible());
        if (variant.device === "desk") { const boxes = await page.locator(".request-context-actions > *").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top)); check(`${tag}: desktop actions share a row`, Math.max(...boxes) - Math.min(...boxes) < 2); }
        check(`${tag}: previous rules only before activation`, text.includes(dictionary.previous) === !view.everActivated);
        if (state === "stop-work-confirm") { const before = writes; await page.locator(".request-context-blocked").getByRole("button").first().click(); await page.getByRole("dialog").waitFor(); check(`${tag}: no destructive write before confirmation`, writes === before); }
      } else {
        const card = page.locator("#request-context"); await card.waitFor();
        await card.locator("input").waitFor(); await card.scrollIntoViewIfNeeded();
        if (state === "off") check(`${tag}: honest Off`, (await card.innerText()).includes(dictionary.off));
        if (state === "off-before") check(`${tag}: never-activated Off`, (await card.innerText()).includes(dictionary.offBefore));
        check(`${tag}: version warning`, (await card.innerText()).includes(view.everActivated ? dictionary.floor : dictionary.floorBefore));
        if (state === "on") {
          const older = { ...view, revision: view.revision - 1, enabled: false, phase: "off" };
          await page.evaluate(async value => { const { appStore } = await import("/assets/app-store.js"); appStore.set({ requestContextCutover: value }); }, older);
          await page.waitForTimeout(50);
          check(`${tag}: stale passive status cannot roll back the switch`, await card.locator("input").isChecked());
        }
        if (["on-confirm", "on-confirm-go-back", "off-confirm", "unconfirmed-change"].includes(state)) {
          const before = writes; await card.locator("label").click();
          await page.getByRole("dialog").waitFor();
          check(`${tag}: no write before confirmation`, writes === before);
          check(`${tag}: no old-rules promise`, !(await page.getByRole("dialog").innerText()).includes("previous"));
          if (state === "unconfirmed-change") {
            await page.locator('[data-confirm="yes"]').click();
            await card.getByRole("alert").waitFor();
            check(`${tag}: unconfirmed wording`, (await card.getByRole("alert").innerText()) === dictionary.failed);
            check(`${tag}: unknown switch`, await card.locator("input").getAttribute("aria-checked") === "mixed" && !await card.locator("input").isChecked());
            check(`${tag}: no blind write retry`, writes === before + 1 && await card.locator("input").isDisabled());
          }
        }
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      await page.mouse.move(1, 1); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      check(`${tag}: no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const file = join(out, `${tag}.png`); await page.screenshot({ path: file });
      check(`${tag}: CSP`, !(await csp()).length);
      receipt.pictures.push({ name: `${tag}.png`, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
    } finally { await ctx.close(); }
  }
  check("only deliberate synthetic unknown-result writes occurred", writes === (states.includes("unconfirmed-change") ? matrix().length : 0));
  writeFileSync(join(out, "capture.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ sourceHead, pictures: receipt.pictures.length, checks: receipt.checks.length }));
} finally { await fx.close(); }
