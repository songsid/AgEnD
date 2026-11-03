import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, layout: any, html: any, useState: any;
beforeAll(async () => {
  p = page({ storage: { agend_lang: "en" } });
  layout = await import("/ui/js/settings-layout.js");
  ({ html, useState } = await import("/assets/app-html.js"));
});
afterEach(async () => { await p.unmount(); });
afterAll(() => { p.restore(); });

function Example() {
  const [tab, setTab] = layout.useSettingsTabs("access", "login");
  const [draft, setDraft] = useState("");
  return html`<form><${layout.SettingsTabs} id="access" value=${tab} onChange=${setTab} items=${[{ id: "login", label: "Sign-in" }, { id: "guests", label: "Guests" }, { id: "sharing", label: "Sharing" }]} />
    <${layout.SettingsTabPanel} group="access" id="login" active=${tab === "login"}><label for="session-draft">Session limit</label><input id="session-draft" value=${draft} onInput=${(event: any) => setDraft(event.target.value)} /></${layout.SettingsTabPanel}>
    <${layout.SettingsTabPanel} group="access" id="guests" active=${tab === "guests"}><input id="guest-target" /></${layout.SettingsTabPanel}>
    <${layout.SettingsTabPanel} group="access" id="sharing" active=${tab === "sharing"}><input id="sharing-target" /></${layout.SettingsTabPanel}>
  </form>`;
}
const selected = (id: string) => p.root.querySelector(`#access-tab-${id}`).getAttribute("aria-selected");
const hidden = (id: string) => p.root.querySelector(`#access-panel-${id}`).hasAttribute("hidden");

describe("Settings page tabs", () => {
  it("keeps an unsaved field mounted and unchanged while other groups are viewed", async () => {
    await p.mount(h(Example, {})); await settle(4);
    const field = p.root.querySelector("#session-draft");
    field.value = "36"; fire(field, "input"); await settle(3);
    p.root.querySelector("#access-tab-guests").click(); await settle(3);
    expect([selected("guests"), hidden("login"), hidden("guests")]).toEqual(["true", true, false]);
    p.root.querySelector("#access-tab-login").click(); await settle(3);
    expect(p.root.querySelector("#session-draft")).toBe(field);
    expect(field.value).toBe("36");
  });

  it("supports keyboard navigation and leaves only the active tab in the tab order", async () => {
    await p.mount(h(Example, {})); await settle(4);
    fire(p.root.querySelector("#access-tab-login"), "keydown", { key: "ArrowLeft" }); await settle(3);
    expect(selected("sharing")).toBe("true");
    expect(p.document.activeElement.id).toBe("access-tab-sharing");
    expect(p.root.querySelector("#access-tab-sharing").tabIndex).toBe(0);
    expect(p.root.querySelector("#access-tab-login").tabIndex).toBe(-1);
    fire(p.root.querySelector("#access-tab-sharing"), "keydown", { key: "Home" }); await settle(3);
    expect(selected("login")).toBe("true");
    expect(p.root.querySelectorAll('[role="tab"]').every((button: any) => button.type === "button")).toBe(true);
  });

  it("reveals the tab containing a search or validation target without resetting another draft", async () => {
    await p.mount(h(Example, {})); await settle(4);
    const field = p.root.querySelector("#session-draft"); field.value = "24"; fire(field, "input"); await settle(2);
    expect(layout.revealSettingsTarget(p.root.querySelector("#sharing-target"))).toBe(true); await settle(3);
    expect([selected("sharing"), hidden("sharing"), field.value]).toEqual(["true", false, "24"]);
    expect(layout.revealSettingsTarget(p.root.querySelector("#sharing-target"))).toBe(false);
  });

  it("removes its target-reveal subscription when the page is left", async () => {
    await p.mount(h(Example, {})); await settle(4);
    const target = p.root.querySelector("#guest-target");
    await p.unmount();
    expect(layout.revealSettingsTarget(target)).toBe(false);
  });
});
