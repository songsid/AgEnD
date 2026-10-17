/** Real preview-slot ownership only. No component/paint or admission claim. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const panel = await import("/ui/js/preview-panel.js");
let stop: ReturnType<typeof vi.fn>;
beforeEach(() => { panel.closePanel(); stop = vi.fn(); vi.stubGlobal("AgendPreview", { stop }); });
afterEach(() => { panel.closePanel(); vi.unstubAllGlobals(); });
const html = (key = "html") => ({ key, instance: "own", msgKey: "message", n: 0, code: "<p>sample</p>" });
it("Trial takes the existing slot with no HTML run, and closes through its captured controller", () => {
  const trialStop = vi.fn(); panel.openPanel(html(), { run: true }); expect(panel.panelStore.get().run).toBeGreaterThan(0);
  panel.openTrialPanel({ key: "trial", instance: "own", handle: { stop: trialStop } });
  expect(stop).toHaveBeenCalledExactlyOnceWith("panel:html", "stopped", ""); expect(panel.panelStore.get().run).toBe(0);
  expect(panel.newerVersion(panel.panelStore.get().open, [], () => "")).toBeNull();
  panel.closePanel(); panel.closePanel(); expect(trialStop).toHaveBeenCalledOnce(); expect(panel.panelStore.get().open).toBeNull();
});
it("closing publishes empty before a Trial owner's reentrant HTML replacement", () => {
  const trialStop = vi.fn(() => { expect(panel.panelStore.get().open).toBeNull(); panel.openPanel(html("new")); });
  panel.openTrialPanel({ key: "trial", handle: { stop: trialStop } }); panel.closePanel();
  expect(trialStop).toHaveBeenCalledOnce(); expect(panel.panelStore.get().open?.key).toBe("new");
});
it("retiring a Trial observes the new HTML owner and never calls HTML stop", () => {
  const trialStop = vi.fn(() => { expect(panel.panelStore.get().open?.key).toBe("new"); });
  panel.openTrialPanel({ key: "trial", handle: { stop: trialStop } }); panel.openPanel(html("new"));
  expect(trialStop).toHaveBeenCalledOnce(); expect(panel.panelStore.get().open?.key).toBe("new"); expect(stop).not.toHaveBeenCalled();
});
it("opening a Trial publishes it before old HTML retirement reenters with a newer HTML owner", () => {
  panel.openPanel(html()); stop.mockImplementationOnce(() => { expect(panel.panelStore.get().open?.kind).toBe("trial"); panel.openPanel(html("new")); });
  const trialStop = vi.fn(); panel.openTrialPanel({ key: "trial", handle: { stop: trialStop } });
  expect(panel.panelStore.get().open?.key).toBe("new"); expect(trialStop).toHaveBeenCalledOnce();
});
it("a throwing retired controller cannot prevent the new HTML owner", () => {
  panel.openTrialPanel({ key: "trial", handle: { stop() { throw Error("old owner"); } } });
  expect(() => panel.openPanel(html("new"))).not.toThrow(); expect(panel.panelStore.get().open?.key).toBe("new");
});
