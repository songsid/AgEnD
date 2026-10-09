/**
 * #1408 step 5: the app asks in its own dialog, never the browser's confirm()/alert().
 * - The dialog itself (the harness's confirm() bridge is off here): its words as text, its buttons, Esc / × as no,
 *   one question at a time in order, a dangerous action styled as one.
 * - The router: a guard that has to ask returns false at once and goes on with navigate(path, { force: true }).
 * - No module the app loads calls confirm(), alert() or prompt().
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let C: any, nav: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui" });
  C = await import("/assets/ui-confirm.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
});
afterAll(() => p.restore());
beforeEach(async () => {
  await p.unmount();
  (globalThis as any).confirm = undefined;                         // the dialog itself answers here
  await p.mount(h(C.ConfirmHost, {}));
});
const dialog = () => p.root.querySelector("dialog");
const button = (text: string) => p.root.querySelectorAll("dialog button").find((b: any) => b.textContent.trim() === text);

describe("the app's confirm dialog", () => {
  it("shows its words as text, paragraph by paragraph; the confirm button says what it does; it answers true", async () => {
    const answer = C.confirmDialog({ title: "Restart AgEnD", message: "Restart AgEnD now?\n\nEvery agent stops. <b>x</b>", confirmLabel: "Restart AgEnD", danger: true });
    await settle(4);
    expect(p.root.querySelector(".dlg-title").textContent).toBe("Restart AgEnD");
    expect(p.root.querySelectorAll(".confirm-text").map((e: any) => e.textContent)).toEqual(["Restart AgEnD now?", "Every agent stops. <b>x</b>"]);
    expect(p.root.querySelector(".confirm-text b")).toBeNull();
    expect(button("Restart AgEnD").className).toContain("btn-danger");
    button("Restart AgEnD").click();
    expect(await answer).toBe(true);
    await settle(4);
    expect(dialog()).toBeNull();
  });

  it("Cancel, ×, and Esc all answer no", async () => {
    for (const how of ["Cancel", "×", "Esc"]) {
      const answer = C.confirmDialog({ message: "Delete it?" });
      await settle(4);
      expect(p.root.querySelector(".dlg-title").textContent).toBe("Please confirm");
      expect(button("Continue").className).toContain("btn-primary");
      if (how === "Cancel") button("Cancel").click();
      else if (how === "×") p.root.querySelector("dialog .dlg-x").click();
      else fire(dialog(), "cancel");
      expect(await answer, how).toBe(false);
      await settle(4);
      expect(dialog(), how).toBeNull();
    }
  });

  it("one question at a time, in the order asked", async () => {
    const a = C.confirmDialog({ message: "First?" });
    const b = C.confirmDialog({ message: "Second?" });
    await settle(4);
    expect(p.root.querySelectorAll("dialog")).toHaveLength(1);
    expect(p.root.querySelector(".confirm-text").textContent).toBe("First?");
    button("Cancel").click(); await settle(4);
    expect(p.root.querySelector(".confirm-text").textContent).toBe("Second?");
    button("Continue").click();
    expect([await a, await b]).toEqual([false, true]);
  });
});

describe("the router waits for a guard that asks", () => {
  it("navigate is held, the address kept; on a yes the guard goes on past itself", async () => {
    nav.navigate("/settings");
    let asked = 0;
    const remove = nav.setLeaveGuard((route: any, path: string) => {
      if (route && route.panel === "settings") return true;
      asked++;
      C.confirmDialog({ message: "Discard 1 pending changes?" }).then((yes: boolean) => { if (yes) nav.navigate(path, { force: true }); });
      return false;
    });
    nav.navigate("/ui/fleet/teams");
    expect(nav.navStore.get().route.panel).toBe("settings");
    expect(p.window.location.pathname).toBe("/settings");
    await settle(4);
    button("Cancel").click(); await settle(4);
    expect(nav.navStore.get().route.panel).toBe("settings");
    nav.navigate("/ui/fleet/teams"); await settle(4);
    button("Continue").click(); await settle(4);
    expect(nav.navStore.get().route).toEqual({ panel: "fleet", tab: "teams" });
    expect(p.window.location.pathname).toBe("/ui/fleet/teams");
    expect(asked).toBe(2);
    remove();
  });
});

describe("no browser dialogs in the app", () => {
  it("no module the app loads calls confirm(), alert() or prompt()", () => {
    const ui = join(process.cwd(), "src", "ui");
    const files = [...readdirSync(ui).filter(f => f.endsWith(".js")).map(f => join(ui, f)),
      ...readdirSync(join(ui, "shared")).filter(f => f.endsWith(".js") && !f.endsWith(".module.js")).map(f => join(ui, "shared", f))];
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
      expect(src.match(/(?<![\w.$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/g) ?? [], f).toEqual([]);
    }
  });
});

describe("#1465 review: the test bridge answers each question once, in order", () => {
  it("two questions queued together: confirm() is asked A then B, and each gets its own answer", async () => {
    await p.unmount();
    const asked: string[] = [];
    const replies = [false, true];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return replies.shift(); };
    try {
      const a = C.confirmDialog({ message: "A?" });
      const b = C.confirmDialog({ message: "B?" });
      expect([await a, await b]).toEqual([false, true]);
      expect(asked).toEqual(["A?", "B?"]);
    } finally { (globalThis as any).confirm = undefined; }
  });
});
