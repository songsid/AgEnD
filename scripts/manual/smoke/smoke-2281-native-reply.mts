// #2281 from defaults (fleet decision a78ebdc5): a web chat reply's copy in the instance's topic is a native platform
// reply — driven only through visible UI in a fresh profile: sign in, open the agent from the sidebar (a phone: through
// the drawer), reply to a message (desk: the hover ↩; phone: a swipe left), send.
// - native: a person's platform message in the agent's own topic → the echo's sendText carries replyTo = its platform
//   message id, and its text has no quoted line;
// - fallback: a message from another topic, and one with no known platform post (an older row) → no replyTo, and the
//   quoted line ("↩ sender: …") opens the echo, as before.
// The topic's connection is a stub adapter that records sendText (no Discord, Telegram, CLI, tmux, vendor or account);
// the agent is a stub at the IPC boundary. Output: 2281/<case>-*.png and result.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2281-native-reply.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48814), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent", GROUP = "-1001234567890", TOPIC = 77;
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic reply fixture", topic_id: TOPIC };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
// The topic's connection: records every echo it is asked to post.
const echoes: Array<{ chatId: string; text: string; opts: any }> = [];
let next = 9000;
const stub = { id: "tg-stub", type: "telegram", react: async () => {}, sendText: async (chatId: string, text: string, opts: any) => { echoes.push({ chatId, text, opts }); return { messageId: String(++next), chatId, threadId: opts?.threadId }; } };
fm.getAdapterForInstance = () => stub;
fm.getGroupIdForInstance = () => GROUP;
/** A person's platform message, as the fleet records one: here (this topic) or in another topic of the group. */
const inbound = (text: string, thread: string, messageId: string) => fm.emitPlatformInbound(name, { username: "Ann", adapterId: "tg-stub", userId: "42", chatId: GROUP, threadId: thread, messageId }, text);
/** A row with no known platform post (as every row from before #2281). */
const older = (text: string) => fm.emitSseEvent("message", { instance: name, sender: "Ann", role: "user", text, ts: new Date().toISOString(), channel: true });

const TOUCH = `const touch = (el, type, x, y, id) => { const t = { identifier: id, target: el, clientX: x, clientY: y }; let ev;
  try { const one = new Touch(t); ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [one], changedTouches: [one] }); }
  catch { ev = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [t] }); Object.defineProperty(ev, "changedTouches", { value: [t] }); }
  el.querySelector(".body").dispatchEvent(ev); };
`;
const RUN = (el: any, src: string) => (0, eval)(src)(el);
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const id = c.device === "desk" ? 1 : 2;
  const HERE = `Shall I deploy build ${id}?`, THERE = `Other topic question ${id}`, OLD = `An older question ${id}`;
  inbound(HERE, String(TOPIC), String(5550 + id));
  inbound(THERE, "78", String(5560 + id));
  older(OLD);
  const p = await freshPage(fx, c);
  const page = p.page;
  const shot = (label: string) => page.screenshot({ path: shotPath("2281", c as any, label), caret: "initial" });
  /** Reply to the message with this text through the visible UI, send, and return the echo the stub was asked for. */
  const replyTo = async (text: string, words: string) => {
    const msg = page.locator(".msg.user", { hasText: text }).last();
    await msg.waitFor();
    if (c.device === "desk") { await msg.hover(); await msg.locator('.msg-actions button[data-act="reply"]').click(); }
    else await msg.evaluate(RUN, `(el) => { ${TOUCH} const r0 = el.getBoundingClientRect(), y = r0.top + r0.height / 2; for (const [type, dx] of [["touchstart", 200], ["touchmove", 170], ["touchmove", 130], ["touchend", 130]]) touch(el, type, r0.left + dx, y, 1); }`);
    await page.locator(".reply-bar").waitFor({ timeout: 5000 });
    await page.locator("#msgIn").fill(words);
    const before = echoes.length;
    const accepted = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await page.locator("#sendBtn").click();
    ok(res, `sent200:${words}`, (await accepted).status() === 200);
    for (let i = 0; i < 50 && echoes.length === before; i++) await page.waitForTimeout(100);
    return echoes.slice(before)[0];
  };
  try {
    ok(res, "mounted", await mounted(page) && p.errors.length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    await page.locator("#msgIn").waitFor();

    const native = await replyTo(HERE, c.lang === "en" ? "Yes, go ahead" : "好，部署吧");
    ok(res, "nativeReplyTo", native?.opts?.replyTo === String(5550 + id) && native?.opts?.threadId === String(TOPIC), native && { replyTo: native.opts.replyTo, threadId: native.opts.threadId });
    ok(res, "nativeNoQuotedLine", !!native && !native.text.includes(HERE) && !native.text.includes("↩"), native?.text);
    await shot("1-native-sent");

    const other = await replyTo(THERE, c.lang === "en" ? "Not here" : "不是這裡");
    ok(res, "otherTopicNoReplyTo", !!other && other.opts.replyTo === undefined, other?.opts?.replyTo);
    ok(res, "otherTopicQuotedLine", !!other && other.text.includes("↩") && other.text.includes(THERE.slice(0, 12)), other?.text);

    const old = await replyTo(OLD, c.lang === "en" ? "From before" : "之前的");
    ok(res, "noPostNoReplyTo", !!old && old.opts.replyTo === undefined, old?.opts?.replyTo);
    ok(res, "noPostQuotedLine", !!old && old.text.includes("↩") && old.text.includes(OLD.slice(0, 12)), old?.text);
    await shot("2-fallback-sent");
    ok(res, "noPageErrors", p.errors.length === 0);
    res.errors = p.errors;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.echoes = echoes.map(e => ({ chatId: e.chatId, threadId: e.opts?.threadId, replyTo: e.opts?.replyTo ?? null, text: e.text }));
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("2281", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, failed: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
