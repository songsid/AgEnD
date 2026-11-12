/**
 * #3727, Prism on #3735: split chat's 「引用到 B」 puts the annotated PNG and its quote line into the other pane under ONE
 * live check — the Workspace target's insert(text, commit): the quote goes in, then (the same turn, the same fence) the
 * commit adds the attachment, and it answers true. A pane replaced meanwhile, a session retired while the Chat mount is
 * awaited, a mount that never gets ready, or a quote the composer refuses: neither the text nor the file, and false (the
 * editor stays open). The real chat-workspace.js on the app harness; the chat's composer is a recorded stub.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, nav: any, entry: any;
let composerReady = true, accept = true;
const insert = vi.fn(() => accept);
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" }); (p.window as any).innerWidth = 1400;
  nav = await import("/assets/app-nav.js"); nav.startRouter(p.window);
  const m = await import("/ui/js/chat-workspace.js") as any;
  entry = m.installWorkspaceEntry({ nav, ready: () => Promise.resolve(), chat: { paneComposerReady: () => composerReady, insertPaneQuote: insert } });
  await entry.open("beta");
});
afterAll(async () => { (await import("/assets/app-store.js") as any).appStore.get().chatWorkspaceSessionEnd?.(); p.restore(); });

describe("the other pane gets the picture and its quote together, or neither", () => {
  it("unchanged target: the quote, then the commit (the attachment), and true; the target names the pane", async () => {
    composerReady = true; accept = true; insert.mockClear();
    const order: string[] = [];
    insert.mockImplementationOnce(() => { order.push("quote"); return true; });
    const target = entry.quoteTargets("alpha")[0];
    expect(target.name).toBe("beta");
    expect(await target.insert("Here is the screen", () => order.push("file"))).toBe(true);
    expect(order).toEqual(["quote", "file"]);
  });
  it("the pane replaced meanwhile (B → C): no quote, no file, false", async () => {
    composerReady = false; insert.mockClear();
    const commit = vi.fn();
    const target = entry.quoteTargets("alpha")[0], pending = target.insert("Here is the screen", commit);
    nav.navigate("/ui/chat/gamma");                                         // the other pane now shows another agent
    expect(await pending).toBe(false);
    expect([insert.mock.calls.length, commit.mock.calls.length]).toEqual([0, 0]);
    composerReady = true;
  });
  it("the composer refuses the quote: no file, false", async () => {
    composerReady = true; accept = false; insert.mockClear();
    const commit = vi.fn();
    const target = entry.quoteTargets("alpha")[0];
    expect(await target.insert("Here is the screen", commit)).toBe(false);
    expect([insert.mock.calls.length, commit.mock.calls.length]).toEqual([1, 0]);
    accept = true;
  });
  it("the Chat mount never gets ready (2 s): no quote, no file, false", async () => {
    composerReady = false; insert.mockClear();
    const commit = vi.fn();
    const target = entry.quoteTargets("alpha")[0];
    expect(await target.insert("Here is the screen", commit)).toBe(false);
    expect([insert.mock.calls.length, commit.mock.calls.length]).toEqual([0, 0]);
    composerReady = true;
  }, 10_000);
  it("the session retired while the mount is awaited: no quote, no file, false", async () => {
    composerReady = false; insert.mockClear();
    const commit = vi.fn();
    const target = entry.quoteTargets("alpha")[0], pending = target.insert("Here is the screen", commit);
    (await import("/assets/app-store.js") as any).appStore.get().chatWorkspaceSessionEnd();
    composerReady = true;
    expect(await pending).toBe(false);
    expect([insert.mock.calls.length, commit.mock.calls.length]).toEqual([0, 0]);
  });
});
