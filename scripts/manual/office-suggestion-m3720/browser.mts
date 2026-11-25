/**
 * M-3720 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services): the office with the
 * fixture's ClassicBot rooms — none restricted, so Needs you lists each one's "can switch to restricted mode" suggestion
 * (contact_restricted_suggestion) — and one real call: a held contact request to "worker". The rooms sit where their
 * state puts them, not in the Help desk; "worker" is in the Help desk. Each case checks, in the page, that the rooms'
 * suggestions are there and what state the office draws each agent in (fleet-org.js buildOrgView, the office's own).
 *   CHROME=<linux chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/office-suggestion-m3720/browser.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";
import { withDisplay } from "../smoke-fixture/office-display.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], states: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, host: true, classic: true, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "lead", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "worker", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
let ROOMS: string[] = [];
try {
  const fm = fx.fm;
  fm.scheduleDeliveryOutboxPump = () => {};
  fm.ensureDeliveryOutbox();
  // The ClassicBot rooms (classicBot.yaml, written by the fixture): the real registry, as a fleet start loads it.
  const { ClassicChannelManager } = await import(REPO + "/src/classic-channel-manager.ts");
  fm.classicChannels = new ClassicChannelManager(fx.dir, fm.logger);
  fm.classicChannels.configureAdapters([{ id: "telegram", type: "telegram" }]);
  // The rooms the registry holds (two of the fixture's rooms share one channel on one bot: it keeps one).
  ROOMS = fm.classicChannels.getAll().map((r: any) => r.instanceName);
  receipt.rooms = ROOMS;
  if (ROOMS.length < 3) throw new Error(`expected the fixture's ClassicBot rooms, got ${ROOMS.length}`);
  // The real call: a held contact request to "worker" (lead's retained origin unknown).
  fm.deliveryOutbox.contactAuthorizations.hold({ operationId: "fake-op", source: "lead", target: "worker", sourceGeneration: fm.contactGeneration("lead"),
    targetGeneration: fm.contactGeneration("worker"), verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] },
    message: "Please run the release checklist.", correlationId: "fake-correlation", resultRecipient: "lead", payload: { content: "synthetic" } });
  // What the office draws each agent as: its own buildOrgView over the page's store and /ui/org.
  const states = (page: any) => page.evaluate(async () => {
    const [{ buildOrgView }, { appStore }] = await Promise.all([import("/ui/js/fleet-org.js"), import("/assets/app-store.js")]);
    const org = await (await fetch("/ui/org", { credentials: "same-origin" })).json();
    const app = appStore.get(), view = buildOrgView(org, app);
    const nodes = [...view.top, ...view.teams.flatMap((t: any) => t.nodes), ...view.rest.nodes];
    return { states: Object.fromEntries(nodes.map((n: any) => [n.name, n.state])),
      suggested: (app.needs || []).filter((i: any) => i.reason === "contact_restricted_suggestion").map((i: any) => i.instance) };
  });
  const runs: Array<{ c: any; style?: string }> = [
    ...matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW").map((c) => ({ c })),
  ];
  for (const style of (process.env.STYLES ?? "pixel,studio,cozy").split(",")) runs.push({ c: matrix("desk-light-en")[0], style });
  for (const { c, style } of runs) {
    const tag = `${caseName(c)}${style ? `-${style}` : ""}`;
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "office" } });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(`${fx.base}/ui/fleet/org`);
      check(`${tag}: the app mounted`, await mounted(page, 30000));
      await page.waitForSelector(".oo-canvas", { timeout: 15000 });
      if (style) {
        const picker = page.locator("select.oo-style");
        await withDisplay(page, async () => { if ((await picker.inputValue()) !== style) await picker.selectOption(style); });
      }
      await page.waitForFunction(() => document.querySelector(".oo-canvas"), null, { timeout: 15000 });
      await page.waitForTimeout(3000);
      const s = await states(page);
      receipt.states[tag] = s.states;
      check(`${tag}: every ClassicBot room has its restricted-mode suggestion in Needs you`, ROOMS.every((r) => s.suggested.includes(r)), s.suggested);
      check(`${tag}: no room is drawn calling for it (not "needs")`, ROOMS.every((r) => s.states[r] && s.states[r] !== "needs"), ROOMS.map((r) => [r, s.states[r]]));
      check(`${tag}: the real call still calls: worker is "needs"`, s.states.worker === "needs", s.states.worker);
      await page.waitForTimeout(400);
      const path = `m3720-${tag}.png`;
      await page.screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
      check(`${tag}: no page errors`, errors.length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally {
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
