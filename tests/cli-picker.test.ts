import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, CliPicker: any, cliLabel: (id: string) => string, Menu: any, useState: any;
const choices = [
  { value: "", label: "Use fleet default" },
  { value: "claude-code", label: "Claude Code", description: "Windows · signed in" },
  { value: "codex", label: "Codex", disabled: true },
  { value: "antigravity", label: "Antigravity" },
];
const trigger = () => p.root.querySelector(".cli-picker-trigger");
const radios = () => p.root.querySelectorAll('[role="menuitemradio"]');
beforeAll(async () => {
  p = page({ url: "http://localhost/ui", storage: { agend_lang: "en" } });
  ({ CliPicker, cliLabel } = await import("/ui/js/cli-picker.js"));
  ({ Menu } = await import("/assets/ui-menu.js"));
  ({ useState } = await import("/assets/app-html.js"));
});
afterEach(async () => { await p.unmount(); });
afterAll(() => p.restore());

describe("CLI product picker", () => {
  it("preserves caller labels, supplied choices and product icons including the empty fleet default", async () => {
    await p.mount(h(CliPicker, { value: "", onChange() {}, label: "Backend", choices }));
    expect(trigger().textContent).toBe("Use fleet default");
    expect(trigger().getAttribute("aria-label")).toBe("Backend: Use fleet default");
    expect(trigger().querySelector('[data-cli="default"] svg')).not.toBeNull();
    trigger().click(); await settle();
    expect(radios()).toHaveLength(choices.length);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    expect(radios()[1].textContent).toContain("Windows · signed in");
    expect(radios()[1].querySelector('[data-cli="claude-code"] svg').getAttribute("fill")).toBe("#D97757");
    expect(radios()[3].querySelector('[data-cli="antigravity"] img').getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("opens by keyboard, skips disabled choices and selects with Enter while preserving the field label", async () => {
    const changed = vi.fn();
    function Controlled() {
      const [value, setValue] = useState("");
      return h(CliPicker, { value, label: "Backend", choices, onChange(next: string) { changed(next); setValue(next); } });
    }
    await p.mount(h(Controlled, {}));
    trigger().focus(); fire(trigger(), "keydown", { key: "ArrowDown" }); await settle();
    expect(p.document.activeElement).toBe(radios()[0]);
    fire(p.document.activeElement, "keydown", { key: "ArrowDown" }); await settle();
    expect(p.document.activeElement).toBe(radios()[1]);
    fire(p.document.activeElement, "keydown", { key: "ArrowDown" }); await settle();
    expect(p.document.activeElement).toBe(radios()[3]);
    fire(p.document.activeElement, "keydown", { key: "Enter" }); await settle();
    expect(changed).toHaveBeenCalledExactlyOnceWith("antigravity");
    expect(p.root.querySelector('[role="menu"]')).toBeNull();
    expect(p.document.activeElement).toBe(trigger());
    expect(trigger().textContent).toBe("Antigravity");
    expect(trigger().getAttribute("aria-label")).toBe("Backend: Antigravity");
  });

  it("closes with Escape and restores focus without changing a value", async () => {
    const changed = vi.fn();
    await p.mount(h(CliPicker, { value: "claude-code", onChange: changed, label: "CLI", choices }));
    trigger().click(); await settle();
    const e = fire(p.document.activeElement, "keydown", { key: "Escape" }); await settle();
    expect(e.propagationStopped).toBe(true);
    expect(p.document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not select a disabled item or open a disabled picker", async () => {
    const changed = vi.fn();
    await p.mount(h(CliPicker, { value: "claude-code", onChange: changed, label: "CLI", choices }));
    trigger().click(); await settle();
    expect(radios()[2].disabled).toBe(true);
    radios()[2].click(); await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(p.root.querySelector('[role="menu"]')).not.toBeNull();
    await p.mount(h(CliPicker, { value: "claude-code", onChange: changed, label: "CLI", choices, disabled: true }));
    expect(trigger().disabled).toBe(true);
    expect(p.root.querySelector('[role="menu"]')).toBeNull();
    trigger().click(); fire(trigger(), "keydown", { key: "ArrowDown" }); await settle();
    expect(p.root.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps the original Menu icon button and actions when no custom trigger is supplied", async () => {
    const selected = vi.fn();
    await p.mount(h(Menu, { label: "Actions", items: [{ key: "one", label: "One", onSelect: selected }] }));
    const button = p.root.querySelector(".icon-btn");
    expect(button.getAttribute("aria-label")).toBe("Actions");
    expect(button.querySelector("svg")).not.toBeNull();
    button.click(); await settle();
    p.root.querySelector('[role="menuitem"]').click(); await settle();
    expect(selected).toHaveBeenCalledOnce();
  });

  it("uses canonical product labels and preserves unknown ids", () => {
    expect(cliLabel("claude-code")).toBe("Claude Code");
    expect(cliLabel("codex")).toBe("Codex");
    expect(cliLabel("kiro-cli")).toBe("Kiro");
    expect(cliLabel("custom-cli")).toBe("custom-cli");
  });
});
