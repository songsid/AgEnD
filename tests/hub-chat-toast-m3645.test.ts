/**
 * M-3645: in a Hub chat the shared toast stood on the composer's Send (desk: the bottom-right corner) and on the thread's
 * first row (phone: under where a Fleet page's header ends). A Hub chat's composer owns the bottom and its thread starts
 * right under the chat's head, so the toasts stand in the head's band instead: one line for a confirmation, the newest
 * only, an error or a source's details in full. The real-app measurements (head, composer, Send, every row shown; desk and
 * phone, en and zh-TW) are scripts/manual/hub-chat-toast-m3645/capture.mts, with its receipt in
 * docs/evidence/hub-chat-toast-m3645/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "..", "src", "ui", "shared", "app.css"), "utf8");
const PHONE = "@media (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";

describe("a Hub chat's toasts (M-3645)", () => {
  it("stand in the chat head's band, desk and phone — not in a corner over Send, not under a Fleet header's height", () => {
    expect(CSS).toContain(".shell:has(.hub-chat-head) .toasts { top: var(--s-1); bottom: auto; }");
    expect(CSS).toContain(`${PHONE} { .shell:has(.hub-chat-head) .toasts { top: calc(env(safe-area-inset-top) + var(--s-3)); } }`);
    // The phone's own rule (under a Fleet page's header) comes first and is less specific: the Hub chat's rule wins there.
    expect(CSS.indexOf("  .toasts { top: calc(60px + env(safe-area-inset-top));")).toBeLessThan(CSS.indexOf(".shell:has(.hub-chat-head) .toasts {"));
  });

  it("a confirmation is one line and the newest only; an error or a source's details keep every line and stay", () => {
    expect(CSS).toContain(".shell:has(.hub-chat-head) .toasts > .toast.ok:not(.toast-detail) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }");
    expect(CSS).toContain(".shell:has(.hub-chat-head) .toasts > .toast.ok:not(.toast-detail):not(:last-child) { display: none; }");
    expect(CSS, "an error never gives way").not.toMatch(/\.hub-chat-head\) \.toasts > \.toast(\.err)?:not\(:last-child\)/);
  });

  it("a Fleet chat keeps its own place (under the header, alpha.2 sweep)", () => {
    expect(CSS).toContain(".shell:has(.p-chat) .toasts { top: calc(var(--header-h) + var(--s-2)); bottom: auto; }");
  });
});
