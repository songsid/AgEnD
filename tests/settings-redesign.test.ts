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

  it("surfaces the ClassicBot access and editable channel workflow", () => {
    expect(html).toContain("Who can use ClassicBot");
    expect(html).toContain("Classic default backend");
    expect(html).toContain("/api/settings/classic/channels/");
  });
});
