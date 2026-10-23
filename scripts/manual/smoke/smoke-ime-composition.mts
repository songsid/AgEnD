// The user's report (beta.27, iOS Safari, Zhuyin 注音): the IME's candidate bar flickers once on every keystroke while
// composing. From defaults (fleet decision a78ebdc5), on a phone (390×844, touch) with the keyboard up (the view 336 px
// shorter, as iOS reports it), a composition is typed into the chat composer the way WebKit delivers one:
// compositionstart, then per keystroke the composing text in the box (beforeinput/input with isComposing) while the
// candidate bar changes the view's height (±44 px), then compositionend with the chosen character.
// Counted per keystroke, during composition: the composer's DOM changes (attributes — style, class, hidden, disabled —
// and nodes added or removed under .composer-box), the box's value, selection or height written by the page, and the
// shell's chrome toggled (kb-open: the tabs and the composer row). Expected after the fix: 0 of each, every keystroke;
// the chosen text is in the draft after compositionend, and the drawn placeholder is hidden while the IME composes.
// Cases: phone light en (empty box), phone dark zh-TW (a draft already in the box), and a compact keyboard (120 px, as a
// hardware keyboard's bar): there the candidate bar alone crossed the keyboard threshold, so the tabs went out and back
// on every keystroke. LABEL=before|after names the shots (a short PNG sequence per case).
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-ime-composition.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "ime-composition", LABEL = process.env.LABEL ?? "after", KEYBOARD = 336, BAR = 44;
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48848), instances: 3 });
const CHAT = fx.instances.find((i: any) => !i.general)?.name ?? "agend-dev-claude-t1519896892392083558";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// The recorder: a MutationObserver on the composer and the shell's class, and the box's value, selection and height
// writes made by the page (the simulated IME's own writes are flagged and not counted).
const RECORDER = `(() => {
  const box = document.getElementById("msgIn"), shell = document.querySelector(".shell"), cb = document.querySelector(".composer-box");
  const w = (window.__ime = { muts: [], writes: [], kb: [], ime: false });
  new MutationObserver((list) => { for (const m of list) {
    if (m.target === shell && m.attributeName === "class") { w.kb.push(shell.classList.contains("kb-open")); continue; }
    if (!cb.contains(m.target) && m.target !== cb) continue;
    w.muts.push(m.type === "attributes" ? m.type + ":" + m.attributeName + "@" + (m.target.id || m.target.className || m.target.tagName) : m.type + "@" + (m.target.id || m.target.className || m.target.tagName));
  } }).observe(document.body, { subtree: true, attributes: true, childList: true, attributeOldValue: false });
  const proto = HTMLTextAreaElement.prototype, vd = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return vd.get.call(this); }, set(v) { if (!w.ime) w.writes.push("value"); vd.set.call(this, v); } });
  for (const k of ["selectionStart", "selectionEnd"]) { const d = Object.getOwnPropertyDescriptor(proto, k);
    Object.defineProperty(box, k, { configurable: true, get() { return d.get.call(this); }, set(v) { if (!w.ime) w.writes.push(k); d.set.call(this, v); } }); }
  const sr = proto.setSelectionRange; box.setSelectionRange = function (...a) { if (!w.ime) w.writes.push("setSelectionRange"); return sr.apply(this, a); };
  return true; })()`;
// The IME's own steps: the composing text in the box, and its events — what WebKit does for each keystroke.
const imeStep = (kind: string, text: string) => `(() => { const box = document.getElementById("msgIn"), w = window.__ime, base = box.dataset.imeBase || "";
  if (${JSON.stringify(kind)} === "start") { box.dataset.imeBase = box.value; box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })); return; }
  w.ime = true; box.value = (box.dataset.imeBase || "") + ${JSON.stringify(text)}; box.setSelectionRange(box.value.length, box.value.length); w.ime = false;
  const composing = ${JSON.stringify(kind)} !== "end";
  if (composing) box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: ${JSON.stringify(text)} }));
  box.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: composing, inputType: composing ? "insertCompositionText" : "insertFromComposition", data: ${JSON.stringify(text)} }));
  if (!composing) box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: ${JSON.stringify(text)} })); })()`;
