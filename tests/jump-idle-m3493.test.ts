/**
 * M-3493 (and M-3492): 最新's fade after scrolling is one shared hook (src/ui/shared/jump-idle.js) used by the Fleet chat
 * and every Hub conversation. Driven here directly, on one component instance (which the Fleet chat panel never reuses
 * across chats, but a Hub thread or a pane may): shown → fades JUMP_IDLE_MS after the last scroll → the next scroll
 * wakes it; focused it stays; activated (gone, no blur) the next one still fades; another owner while shown arms anew;
 * hidden, no timer. Both panels wire the button to it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  const harness = await import("./helpers/app-harness.js");
  const p = harness.page({ storage: {} });
  pages.push(p);
  const { useJumpIdle, JUMP_IDLE_MS } = await import("/assets/jump-idle.js" as string);
  const { useRef, useState } = await import("/assets/app-html.js" as string);
  const h = harness.h;
  const api: { setShow?: (v: boolean) => void; setOwner?: (v: string) => void } = {};
  function Probe() {
    const sc = useRef(null);
    const [show, setShow] = useState(true), [owner, setOwner] = useState("a");
    api.setShow = setShow; api.setOwner = setOwner;
    const j = useJumpIdle(sc, show, owner);
    return h("div", { class: "scroller", ref: sc },
      show ? h("button", { type: "button", class: `jump-latest${j.idle ? " is-idle" : ""}`, ref: j.ref, onFocus: j.onFocus, onBlur: j.onBlur }) : null);
  }
  await p.mount(h(Probe, {}));
  await settle();
  const btn = () => p.root.querySelector(".jump-latest") as any;
  return { p, api, btn, idle: () => btn()?.classList.contains("is-idle") ?? null, scroll: () => fire(p.root.querySelector(".scroller"), "scroll"), JUMP_IDLE_MS: JUMP_IDLE_MS as number };
}

describe("useJumpIdle (shared by the Fleet chat and the Hub)", () => {
  it("fades after JUMP_IDLE_MS (2.5 s), wakes on scroll, stays while focused; an activated (gone, no blur) one or another owner while shown still fades", async () => {
    const t = await probe();
    expect(t.JUMP_IDLE_MS).toBe(2500);
    expect(t.idle(), "shown: visible").toBe(false);
    await wait(t.JUMP_IDLE_MS + 100); await settle();
    expect(t.idle(), "at rest: faded").toBe(true);
    t.scroll(); await settle();
    expect(t.idle(), "the next scroll wakes it").toBe(false);
    t.btn().focus(); fire(t.btn(), "focus");
    await wait(t.JUMP_IDLE_MS + 100); await settle();
    expect(t.idle(), "focused: stays").toBe(false);
    t.api.setShow!(false); await settle();                           // activated: gone without a blur
    t.api.setShow!(true); await settle();
    await wait(t.JUMP_IDLE_MS + 100); await settle();
    expect(t.idle(), "the next one fades").toBe(true);
    t.scroll(); await settle();
    t.api.setOwner!("b"); await settle();                            // another conversation, 最新 still up (shown → shown)
    await wait(t.JUMP_IDLE_MS + 100); await settle();
    expect(t.idle(), "another owner's fades with no scroll").toBe(true);
  }, 25_000);

  it("both panels wire 最新 to it (one behaviour, no second copy); the module is a public asset (the Hub serves /assets from that list)", () => {
    const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
    const button = /ref=\$\{jumpIdle\.ref\} class=\$\{`jump-latest\$\{jumpIdle\.idle \? " is-idle" : ""\}`\}[\s\S]{0,400}onFocus=\$\{jumpIdle\.onFocus\} onBlur=\$\{jumpIdle\.onBlur\}/;
    const chat = read("src", "ui", "panel-chat.js"), hub = read("src", "ui", "panel-hub.js");
    expect([/useJumpIdle\(scroller, jump\.show, name\)/.test(chat), button.test(chat), /useJumpIdle\(scroller, jump\.show, store\)/.test(hub), button.test(hub)]).toEqual([true, true, true, true]);
    expect([/setTimeout\([^)]*JUMP_IDLE_MS/.test(chat), /setTimeout\([^)]*JUMP_IDLE_MS/.test(hub)], "no second copy of the timer").toEqual([false, false]);
    expect(read("src", "auth-api.ts")).toMatch(/"jump-idle\.js",/);
  });
});
