// #2305 from defaults (fleet decision a78ebdc5): an agent answers a web "OK" with a reaction — in a fresh profile driven
// only through visible UI: sign in, open the agent from the sidebar (a phone: through the drawer), send "OK".
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account): the message it is handed carries the web
// message id, and its `react` call goes through the fleet's real tool path (handleOutboundFromInstance, as an MCP call
// arrives) — the tool's answer must be "ok". Then: 👍 under the person's bubble, live; still there after a reload; and
// no "ended its turn without a reply" line anywhere in the chat (the reply guard's own rule is unit-tested: a
// successful react is the turn's answer).
// Output: 2305/<case>-*.png and result-<engine>.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> MATRIX=quick npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2305-web-react.mts
//   PW_ENGINE=webkit: the same in WebKit (see README: the Playwright image).
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48890), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic reaction fixture" };
delete fm.fleetConfig.instances[template];
const handed: Array<{ text: string; messageId?: string }> = [];
const answers: Array<{ result: unknown; error?: string }> = [];
fm.instanceIpcClients.set(name, { connected: true, send(payload: any) {
  if (payload?.type === "fleet_outbound_response") answers.push({ result: payload.result, error: payload.error });
  else if (typeof payload?.content === "string") handed.push({ text: payload.content, messageId: payload.meta?.message_id });
  return true;
} });
fm.getInstanceStatus = () => "running";

const r: any = { engine: process.env.PW_ENGINE ?? "chromium", cases: {} };
const SHOTS = process.env.SHOTS !== "0";
const SHEET = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const WEBKIT_OWN = new Set(['Viewport argument key "interactive-widget" not recognized and ignored.', SHEET]);
const errorsOf = (list: string[]) => r.engine !== "webkit" ? list : list.filter((e) => !WEBKIT_OWN.has(e.replace(/ @ \S+$/, "")));
const ok = (c: any, k: string, v: boolean) => { c[k] = v; if (!v) c.failed = [...(c.failed ?? []), k]; };
/** The reply guard's line, in both languages (locale.ts inst.reply_drop_retrying): never shown for a reacted turn. */
const NO_REPLY = /ended (its|this) turn without|沒有送出回覆/i;

for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c);
  const page = p.page;
  let shots = 0;
  const shot = async (label: string) => { if (!SHOTS) return; shots++; await page.screenshot({ path: shotPath("2305", c as any, label), caret: "initial" }); };
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    await page.locator("#msgIn").waitFor();
    const before = handed.length;
    await page.locator("#msgIn").fill("OK");
    const sent = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await page.locator("#sendBtn").click();
    ok(res, "sent200", (await sent).status() === 200);
    for (let i = 0; i < 50 && handed.length === before; i++) await new Promise(s => setTimeout(s, 100));
    const msg = handed.at(-1);
    ok(res, "handedWebId", handed.length === before + 1 && /^web-/.test(msg?.messageId ?? ""));
    const bubble = page.locator(".msg.user", { hasText: "OK" }).last();
    await bubble.waitFor();
    // The agent's minimal reply, as its MCP call reaches the fleet.
    await fm.handleOutboundFromInstance(name, { tool: "react", args: { message_id: msg!.messageId, emoji: "👍" }, fleetRequestId: `tool_${tag}` });
    ok(res, "toolOk", answers.at(-1)?.result === "ok" && !answers.at(-1)?.error);
    const reaction = bubble.locator(".msg-reactions .reaction");
    ok(res, "reactionLive", await reaction.first().waitFor({ timeout: 5000 }).then(() => true, () => false));
    ok(res, "isThumb", ((await reaction.first().textContent()) ?? "").startsWith("👍"));
    // The chip as drawn: its box and colours (a chip, not a bare glyph), and the font that drew the emoji.
    res.chip = await reaction.first().evaluate((el: HTMLElement) => { const cs = getComputedStyle(el), b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), bg: cs.backgroundColor, border: cs.borderTopColor + " " + cs.borderTopWidth, font: cs.fontFamily.slice(0, 60) }; });
    ok(res, "chipDrawn", res.chip.w >= 24 && res.chip.h >= 20 && res.chip.bg !== "rgba(0, 0, 0, 0)");
    ok(res, "labelled", ((await bubble.locator(".msg-reactions").getAttribute("aria-label")) ?? "").includes(name));
    ok(res, "noNoReplyLine", !NO_REPLY.test((await page.locator(".thread").textContent()) ?? ""));
    await shot("reacted");
    // Kept: a reload shows it again (from the history).
    await page.reload();
    await page.locator("#msgIn").waitFor();
    const again = page.locator(".msg.user", { hasText: "OK" }).last().locator(".msg-reactions .reaction");
    ok(res, "keptAfterReload", await again.first().waitFor({ timeout: 5000 }).then(() => true, () => false));
    ok(res, "noNoReplyLineAfterReload", !NO_REPLY.test((await page.locator(".thread").textContent()) ?? ""));
    await shot("reloaded");
    ok(res, "noPageErrors", errorsOf(p.errors).length === 0);
    res.errors = errorsOf(p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("2305", "result", "x").replace(/-x\.png$/, `-${r.engine}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
