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

  it("stages primary access mode and allowed users with lockout confirmations", () => {
    expect(html).toContain('const fAccessMode = select(originalPrimaryAccess.mode || "locked", ["locked", "open", "pairing"])');
    expect(html).toContain('mode: stagedAccessMode, allowed_users: stagedAllowedUsers');
    expect(html).toContain('confirmAccessChange(originalPrimaryAccess, stagedAccessMode, stagedAllowedUsers)');
    expect(html).toContain('if (change.confirm && !change.confirm())');
    expect(html).toContain('confirmOpenAccess: "Open access allows anyone in this channel to operate the bot. Continue?"');
    expect(html).toContain('accessLockedEmpty: "Locked mode has no allowed users; add at least one administrator to avoid lockout."');
  });

  it("shows shortened names plus effective model and effort for fleet and ClassicBot agents", () => {
    expect(html).toContain('name.replace(/-t\\d+$/, "")');
    expect(html).toContain('const summary = effectiveSummary(name, inst)');
    expect(html).toContain('const summary = effectiveSummary(c.instanceName, c, true)');
    expect(html).toContain('summary.model');
    expect(html).toContain('`effort: ${summary.effort}`');
    expect(html).toContain('model_display: i.model_display');
    expect(html).toContain('effort_supported: i.effort_supported');
  });

  it("localizes settings validation, confirmation, and apply feedback", () => {
    expect(html).toContain('noAgentMatch: "沒有符合「{0}」的 Agent。"');
    expect(html).toContain('configLoadFailed: "載入設定失敗 — 請檢查網址中的 token。"');
    expect(html).toContain('removeBot: "確定移除機器人「{0}」嗎？（.env 中的 token 會保留）"');
    expect(html).toContain('setValidation(fAutoPause, autoFeedback, !Number.isFinite(auto) || auto < 0 ? t("mustNonNegative") : "")');
    expect(html).toContain('showBanner(t("changesApplied"))');
    expect(html).toContain('confirm(tf("deleteAgent", name))');
  });
});
