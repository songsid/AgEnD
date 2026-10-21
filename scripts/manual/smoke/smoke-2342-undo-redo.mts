// #2342 from defaults (fleet decision a78ebdc5): Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y in the dashboard's text fields, typed
// with real keys in a fresh profile (sign in, open the agent from the sidebar). Per step, the field's value is read back.
// - desk: the composer — typing undone word by word and redone (Ctrl+Shift+Z, Ctrl+Y); a slash completion (Tab) and an
//   argument fill undone to what was typed; a failed send's Put back and a long paste's "As text" undone to the draft
//   before; a sent message not undone back into the box; one field's undo never touching another (the sidebar filter
//   and the composer); the sidebar filter's Esc clear undone; Settings → Web: the session-hours number box keeps
//   "1.50" as typed and undoes it; Ctrl+Z on a button is not taken; in Chromium, the browser's own Undo/Redo commands
//   (CDP) mixed with the keys walk the same history.
// - phone: typing and sending unchanged; no console error.
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account). A failed send is a refused /ui/send (a
// route on the page). Output: 2342/<case>-*.png and result.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2342-undo-redo.mts
//   PW_ENGINE=webkit: the same in WebKit (the Playwright image).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48810), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic undo fixture" };
delete fm.fleetConfig.instances[template];
const handoffs: string[] = [];
fm.instanceIpcClients.set(name, { connected: true, send(payload: any) { handoffs.push(payload.content); return true; } });
fm.getInstanceStatus = () => "running";

const r: any = { engine: process.env.PW_ENGINE ?? "chromium", cases: {} };
const SHEET = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const WEBKIT_OWN = new Set(['Viewport argument key "interactive-widget" not recognized and ignored.', SHEET]);
// The smoke's own refused send (step 4), and nothing else of its kind.
const REFUSED = /^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)( @ \S+\/ui\/send)?$/;
const errorsOf = (list: string[]) => list.filter((e) => !REFUSED.test(e) && !(r.engine === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, ""))));
const ok = (c: any, k: string, v: boolean, seen?: unknown) => { c[k] = v; if (!v) c.failed = [...(c.failed ?? []), `${k}${seen === undefined ? "" : ` ${JSON.stringify(seen)}`}`]; };

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c);
  const page = p.page;
  const shot = (label: string) => page.screenshot({ path: shotPath("2342", c as any, label), caret: "initial" });
  const box = page.locator("#msgIn");
  const val = () => box.inputValue();
  const keys = async (...ks: string[]) => { for (const k of ks) await page.keyboard.press(k); };
  const UNDO = "Control+z", REDO = "Control+Shift+z", REDO_Y = "Control+y";
  /** Values after each key, from the field that has focus. */
  const steps = async (loc: any, ...ks: string[]) => { const out: string[] = []; for (const k of ks) { await page.keyboard.press(k); out.push(await loc.inputValue()); } return out; };
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    await box.waitFor();
    await box.click();
    if (c.device === "phone") {
      await page.keyboard.type("Hello from the phone");
      const sent = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
      await page.locator("#sendBtn").click();
      ok(res, "phoneSends", (await sent).status() === 200 && await val() === "");
      await shot("phone");
      ok(res, "noErrors", errorsOf(p.errors).length === 0, errorsOf(p.errors));
      continue;
    }
    // 1. Typing: word by word back, then forward with Ctrl+Shift+Z and Ctrl+Y.
    await page.keyboard.type("hello world");
    ok(res, "typing", JSON.stringify(await steps(box, UNDO, UNDO, REDO, REDO_Y)) === JSON.stringify(["hello ", "", "hello ", "hello world"]), await val());
    await shot("1-typed");
    // 1b. The browser's own Undo/Redo commands (an Edit or context menu; sent through CDP in Chromium, which WebKit has no
    // way to send here), mixed with the keys: one history.
    if (r.engine === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      const cmd = async (c: string) => { await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", commands: [c] }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp" }); };
      await keys("Control+a", "Delete");
      await page.waitForTimeout(1100);                           // a new typing step
      await page.keyboard.type("alpha one");
      // The browser offers its own Redo only after its own undo (cancelled here): its Redo then changes nothing — the
      // keys redo. Its Undo always goes through the field's history.
      const seen: string[] = [];
      await cmd("Undo"); seen.push(await val());
      await keys(UNDO); seen.push(await val());
      await cmd("Redo"); seen.push(await val());
      await keys(REDO_Y); seen.push(await val());
      await keys(REDO); seen.push(await val());
      await cmd("Undo"); seen.push(await val());
      ok(res, "nativeMenuMixed", JSON.stringify(seen) === JSON.stringify(["alpha ", "", "", "alpha ", "alpha one", "alpha "]), seen);
    } else res.nativeMenuMixed = "n/a (no CDP in WebKit)";
    // 1c. A script's document.execCommand("undo"): the browser's own undo. Chromium sends only its input (no
    // beforeinput): its undo goes ahead and the field's history starts afresh. WebKit sends a cancelable beforeinput:
    // the field's own step runs. Either way Ctrl+Z after it never brings back text that undo took out.
    {
      await keys("Control+a", "Delete");
      await page.waitForTimeout(1100);
      await page.keyboard.type("alpha one");
      // A string: tsx would add a helper to a named function the page does not have.
      const events = await page.evaluate(`(() => {
        const el = document.querySelector("#msgIn"), seen = [];
        const on = (e) => { if (/^history/.test(e.inputType || "")) seen.push(e.type + ":" + e.inputType); };
        el.addEventListener("beforeinput", on, true); el.addEventListener("input", on, true);
        document.execCommand("undo");
        el.removeEventListener("beforeinput", on, true); el.removeEventListener("input", on, true);
        return seen;
      })()`) as string[];
      const afterNative = await val();
      await keys(UNDO);
      const afterKey = await val();
      res.execCommandEvents = events;
      ok(res, "execCommandUndo", afterNative !== "alpha one" && afterKey.length <= afterNative.length && afterNative.startsWith(afterKey), [events, afterNative, afterKey]);
    }
    // 2. A slash completion and an argument fill.
    await keys("Control+a", "Delete");
    await page.keyboard.type("/co");
    await keys("Tab");
    const completed = await val();
    ok(res, "completion", completed === "/compact " && JSON.stringify(await steps(box, UNDO, REDO)) === JSON.stringify(["/co", "/compact "]), completed);
    await keys("Control+a", "Delete");
    await page.keyboard.type("/btw");
    await keys("Escape", "Enter");
    const filled = await val();
    ok(res, "argumentFill", filled === "/btw " && JSON.stringify(await steps(box, UNDO)) === JSON.stringify(["/btw"]), filled);
    // 3. A sent message is not undone back into the box.
    await keys("Control+a", "Delete");
    await page.keyboard.type("Ship it");
    let sent = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await keys("Enter");
    await sent;
    ok(res, "sentNotUndone", await val() === "" && JSON.stringify(await steps(box, UNDO, UNDO)) === JSON.stringify(["", ""]) && handoffs.at(-1) === "Ship it");
    // 4. Put back: a send refused while a new draft is typed — the kept text goes back in, undoable to the draft.
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    await page.route("**/ui/send", async (route: any) => { await gate; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "refused for the smoke" }) }); });
    await page.keyboard.type("first try");
    sent = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await keys("Enter");
    await page.keyboard.type("draft");
    release();
    await sent;
    await page.unroute("**/ui/send");
    const putBack = page.locator(".btn-primary", { hasText: "Put back" });
    await putBack.waitFor({ timeout: 5000 });
    await shot("2-put-back-offered");
    await putBack.click();
    await box.click();
    const back = await val();
    ok(res, "putBack", back.includes("first try") && back.includes("draft") && JSON.stringify(await steps(box, UNDO, REDO)) === JSON.stringify(["draft", back]), back);
    // 5. A long paste goes as a file; "As text" brings it back as text — undoable to the draft before.
    await keys("Control+a", "Delete");
    await page.keyboard.type("note");
    const long = "x".repeat(20000);
    await box.evaluate((el: any, text: string) => { const dt = new DataTransfer(); dt.setData("text/plain", text); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, long);
    const asText = page.locator("button.as-text");
    const attached = await asText.waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (attached) {
      await asText.click();
      await box.click();
      const withText = await val();
      ok(res, "asText", withText === `note\n${long}` && JSON.stringify(await steps(box, UNDO)) === JSON.stringify(["note"]), withText.length);
    } else ok(res, "asText", false, "no As text button (the paste was not attached)");
    await keys("Control+a", "Delete");
    // 6. One field's history: the sidebar filter and the composer.
    const filter = page.locator("#filterInput");
    await filter.click(); await page.keyboard.type("dem");
    await box.click(); await page.keyboard.type("abc");
    await keys(UNDO);
    ok(res, "perField", await val() === "" && await filter.inputValue() === "dem", [await val(), await filter.inputValue()]);
    // 7. The filter's Esc clear is undoable.
    await filter.click(); await keys("Escape");
    const cleared = await filter.inputValue();
    ok(res, "filterEscUndo", cleared === "" && JSON.stringify(await steps(filter, UNDO)) === JSON.stringify(["dem"]), cleared);
    await keys("Escape");
    await shot("3-filter");
    // 8. Ctrl+Z on a button: not taken (the default is the browser's).
    const prevented = await page.locator("#sendBtn").evaluate((b: any) => { const e = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }); b.dispatchEvent(e); return e.defaultPrevented; });
    ok(res, "buttonNotTaken", prevented === false);
    // 9. Settings → Web: the session-hours number box keeps what was typed ("1.50"), undoable.
    await page.goto(new URL("/settings/web", page.url()).href);
    const hours = page.locator("#vaHours");
    await hours.waitFor({ timeout: 10000 });
    await hours.click(); await keys("Control+a", "Delete"); await page.keyboard.type("1.50");
    const typed = await hours.inputValue();
    await page.waitForTimeout(300);                                // past a re-render
    ok(res, "hoursAsTyped", typed === "1.50" && await hours.inputValue() === "1.50", await hours.inputValue());
    ok(res, "hoursUndo", (await steps(hours, UNDO))[0] !== "1.50", await hours.inputValue());
    await shot("4-hours");
    ok(res, "noErrors", errorsOf(p.errors).length === 0, errorsOf(p.errors));
  } catch (e) {
    ok(res, "threw", false, String(e).slice(0, 400));
  } finally {
    await p.ctx.close();
  }
}

const failed = Object.entries(r.cases).filter(([, v]: any) => v.failed);
writeFileSync(join(process.env.OUT ?? ".", "2342", `result-${r.engine}.json`), JSON.stringify(r, null, 2));
for (const [k, v] of Object.entries(r.cases) as any) console.log(`${v.failed ? "FAIL" : "ok  "} ${r.engine}-${k}${v.failed ? ` ${v.failed.join("; ")}` : ""}`);
console.log(failed.length ? `FAIL (${r.engine})` : `PASS (${r.engine})`);
await fx.close();
process.exit(failed.length ? 1 : 0);
