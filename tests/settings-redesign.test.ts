import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/ui/settings.html", import.meta.url), "utf8");

describe("Settings P0 redesign shell", () => {
  it("provides remembered advanced controls and a developer YAML level", () => {
    expect(html).toContain('id="advancedToggle"');
    expect(html).toContain('localStorage.getItem("agend_settings_advanced")');
    expect(html).toContain("Developer · Level 3");
    expect(html).toContain("Developer YAML");
  });

  it("provides the global pending-change apply bar and human impact labels", () => {
    expect(html).toContain('id="pendingBar"');
    expect(html).toContain('id="applyChanges"');
    expect(html).toContain("changes not applied");
    expect(html).toContain("Restart this Agent");
    expect(html).toContain("Restart AgEnD");
  });

  it("stages tool-progress defaults and overrides, then requests a hot reload", () => {
    expect(html).toContain('select(inst.tool_progress || defaults.tool_progress || "off", ["off", "standard", "verbose"])');
    expect(html).toContain('select(d.tool_progress || "off", ["off", "standard", "verbose"])');
    expect(html).toContain('tool_progress: toolProgress.toggle.checked ? null : toolProgress.input.value');
    expect(html).toContain('tool_progress: fToolProgress.value');
    expect(html).toContain('const HOT_FIELDS = new Set(["tool_progress", "mcp_proxy_reply", "auto_pause_after", "warm_cap", "display_name", "description", "tags", "log_level"])');
    expect(html).toContain('impact: Object.keys(patch).every(key => HOT_FIELDS.has(key)) ? "now" : "instance"');
    expect(html).toContain('await api("/api/settings/reload", { method: "POST" })');
  });

  it("surfaces the ClassicBot access and editable channel workflow", () => {
    expect(html).toContain("Who can use ClassicBot");
    expect(html).toContain("Classic default backend");
    expect(html).toContain("/api/settings/classic/channels/");
  });
});
