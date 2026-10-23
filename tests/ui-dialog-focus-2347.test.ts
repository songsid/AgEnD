/**
 * #2347 follow-up: opening a dialog paints no focus ring. The browser's own first stop after showModal() is the ×
 * (WebKit draws its ring at once); the dialog's box takes that focus instead, so Tab reaches the × with the keyboard's
 * ring. A field the dialog focuses itself (autofocus) keeps it. mini-dom's showModal() moves no focus: here it does
 * what a browser does — the autofocus field if there is one, else the first button.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, D: any, proto: any, had: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/" });
  D = await import("/assets/ui-dialog.js");
  proto = Object.getPrototypeOf(p.window.document.createElement("dialog"));
  had = proto.showModal;
  proto.showModal = function (this: any) {
    had.call(this);
    const first = this.querySelector("[autofocus]") || this.querySelector("button");
    if (first) first.focus();
  };
});
afterEach(async () => { await p.unmount(); });

describe("a dialog's first focus", () => {
  it("is its box, not the × — the × is the next stop", async () => {
    await p.mount(h(D.Dialog, { title: "Agent", onClose: () => {} }, h("label", {}, "Name ", h("input", { id: "f" }))));
    await settle(2);
    const box = p.root.querySelector("dialog .dlg-box");
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(p.window.document.activeElement).toBe(box);
    expect(p.window.document.activeElement.classList.contains("dlg-x")).toBe(false);
  });

  it("a field the dialog focuses itself (autofocus) keeps it", async () => {
    await p.mount(h(D.Dialog, { title: "Agent", onClose: () => {} }, h("input", { id: "f", autofocus: true })));
    await settle(2);
    expect(p.window.document.activeElement?.id).toBe("f");
  });
});
