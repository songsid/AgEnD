import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, popup: any, app: any;
const savedAuth = (globalThis as any).AgendAuth;
beforeEach(async () => {
  p = page({ url: "https://fleet.example/ui/fleet/org" });
  app = await import("/assets/app-store.js");
  popup = await import("/ui/js/chat-popout.js");
  p.document.body.dataset.tier = "admin";
  p.document.body.dataset.chatWorkspace = "1";
  p.document.body.dataset.chatLayoutScope = "example-scope";
  (globalThis as any).AgendAuth = { sessionEnded: () => false };
  app.appStore.set({ ready: true, instances: [{ name: "example-agent" }] });
});
afterEach(() => { p.restore(); vi.unstubAllGlobals();
  if (savedAuth === undefined) delete (globalThis as any).AgendAuth; else (globalThis as any).AgendAuth = savedAuth;
});
describe("M-3464 fresh Office chat window", () => {
  it("opens a fresh chat synchronously without navigating Office, sending content or transferring/clearing drafts", () => {
    const child = { opener: p.window }, open = vi.fn(() => child);
    const win = { open };
    const notify = vi.fn();
    expect(popup.openOfficeChatWindow("example-agent", { win, notify })).toBe(true);
    expect(open).toHaveBeenCalledWith("/ui/chat/example-agent?presentation=popout", "_blank", "popup,width=760,height=800");
    expect(child.opener).toBeNull();
    expect(p.window.location.pathname).toBe("/ui/fleet/org");
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(["guest", "share", "ended", "not-ready", "hidden", "invalid"])("refuses %s before opening any window", reason => {
    if (reason === "guest") p.document.body.dataset.tier = "guest";
    if (reason === "share") { delete p.document.body.dataset.chatWorkspace; delete p.document.body.dataset.chatLayoutScope; }
    if (reason === "ended") (globalThis as any).AgendAuth.sessionEnded = () => true;
    if (reason === "not-ready") app.appStore.set({ ready: false });
    if (reason === "hidden") app.appStore.set({ instances: [] });
    const open = vi.fn();
    expect(popup.openOfficeChatWindow(reason === "invalid" ? "../other" : "example-agent", { win: { open }, notify: vi.fn() })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["null", "throws"])("a blocked popup (%s) keeps Office and its draft owner", reason => {
    const open = vi.fn(() => { if (reason === "throws") throw new Error("blocked"); return null; });
    const notify = vi.fn();
    expect(popup.openOfficeChatWindow("example-agent", { win: { open }, notify })).toBe(false);
    expect(notify).toHaveBeenCalledWith("blocked");
    expect(p.window.location.pathname).toBe("/ui/fleet/org");
  });
});


describe("painted Office bubble targets", () => {
  it("uses paint order, exact edges, and nearest 44px touch target", async () => {
    const { officeBubbleAt } = await import("/ui/js/fleet-office.js");
    const one = { name: "one", box: { x: 10, y: 10, w: 20, h: 19 } };
    const two = { name: "two", box: { x: 25, y: 10, w: 20, h: 19 } };
    expect(officeBubbleAt([one, two], 26, 20)).toBe(two);
    expect(officeBubbleAt([one, two], 20, 35)).toBeNull();
    expect(officeBubbleAt([one, two], 20, 35, 44)).toBe(one);
    expect(officeBubbleAt([one, two], 37, 35, 44)).toBe(two);
    expect(officeBubbleAt([], 20, 20, 44)).toBeNull();
    expect(officeBubbleAt([one], 100, 100, 44)).toBeNull();
  });
});
