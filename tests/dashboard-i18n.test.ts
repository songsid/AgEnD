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
});
