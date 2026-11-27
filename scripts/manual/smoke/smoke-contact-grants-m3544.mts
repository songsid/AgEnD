// Real product HTTP/UI with a scratch-only outbox and synthetic identities. No daemons, external accounts or live state.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "demo-room", backend: "codex", displayName: "Demo room" }, { name: "demo-worker", backend: "codex", displayName: "Demo worker" }] });
const { DeliveryOutbox } = await import(process.env.REPO + "/src/delivery-outbox.ts");
const { setLocale } = await import(process.env.REPO + "/src/locale.ts");
const fm = fx.fm, db = new DeliveryOutbox(join(fx.dir, "synthetic-outbox.db")), store = db.contactAuthorizations;
fm.deliveryOutbox = db; fm.scheduleDeliveryOutboxPump = () => {};
fm.contactGeneration = (name: string) => `synthetic-${name}-one`;
const people = [{ platform: "discord", adapterId: "demo", userId: "fake-alex", label: "Alex" }, { platform: "discord", adapterId: "demo", userId: "fake-river", label: "River" }];
let seq = 0;
const ticket = (kind: "human" | "mixed" | "unknown") => store.hold({ operationId: `synthetic-${++seq}`, source: "demo-room", target: "demo-worker", sourceGeneration: fm.contactGeneration("demo-room"), targetGeneration: fm.contactGeneration("demo-worker"), verb: "request_information",
  origin: { kind, people: kind === "unknown" ? [] : kind === "human" ? people.slice(0, 1) : people, receiptIds: ["synthetic-receipt"], chain: ["demo-room"] },
  message: "Please summarize the public example status page.", correlationId: `synthetic-${seq}`, resultRecipient: "demo-room", payload: { type: "fleet_inbound", content: "Synthetic public-information request" } });
const results: any[] = [];
try {
  for (const c of matrix()) {
    setLocale(c.lang);
    (store as any).db.exec("DELETE FROM contact_auth_tickets; DELETE FROM contact_auth_policies; DELETE FROM contact_auth_history;");
    const one = ticket("human");
    const { page, ctx, csp } = await fx.page(c, { host: true, path: `/ui/fleet/authorizations?ticket=${one.id}` });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    const prefix = `${c.device}-${c.theme}-${c.lang}`;
    const shot = async (state: string) => {
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const open = page.locator("dialog[open]");
      const dialog = await open.count() ? await open.boundingBox() : null;
      if (dialog && c.device === "desk" && (dialog.x <= 0 || Math.abs(dialog.x + dialog.width / 2 - 1366 / 2) > 2)) throw Error("Shared dialog is not centered");
      if (dialog && c.device === "phone" && Math.abs(dialog.y + dialog.height - 844) > 2) throw Error("Phone dialog is not a bottom sheet");
      await page.screenshot({ path: join(out, `${prefix}-${state}.png`) });
    };
    const en = c.lang === "en";
    const card = page.locator(`[data-ticket="${one.id}"]`).first();
    await card.getByRole("button", { name: en ? "Allow this person to contact this agent…" : "允許這個人聯絡此 Agent…", exact: true }).waitFor();
    await shot("card");
    await card.getByRole("button", { name: en ? "Allow this person to contact this agent…" : "允許這個人聯絡此 Agent…", exact: true }).click();
    await page.locator("dialog[open]").waitFor(); await shot("single");
    await page.getByRole("dialog").getByRole("button", { name: en ? "Approve this one and allow from now on" : "核准這筆，並設為常用轉交", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if (store.policy("demo-worker", fm.contactGeneration("demo-worker")).grants.length !== 1) throw Error("Single grant was not saved");
    const multi = ticket("mixed");
    await page.goto(`${fx.base}/ui/fleet/authorizations?ticket=${multi.id}`);
    await page.locator(`[data-ticket="${multi.id}"]`).first().getByRole("button", { name: en ? "Set allowed contacts for these people…" : "設定這些人的常用轉交…", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    if (await page.getByRole("dialog").locator('input[type="checkbox"]:checked').count()) throw Error("Multi-person selection was silently checked");
    await shot("multiple");
    await page.getByRole("dialog").getByRole("button", { name: en ? "Cancel" : "取消", exact: true }).click();
    const unknown = ticket("unknown"); await page.goto(`${fx.base}/ui/fleet/authorizations?ticket=${unknown.id}`);
    await page.locator(`[data-ticket="${unknown.id}"]`).first().getByRole("button", { name: en ? "Approve once" : "核准這一次", exact: true }).waitFor(); await shot("unknown");
    await page.goto(`${fx.base}/ui/fleet/agent/demo-worker?cat=permissions`);
    await page.getByRole("button", { name: en ? "Adjust / extend" : "調整／延長", exact: true }).waitFor(); await page.locator(".contact-grants").scrollIntoViewIfNeeded(); await shot("permissions");
    await page.getByRole("button", { name: en ? "Adjust / extend" : "調整／延長", exact: true }).click();
    await page.locator("dialog[open]").waitFor(); await shot("adjust");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const violations = await csp();
    results.push({ ...c, overflow, errors, violations, grantCount: store.policy("demo-worker", fm.contactGeneration("demo-worker")).grants.length });
    if (overflow || errors.length || violations.length) throw Error("Browser control failed");
    await ctx.close();
  }
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
} finally { fm.deliveryOutbox = null; db.close(); await fx.close(); }
