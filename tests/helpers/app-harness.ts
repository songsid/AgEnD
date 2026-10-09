/**
 * #1408: render the web app's components into tests/helpers/mini-dom.ts with the vendored Preact. Effects run on the
 * next macrotask (options.requestAnimationFrame), so `await settle()` after an action lets every effect run.
 */
import { installDom, settle, type MiniPage } from "./mini-dom.js";
import { options, render, h } from "/assets/preact.module.js";
import { confirmStore, answerConfirm } from "/assets/ui-confirm.js";

options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

/**
 * #1408 step 5: the app asks in its own dialog (ui-confirm.js), not the browser's confirm(). Tests written against
 * confirm() keep their meaning: while a test sets `globalThis.confirm` to a function, each question the app asks is
 * answered with it (the message, then its answer), exactly as confirm() was. A test that drives the dialog itself sets
 * `globalThis.confirm = undefined` and clicks the buttons (tests/web-confirm-1408.test.ts).
 */
confirmStore.subscribe((s: { queue: Array<{ id: number; message: string }> }) => {
  const head = s.queue[0];
  const answer = (globalThis as { confirm?: unknown }).confirm;
  if (head && typeof answer === "function") queueMicrotask(() => answerConfirm(head.id, !!(answer as (m: string) => unknown)(head.message)));
});

export { settle };
export interface AppPage extends MiniPage { root: any; mount(vnode: unknown): Promise<void>; unmount(): Promise<void> }

export function page(opts: Parameters<typeof installDom>[0] = {}): AppPage {
  const p = installDom(opts) as AppPage;
  p.root = p.document.createElement("div");
  p.root.id = "app";
  p.document.body.appendChild(p.root);
  p.mount = async (vnode) => { render(vnode, p.root); await settle(); };
  p.unmount = async () => { render(null, p.root); await settle(); };
  return p;
}
export { h };