const KEYS = ["ㄅ", "ㄅㄠ", "ㄅㄠˇ", "寶", "寶ㄅ", "寶ㄅㄟ", "寶ㄅㄟˋ"];
for (const c of [{ device: "phone", theme: "light", lang: "en", draft: "", kb: KEYBOARD }, { device: "phone", theme: "dark", lang: "zh-TW", draft: "今天要找", kb: KEYBOARD },
  { device: "phone", theme: "light", lang: "zh-TW", draft: "", kb: 120 }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}${c.kb === KEYBOARD ? "" : "-compact"}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any, { path: `/ui/chat/${CHAT}` }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const shot = (step: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  try {
    ok(res, "mounted", await mounted(page));
    const box = page.locator("#msgIn");
    await box.waitFor({ timeout: 15000 }); await page.waitForTimeout(400);
    await box.tap();
    if (c.draft) { await box.fill(c.draft); await page.waitForTimeout(300); }
    await page.setViewportSize({ width: 390, height: 844 - c.kb }); await page.waitForTimeout(500);   // the keyboard comes up
    if (c.kb === KEYBOARD) ok(res, "keyboardUp", await page.evaluate(`!!document.querySelector(".shell.kb-open")`) as boolean);
    const kbBefore = await page.evaluate(`!!document.querySelector(".shell.kb-open")`) as boolean;
    await page.evaluate(RECORDER);
    await page.evaluate(imeStep("start", ""));
    const per: any[] = [];
    let h = 844 - c.kb;
    let phWhileComposing: boolean | null = null;
    for (let i = 0; i < KEYS.length; i++) {
      await page.evaluate(`(() => { const w = window.__ime; w.muts = []; w.writes = []; w.kb = []; })()`);
      h = i % 2 === 0 ? 844 - c.kb - BAR : 844 - c.kb;                                         // the candidate bar comes and goes
      await page.setViewportSize({ width: 390, height: h });
      await page.evaluate(imeStep("update", KEYS[i]));
      await page.waitForTimeout(150);
      if (i === 0) phWhileComposing = await page.evaluate(`(() => { const e = document.querySelector(".composer-ph"); return !!e && getComputedStyle(e).display !== "none"; })()`) as boolean;
      const step = await page.evaluate(`(() => { const w = window.__ime; return { muts: w.muts.slice(), writes: w.writes.slice(), kb: w.kb.slice() }; })()`) as any;
      per.push({ key: KEYS[i], muts: step.muts.length, writes: step.writes.length, kb: step.kb.length, detail: { muts: [...new Set(step.muts)], writes: [...new Set(step.writes)] } });
      if (i < 4) await shot(`${i + 1}-composing`);
    }
    await page.evaluate(imeStep("end", "寶貝"));
    await page.waitForTimeout(300);
    await shot("5-committed");
    const after = await page.evaluate(`(() => ({ value: document.getElementById("msgIn").value, ph: !!document.querySelector(".composer-ph") && getComputedStyle(document.querySelector(".composer-ph")).display !== "none", send: !document.getElementById("sendBtn").disabled, kb: !!document.querySelector(".shell.kb-open") }))()`) as any;
    res.measured = { per, after };
    ok(res, "composing:noComposerMutations", per.every((s) => s.muts === 0), per.map((s) => [s.key, s.muts, s.detail.muts]));
    ok(res, "composing:noValueSelectionWrites", per.every((s) => s.writes === 0), per.map((s) => [s.key, s.writes, s.detail.writes]));
    ok(res, "composing:noChromeToggles", per.every((s) => s.kb === 0), per.map((s) => [s.key, s.kb]));
    if (c.kb === KEYBOARD) ok(res, "composing:keyboardStaysUp", await page.evaluate(`!!document.querySelector(".shell.kb-open")`) as boolean);
    ok(res, "composing:placeholderHidden", phWhileComposing === false, { phWhileComposing, kbBefore });
    ok(res, "end:textKept", after.value === c.draft + "寶貝", after);
    ok(res, "end:composerUpdated", after.send && !after.ph, after);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], per: v.measured?.per?.map((s: any) => `${s.key}: muts ${s.muts} ${JSON.stringify(s.detail.muts)} writes ${s.writes} kb ${s.kb}`), after: v.measured?.after }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
