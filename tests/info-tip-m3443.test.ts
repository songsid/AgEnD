/**
 * M-3443 (the user, 11-20): one info icon for the web UI — src/ui/shared/info-tip.js, docs/design/ui-style-guide.md rule 14.
 * - A button named by `label`, its detail its description (aria-describedby: the bubble, hidden while closed);
 * - it opens on a hover (unless the screen has none), a keyboard focus, or a tap (which keeps it open); a second tap,
 *   Esc (stopped there: a dialog around it stays open), a click elsewhere, a scroll or leaving with the keyboard closes it;
 *   aria-expanded follows;
 * - CSS: 18px drawn, the --tap box on a touch screen; the bubble fixed to the window (no group clips it), hidden when closed;
 * - no hover-only mark anywhere in src/ui (the usage dialog's old role=img ⓘ), and the Settings ⓘ is this one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } delete (globalThis as any).matchMedia; });

async function tip(opts: { hover?: boolean } = {}) {
  const p = page({ url: "http://127.0.0.1:19280/ui/settings" }); pages.push(p);
  (globalThis as any).matchMedia = (q: string) => ({ matches: /hover:\s*none/.test(q) ? opts.hover === false : false, addEventListener() {}, removeEventListener() {} });
  const { InfoTip } = await import("/assets/info-tip.js" as string);
  await p.mount(h("div", null, h("p", { id: "elsewhere" }, "elsewhere"), h(InfoTip, { text: "Where the allowed contact is kept.", label: "About Also allow" })));
  await settle(3);
  const btn = p.root.querySelector(".info-tip-btn") as any, body = p.root.querySelector(".info-tip-body") as any;
  const enter = async () => { fire(btn, "mouseenter"); fire(btn, "MouseEnter"); await settle(2); };
  const leave = async (wait = 200) => { fire(btn, "mouseleave"); fire(btn, "MouseLeave"); await new Promise((r) => setTimeout(r, wait)); await settle(2); };
  const into = async (el: any) => { fire(el, "mouseenter"); fire(el, "MouseEnter"); await settle(2); };
  return { p, btn, body, enter, leave, into, open: () => !body.hidden };
}

describe("M-3443: the shared info icon", () => {
  it("a button named by its label, described by its words (always: a screen reader reads them on focus); closed at first", async () => {
    const t = await tip();
    expect([t.btn.tagName, t.btn.getAttribute("type"), t.btn.getAttribute("aria-label"), t.btn.getAttribute("aria-expanded")]).toEqual(["BUTTON", "button", "About Also allow", "false"]);
    expect([t.btn.getAttribute("aria-describedby"), t.body.getAttribute("role"), t.body.textContent]).toEqual([t.body.getAttribute("id"), "tooltip", "Where the allowed contact is kept."]);
    expect(t.open()).toBe(false);
  });
  it("focus opens it and blur closes it; a hover opens it and leaving closes it", async () => {
    const t = await tip();
    fire(t.btn, "focus", { bubbles: false }); await settle(2);
    expect([t.open(), t.btn.getAttribute("aria-expanded")]).toEqual([true, "true"]);
    fire(t.btn, "blur", { bubbles: false }); await settle(2);
    expect(t.open()).toBe(false);
    await t.enter(); expect(t.open()).toBe(true);
    await t.leave(); expect(t.open()).toBe(false);
  });
  it("#4274 review: the pointer crossing from the ⓘ into its bubble keeps it open; leaving both closes it a moment later", async () => {
    const t = await tip();
    await t.enter(); expect(t.open()).toBe(true);
    fire(t.btn, "mouseleave"); fire(t.btn, "MouseLeave");                 // into the gap…
    await t.into(t.body);                                                 // …and onto the bubble, within the wait
    await new Promise((r) => setTimeout(r, 300)); await settle(2);
    expect(t.open(), "still open over its bubble").toBe(true);
    fire(t.body, "mouseleave"); fire(t.body, "MouseLeave"); await settle(2);
    expect(t.open(), "not at once").toBe(true);
    await new Promise((r) => setTimeout(r, 250)); await settle(2);
    expect(t.open(), "a moment after leaving both").toBe(false);
  });
  it("#4274 review: a tip pinned by a tap closes and unpins when the focus leaves it — a later Esc elsewhere is not taken", async () => {
    const t = await tip();
    fire(t.btn, "focus", { bubbles: false }); fire(t.btn, "click"); await settle(2);
    await t.leave(); expect(t.open(), "pinned").toBe(true);
    fire(t.btn, "blur", { bubbles: false }); await settle(2);
    expect([t.open(), t.btn.getAttribute("aria-expanded")]).toEqual([false, "false"]);
    const esc = fire(t.p.document, "keydown", { key: "Escape" }); await settle(2);
    expect([esc.propagationStopped, esc.defaultPrevented], "the next Esc goes where it was meant").toEqual([false, false]);
  });
  it("a screen with no hover: a hover does nothing (a tap does it)", async () => {
    const t = await tip({ hover: false });
    await t.enter(); expect(t.open()).toBe(false);
  });
  it("a tap keeps it open (leaving keeps it); a second tap, Esc (stopped: not the dialog around it), a click elsewhere or a scroll closes it", async () => {
    const t = await tip();
    const click = fire(t.btn, "click"); await settle(2);
    expect([t.open(), click.defaultPrevented, click.propagationStopped], "a press never toggles a label's control or a row around it").toEqual([true, true, true]);
    await t.leave(); expect(t.open(), "pinned").toBe(true);
    fire(t.btn, "click"); await settle(2); expect(t.open(), "a second tap").toBe(false);
    fire(t.btn, "click"); await settle(2);
    const esc = fire(t.p.document, "keydown", { key: "Escape" }); await settle(2);
    expect([t.open(), esc.propagationStopped, esc.defaultPrevented], "a native <dialog> cancels on the default action").toEqual([false, true, true]);
    fire(t.btn, "click"); await settle(2);
    fire(t.p.root.querySelector("#elsewhere"), "click"); await settle(2);
    expect(t.open(), "a click elsewhere").toBe(false);
    fire(t.btn, "click"); await settle(2);
    fire(t.p.window, "scroll"); await settle(2);
    expect(t.open(), "a scroll").toBe(false);
  });
});

describe("M-3443: one component, accessible everywhere", () => {
  const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
  it("CSS: the --tap box on a touch screen (18px drawn), the bubble fixed to the window and hidden when closed", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.info-tip-btn \{ width: var\(--tap\); height: var\(--tap\); margin: calc\(\(18px - var\(--tap\)\) \/ 2\); \} \}/);
    expect(css).toMatch(/\.info-tip-body \{ position: fixed;/);
    expect(css).toMatch(/\.info-tip-body\[hidden\] \{ display: none; \}/);
  });
  it("no hover-only mark in src/ui: nothing with role=img listens to the pointer", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".js")) files.push(f); } };
    walk(join(process.cwd(), "src/ui"));
    const offenders = files.filter((f) => /<[a-z]+[^>]*role="img"[^>]*onMouse(Enter|Over)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("Settings' ⓘ and the usage dialog's are this component", () => {
    expect(readFileSync(join(process.cwd(), "src/ui/settings-shared.js"), "utf8")).toMatch(/import \{ InfoTip as SharedInfoTip \} from "\/assets\/info-tip\.js";/);
    expect(readFileSync(join(process.cwd(), "src/ui/shared/usage-dialog.js"), "utf8")).toMatch(/import \{ InfoTip \} from "\.\/info-tip\.js";/);
  });
});
