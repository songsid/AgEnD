/**
 * #1700 follow-up: Preact sets a prop through the element's property when it has one, and `spellcheck` / `draggable`
 * are boolean properties — so spellcheck="false" in a template became `el.spellcheck = "false"` → true, and the
 * sidebar filter, the bot-token field, the fleet.yaml editor and the delete confirmation all rendered
 * spellcheck="true" (with Chrome's enhanced spell check, a shown bot token is text it may send off to check). They take
 * a boolean now. The mini DOM models these properties as a browser does (tests/helpers/mini-dom.ts), so the rendered
 * attribute is what a browser would show.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

describe("the rendered attribute", () => {
  it("the mini DOM is a browser here: a string 'false' through the property renders spellcheck=\"true\"", () => {
    const pg = page(); mounted.push(pg);
    const el = pg.document.createElement("input") as any;
    el.spellcheck = "false";
    const a = el.getAttribute("spellcheck");
    el.spellcheck = false;
    expect([a, el.getAttribute("spellcheck")]).toEqual(["true", "false"]);
  });

  it("the sidebar filter: spellcheck=\"false\"", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const { startRouter } = await import("/assets/app-nav.js");
    const { applyStatus } = await import("/assets/app-store.js");
    const { Shell } = await import("/assets/app-shell.js");
    startRouter(pg.window);
    applyStatus({ instances: [{ name: "alpha", status: "running", backend: "claude-code", tags: [], execution_state: "idle" }] });
    const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, name) });
    await pg.mount(h(Shell, { panels: new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]), onNewInstance() {} }));
    await settle(3);
    expect(pg.root.querySelector("#filterInput")!.getAttribute("spellcheck")).toBe("false");
  });

  it("the bot-token field: spellcheck=\"false\" hidden and shown", async () => {
    const pg = page(); mounted.push(pg);
    const { TokenField } = await import("/ui/js/settings-token.js");
    await pg.mount(h(TokenField, { id: "tok", platform: "discord", value: "x", onInput() {}, identity: null, busy: false, onVerify() {} }));
    const input = () => pg.root.querySelector("#tok") as any;
    const hidden = [input().getAttribute("type"), input().getAttribute("spellcheck")];
    (pg.root.querySelector(".token-row button") as any).click(); await settle();
    expect([hidden, [input().getAttribute("type"), input().getAttribute("spellcheck")]]).toEqual([["password", "false"], ["text", "false"]]);
  });
});

describe("every Preact template", () => {
  /** The web app's own modules (vendored libraries and Preact itself aside); static .html is parsed, not set by property. */
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "vendor" ? [] : files(p);
    return p.endsWith(".js") && !/preact|\.min\./.test(n) ? [p] : [];
  });
  it("gives spellcheck, draggable and translate a boolean, never a string", () => {
    const offenders: string[] = [];
    for (const f of files(join(__dirname, "../src/ui"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/\b(spellcheck|draggable|translate)(=["']|:\s*["'])/.test(line)) offenders.push(`${f.replace(/.*src\/ui\//, "")}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
