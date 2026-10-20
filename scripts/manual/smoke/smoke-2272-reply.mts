// #2272 from defaults (fleet decision a78ebdc5): reply to a message in the web chat, in a fresh profile driven only through
// visible UI — sign in, open the agent from the sidebar (a phone: through the drawer), reply.
// - desk: the hover ↩ on the agent's message → the reply bar → send → the agent is handed `reply_to_text`; the sent
//   bubble's quote shows the original, flashed; right-click → Reply / Copy text / Copy link; Esc cancels; R on a focused
//   message replies.
// - phone: swipe left on the message (as in Telegram) → the reply bar (the drawer stays shut) → send → handed; a long
//   press → the menu; and a swipe right on that same message still opens the drawer (#1605).
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account); its message is a synthetic SSE row.
// Output: 2272/<case>-*.png and result.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2272-reply.mts
//   PW_ENGINE=webkit: the same in WebKit (see README: the Playwright image).
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48790), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic reply fixture" };
delete fm.fleetConfig.instances[template];
const handoffs: Array<{ text: string; replyTo?: string }> = [];
fm.instanceIpcClients.set(name, { connected: true, send(payload: any) { handoffs.push({ text: payload.content, replyTo: payload.meta?.reply_to_text }); return true; } });
fm.getInstanceStatus = () => "running";
const QUESTION = "Shall I deploy the demo build to staging?";
/**
 * In-page: one touch event on a message's body, as a finger sends it (a real Touch where the engine has one, else the
 * same fields on a plain event). A string: tsx would add a helper to a function the page does not have.
 */
const TOUCH = `const touch = (el, type, x, y, id) => { const t = { identifier: id, target: el, clientX: x, clientY: y }; let ev;
  try { const one = new Touch(t); ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [one], changedTouches: [one] }); }
  catch { ev = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [t] }); Object.defineProperty(ev, "changedTouches", { value: [t] }); }
  el.querySelector(".body").dispatchEvent(ev); };
`;
/** Runs an in-page function given as source on the element (an anonymous wrapper: nothing for tsx to name). */
const RUN = (el: any, src: string) => (0, eval)(src)(el);
const r: any = { engine: process.env.PW_ENGINE ?? "chromium", cases: {} };
// WebKit's own console lines, accepted exactly and printed apart:
// - the viewport meta's interactive-widget key it doesn't know;
// - "Refused to apply a stylesheet …" exactly once per screenshot: Playwright styles the page for a shot (even with
//   `caret: "initial"`), and the page's CSP refuses that in WebKit. Each case counts its shots and requires that many;
//   `SHOTS=0` takes none and then accepts none — the run that shows the product itself adds no such line.
const SHOTS = process.env.SHOTS !== "0";
const SHEET = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const WEBKIT_OWN = new Set(['Viewport argument key "interactive-widget" not recognized and ignored.', ...(SHOTS ? [SHEET] : [])]);
const errorsOf = (list: string[]) => r.engine !== "webkit" ? list : list.filter((e) => !WEBKIT_OWN.has(e.replace(/ @ \S+$/, "")));
const ok = (c: any, k: string, v: boolean) => { c[k] = v; if (!v) c.failed = [...(c.failed ?? []), k]; };

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: QUESTION, ts: new Date().toISOString() });
  const p = await freshPage(fx, c);
  const page = p.page;
  let shots = 0;
  const shot = async (label: string) => { if (!SHOTS) return; shots++; await page.screenshot({ path: shotPath("2272", c as any, label), caret: "initial" }); };
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    await page.locator("#msgIn").waitFor();
    const agentMsg = page.locator(".msg.agent", { hasText: QUESTION }).last();
    await agentMsg.waitFor();
    const before = handoffs.length;
    if (c.device === "desk") {
      await agentMsg.hover();
      await agentMsg.locator('.msg-actions button[data-act="reply"]').click();
    } else {
      // A swipe left on the message (synthetic touches: the same events a finger sends).
      await agentMsg.evaluate(RUN, `(el) => { ${TOUCH} const r0 = el.getBoundingClientRect(), y = r0.top + r0.height / 2; for (const [type, dx] of [["touchstart", 200], ["touchmove", 170], ["touchmove", 130], ["touchend", 130]]) touch(el, type, r0.left + dx, y, 1); }`);
      ok(res, "drawerShut", await page.locator("#main[inert]").count() === 0);
    }
    const bar = page.locator(".reply-bar");
    await bar.waitFor({ timeout: 5000 });
    ok(res, "barNamesSender", (await bar.textContent())!.includes(name));
    await shot("bar");
    await page.locator("#msgIn").fill(c.lang === "en" ? "Yes, go ahead" : "好，部署吧");
    const sent = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await page.locator("#sendBtn").click();
    ok(res, "sent200", (await sent).status() === 200);
    ok(res, "handedReplyTo", handoffs.length === before + 1 && handoffs.at(-1)!.replyTo === QUESTION);
    ok(res, "barGone", await bar.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));
    const quote = page.locator(".msg.user .msg-quote").last();
    await quote.waitFor();
    ok(res, "quoteShown", (await quote.textContent())!.includes(QUESTION.slice(0, 20)));
    await shot("sent");
    await quote.click();
    ok(res, "jumpFlashes", await agentMsg.evaluate((el: HTMLElement) => el.classList.contains("flash")));
    // The message menu: right-click on a desk, a long press on a phone.
    if (c.device === "desk") await agentMsg.locator(".body").click({ button: "right" });
    else await agentMsg.evaluate(RUN, `(el) => { ${TOUCH} return new Promise((done) => { const r0 = el.getBoundingClientRect(); touch(el, "touchstart", r0.left + 30, r0.top + 10, 2); setTimeout(done, 650); }); }`);
    const menu = page.locator(".msg-menu");
    await menu.waitFor({ timeout: 5000 });
    ok(res, "menuItems", JSON.stringify(await menu.locator("button").allTextContents()) === (c.lang === "en" ? '["Reply","Copy text","Copy link"]' : '["回覆","複製文字","複製連結"]'));
    await shot("menu");
    await menu.locator('[data-item="reply"]').click();
    await bar.waitFor();
    await page.locator("#msgIn").press("Escape");
    ok(res, "escCancels", await bar.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));
    if (c.device === "phone") {
      // A swipe right on that same message is the drawer's (#1605), as everywhere in the chat.
      await agentMsg.evaluate(RUN, `(el) => { ${TOUCH} const r0 = el.getBoundingClientRect(), y = r0.top + r0.height / 2; for (const [type, dx] of [["touchstart", 40], ["touchmove", 80], ["touchmove", 130], ["touchend", 130]]) touch(el, type, r0.left + dx, y, 3); }`);
      ok(res, "swipeRightOpensDrawer", await page.locator("#main[inert]").waitFor({ timeout: 3000 }).then(() => true, () => false));
      ok(res, "swipeRightNoReply", await bar.count() === 0);
    }
    if (c.device === "desk") {
      await agentMsg.focus(); await page.keyboard.press("r");
      ok(res, "rReplies", await bar.count() === 1);
      await page.locator("#msgIn").press("Escape");
    }
    ok(res, "noPageErrors", errorsOf(p.errors).length === 0);
    // WebKit: exactly one refused sheet per screenshot, none without screenshots.
    if (r.engine === "webkit") ok(res, "sheetPerShot", p.errors.filter((e: string) => e.startsWith(SHEET)).length === shots);
    res.errors = errorsOf(p.errors);
    res.engineOwn = p.errors.filter((e: string) => !errorsOf([e]).length);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 200)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("2272", "result", "x").replace(/-x\.png$/, `-${r.engine}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
