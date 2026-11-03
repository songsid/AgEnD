import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, shortcuts: any, shell: any, useStore: any;
const previousFetch = globalThis.fetch;
const requests: Array<{ path: string; method: string }> = [];
let previousPlatform: unknown;

// The production shell's dialog store and the production Dialog render unchanged; no fleet/data lifecycle runs.
function ModalHost() {
  const { dialog } = useStore(shell.shellStore);
  return h("div", {}, h(shortcuts.ShortcutsHelpRow, {}), dialog ? h(dialog.Component, { ...dialog.props, onClose: shell.closeDialog }) : null);
}

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/preferences", storage: { agend_lang: "en" } });
  previousPlatform = navigator.platform;
  (globalThis as any).fetch = async (path: string, init: { method?: string } = {}) => {
    requests.push({ path, method: init.method || "GET" });
    return { ok: true, status: 200, json: async () => [] };
  };
  (await import("/assets/app-i18n.js")).setLang("en", { store: false });
  ({ useStore } = await import("/assets/app-store.js"));
  shell = await import("/assets/app-shell.js");
  shortcuts = await import("/ui/js/settings-shortcuts.js");
});

beforeEach(async () => {
  requests.length = 0;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  shell.closeDialog();
  await p.mount(h(ModalHost, {}));
});

afterEach(async () => { shell.closeDialog(); await p.unmount(); });
afterAll(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: previousPlatform });
  globalThis.fetch = previousFetch;
  p.restore();
});

const opener = () => p.root.querySelector("#keyboardShortcutsBtn") as any;
const dialog = () => p.root.querySelector("dialog") as any;
const open = async () => { opener().focus(); opener().click(); await settle(6); };
const keys = () => [...p.root.querySelectorAll(".settings-shortcut-keys kbd")].map((key: any) => key.textContent);

describe("Preferences keyboard-shortcut help", () => {
  it("opens the shared shell dialog from the real preference button, with the supported contexts and no requests", async () => {
    expect(dialog()).toBeNull();
    await open();
    expect(dialog()?.open).toBe(true);
    expect(dialog().getAttribute("aria-label")).toBe("Keyboard shortcuts");
    expect(p.root.querySelectorAll(".settings-shortcuts section")).toHaveLength(4);
    expect(keys()).toEqual(["Ctrl", "K", "Ctrl", "F", "Enter", "Shift", "Enter", "/"]);
    expect(dialog().textContent).toContain("Works in text fields too");
    expect(dialog().textContent).toContain("input method is composing");
    expect(dialog().textContent).toContain("On a touch screen, Enter adds a line");
    expect(requests).toEqual([]);
  });

  it("Close and native Escape cancellation both dismiss the help and restore the opener without writing", async () => {
    for (const how of ["close", "cancel"]) {
      const button = opener();
      await open();
      expect(dialog()?.open).toBe(true);
      if (how === "cancel") fire(dialog(), "cancel"); // Native Escape produces cancel; Dialog owns that behavior.
      else p.root.querySelector(".dlg-actions button").click();
      await settle(6);
      expect(dialog(), how).toBeNull();
      expect(p.document.activeElement, how).toBe(button);
    }
    expect(requests).toEqual([]);
  });

  it("labels the existing search shortcuts with Command on a Mac platform", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await open();
    expect(keys()).toEqual(["⌘", "K", "⌘", "F", "Enter", "Shift", "Enter", "/"]);
    expect(keys()).not.toContain("Ctrl");
    expect(requests).toEqual([]);
  });
});
