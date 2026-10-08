/**
 * #1408: render the web app's components into tests/helpers/mini-dom.ts with the vendored Preact. Effects run on the
 * next macrotask (options.requestAnimationFrame), so `await settle()` after an action lets every effect run.
 */
import { installDom, settle, type MiniPage } from "./mini-dom.js";
import { options, render, h } from "/assets/preact.module.js";

options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

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
