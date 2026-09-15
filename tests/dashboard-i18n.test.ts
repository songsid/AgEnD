import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/ui/dashboard.html", import.meta.url), "utf8");

describe("dashboard zh-TW feedback", () => {
  it("localizes errors, confirmations, empty states, and operation feedback", () => {
    expect(html).toContain('const UI_LANG = localStorage.getItem("agend_lang")');
    expect(html).toContain('disconnected: "已斷線"');
    expect(html).toContain('topicRequired: "Directory 留空時必須填寫 Topic Name"');
    expect(html).toContain('deleteSchedule: "確定刪除此排程嗎？"');
    expect(html).toContain('teamFieldsRequired: "必須填寫名稱並選擇至少一名成員"');
    expect(html).toContain('toast(tr("scheduleCreated"))');
    expect(html).toContain('confirm(trf("deleteTeam", name))');
    expect(html).toContain('${tr("loadFailed")}');
  });

  // R2b: sidebar tooltip effort_source must always show label for consistency
  it("sidebar tooltip always shows effort_source label including instance (R2 regression)", () => {
    // The effortPart must show sourceLabel for all sources, not skip instance
    // Pattern: i.effort_source ? ` (${sourceLabel(i.effort_source)})` : ""
    // Must NOT have the old condition that skips instance: i.effort_source !== "instance"
    expect(html).toMatch(/effortPart.*i\.effort_source \? .*sourceLabel\(i\.effort_source\)/);
    expect(html).not.toMatch(/effortPart.*i\.effort_source !== "instance"/);
  });

  // Fix-forward: cli-default/unresolved must not append source suffix (resolved.display already explains)
  it("modelPart skips source suffix for cli-default and unresolved (tooltip consistency)", () => {
    // modelPart must check cli-default/unresolved alongside live for no-suffix
    expect(html).toMatch(/modelPart.*model_source === "cli-default"/);
    expect(html).toMatch(/modelPart.*model_source === "unresolved"/);
    // Must NOT have the old pattern that only checks live
    expect(html).not.toMatch(/modelPart.*model_source === "live" \? i\.model : `\$\{i\.model\}/);
  });
});
