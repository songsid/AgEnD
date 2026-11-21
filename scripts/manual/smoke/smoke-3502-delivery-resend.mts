/** Product chat on an owned synthetic fixture; no Fleet/CLI/pane is launched. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bootFixture, matrix, shotPath, caseName } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48952), instances: 2, classic: false });
const fm = fx.fm, name = "example-agent", before = process.env.BEFORE === "1";
const template = fx.instances.find(i => !i.general)!.name;
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Example Agent", description: "Synthetic delivery fixture" };
delete fm.fleetConfig.instances[template];
fm.fleetConfig.teams = {};
const handed: any[] = [];
fm.instanceIpcClients.set(name, { connected: true, send: () => true });
fm.getInstanceStatus = () => "running";
fm.deliverHumanToInstance = async (_name: string, payload: any, _origin: unknown, _body: string, options: any) => {
  if (options?.stillCurrent && !options.stillCurrent()) return false;
  handed.push(payload); return true;
};
fm.startNeedsYou?.();
const report: any = { before, cases: {} };
try {
  for (const c of matrix(process.env.MATRIX ?? "quick")) {
    fm.webChatHistory.forget(name);
    const quoteText = c.lang === "en" ? "The example checklist is ready." : "測試清單已準備好。";
    fm.emitSseEvent("message", { instance: name, role: "agent", sender: "Example Agent", text: quoteText, ts: new Date().toISOString() });
    const quote = fm.webChatHistory.list(name).at(-1);
    const inbox = join(fx.dir, "fixture-inbox"); mkdirSync(inbox, { recursive: true });
    const file = fm.webFiles.storeUpload({ instance: name, inboxDir: inbox, bytes: Buffer.from("Synthetic checklist\nReview the example release.\n"), name: "checklist.txt", type: { kind: "document", mime: "text/plain", ext: ".txt" } });
    const taken = fm.webFiles.takeForMessage(name, [file.id]); if (!taken.ok) throw Error("fixture attachment refused"); fm.webFiles.commit(taken.entries);
    const wire = "web-" + randomUUID(), text = c.lang === "en" ? "Please check this checklist and the quoted answer." : "請檢查這份清單與引用的回覆。";
    fm.emitSseEvent("message", { instance: name, role: "user", sender: "Example person", retryOwner: "web:operator", text, ts: new Date().toISOString(), messageId: wire,
      attachments: [{ id: file.id, kind: file.kind, name: file.name, size: file.size, mime: file.mime }], replyTo: { boot: quote.boot, id: quote.id, sender: quote.sender, text: quote.text } });
    const row = fm.webChatHistory.list(name).at(-1);
    fm.finishDeliveryStatus(name, "web", wire, "failed");
    const p = await fx.page(c, { path: `/ui/chat/${name}` }), page = p.page;
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.locator("#msgIn").waitFor();
      const bubble = page.locator(`.msg[data-key="${row.boot}-${row.id}"]`); await bubble.waitFor(); await bubble.scrollIntoViewIfNeeded();
      const result: any = report.cases[caseName(c)] = {};
      const inspect = async () => ({ rows: await bubble.count(), sideways: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), quote: await bubble.innerText().then((s: string) => s.includes(quoteText)), file: await bubble.innerText().then((s: string) => s.includes("checklist.txt")) });
      result.failed = await inspect();
      if (result.failed.rows !== 1 || result.failed.sideways || !result.failed.quote || !result.failed.file) throw Error("failed bubble layout/content invariant");
      const button = bubble.locator('[data-act="resend"]');
      if (before) { if (await button.count()) throw Error("baseline unexpectedly has Resend"); await page.screenshot({ path: shotPath("3502", c, "before"), caret: "hide" }); continue; }
      await button.waitFor();
      result.button = await button.boundingBox();
      if (c.device === "phone" && (!result.button || result.button.width < 44 || result.button.height < 44)) throw Error("phone Resend target smaller than44px");
      await page.screenshot({ path: shotPath("3502", c, "failed"), caret: "hide" });
      const count = handed.length;
      await button.click();
      await page.waitForFunction(({ n, id }) => !document.querySelector(`.msg[data-key="${id}"] [data-act="resend"]`), { n: name, id: `${row.boot}-${row.id}` });
      if (handed.length !== count + 1 || row.messageId === wire || row.delivery !== "queued") throw Error("resend did not claim exactly one new attempt");
      result.queued = await inspect();
      result.needsDuringRetry = fm.webChatHistory.failedWebDeliveries(0).some((d: any) => d.deliveryId === `web:${row.boot}:${row.id}`);
      if (!result.needsDuringRetry) throw Error("attention cleared before confirmation");
      await page.screenshot({ path: shotPath("3502", c, "queued"), caret: "hide" });
      fm.finishDeliveryStatus(name, "web", wire, "delivered");
      if (!fm.webChatHistory.failedWebDeliveries(0).length) throw Error("late old attempt cleared attention");
      fm.finishDeliveryStatus(name, "web", row.messageId, "delivered");
      await page.waitForTimeout(300);
      result.delivered = await inspect(); result.needsCleared = fm.webChatHistory.failedWebDeliveries(0).length === 0;
      if (!result.needsCleared || result.delivered.rows !== 1 || result.delivered.sideways || !result.delivered.quote || !result.delivered.file) throw Error("confirmed resend invariants");
      await page.screenshot({ path: shotPath("3502", c, "delivered"), caret: "hide" });
      result.errors = errors; result.csp = await p.csp();
      if (errors.length || result.csp.length) throw Error("page error/CSP violation");
    } finally { await p.ctx.close(); }
  }
} finally {
  await fm.needsYou?.stop?.(); await fm.webChatStore?.flush?.();
  mkdirSync(process.env.OUT ?? ".artifacts/m3502/captures", { recursive: true });
  writeFileSync(join(process.env.OUT ?? ".artifacts/m3502/captures", "checks.json"), JSON.stringify(report, null, 2) + "\n");
  await fx.close();
}
