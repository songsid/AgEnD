/**
 * #2390 part 3: what a person reads in a terminal, in the fleet's language (defaults.locale, as the CLI has always
 * honoured it): restart / start / stop / update lines, `agend settings` (its source in words, its question), the
 * bug-report command's errors and review text, the service repair and leftover lines (restart, install, doctor), the
 * quickstart's service lines and import's path check. And the settings outcomes and labels part 1 left untested in zh.
 * English stays byte-for-byte what it was (the same tests that read these lines keep passing in English).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../src/locale.js";
import { settingsSourceLabel } from "../src/settings-confirmation.js";
import { approveDraft, reviewText, sinceMs } from "../src/bug-report.js";
import { notifyRepairLines, serviceLeftovers } from "../src/service-installer.js";

afterEach(() => setLocale("en"));
const src = (f: string) => readFileSync(join(process.cwd(), "src", f), "utf8");
const cjk = (s: string) => /[一-鿿]/.test(s);

describe("#2390 settings outcomes and labels (part 1 follow-up)", () => {
  it("every outcome, the decider labels and the source read in zh-TW; no outcome is English written in place", () => {
    setLocale("zh-TW");
    for (const k of ["applied", "apply_failed", "fleet_stopped", "expired", "withdrawn", "rejected", "request_no_longer_current", "settings_changed"]) {
      expect(cjk(t(`settings_confirm.result.${k}`)), k).toBe(true);
    }
    expect([t("settings_confirm.admin_label", "42"), t("settings_confirm.web_verified_label", "Ann"), t("settings_confirm.host_operator")])
      .toEqual(["fleet 管理員 42", "Ann（網頁驗證）", "主機操作者"]);
    expect([settingsSourceLabel("web_session"), settingsSourceLabel("public_link"), settingsSourceLabel("something_new")]).toEqual(["網頁儀表板", "公開連結", "something_new"]);
    expect(src("settings-confirmation.ts")).not.toMatch(/this\.finish\([^)]*"[A-Z][a-z]+ [a-z]/);
    expect(src("settings-control.ts")).toContain('label: t("settings_confirm.host_operator")');
    expect(src("fleet-manager.ts")).toContain('label: t("settings_confirm.web_verified_label", name)');
  });

  it("English reads as before", () => {
    expect([t("settings_confirm.admin_label", "42"), t("settings_confirm.web_verified_label", "Ann"), settingsSourceLabel("web_session")])
      .toEqual(["fleet admin 42", "Ann (web-verified)", "web dashboard"]);
  });

  it("`agend settings` prints the source in words and asks in the fleet's language", () => {
    const cli = src("cli.ts");
    expect(cli.match(/t\("settings_confirm\.source", settingsSourceLabel\(inspected\.pending_change\.source\)\)/g)).toHaveLength(2);
    expect(cli).toContain('input.question(t("settings_confirm.cli_question"))');
    setLocale("zh-TW");
    expect(t("settings_confirm.cli_question")).toBe("要套用這個變更嗎？[y/N] ");
  });
});

describe("#2390 the bug-report command", () => {
  it("its errors and its review text in zh-TW", () => {
    setLocale("zh-TW");
    expect(() => sinceMs("soon")).toThrow("--since 必須是像 30m、2h 或 1d 這樣的時間長度（最多 7d）");
    expect(() => approveDraft("{}", "0".repeat(64), "link")).toThrow("草稿已變更，或核准的摘要值不相符；請重新檢查並核准完全相同的草稿。");
    const text = reviewText({ delivery: "link", title: "T", body: "B", report: "R", overflow: true } as any);
    expect(text).toBe("傳送方式：link\nIssue 標題：\nT\n\nIssue 內文（原文）：\nB\n\n回報檔案（原文，請手動附加；內容過長時必須附加）：\nR\n");
  });

  it("in English, the review text is the same bytes as before", () => {
    expect(reviewText({ delivery: "gh", title: "T", body: "B", report: "R", overflow: false } as any))
      .toBe("Delivery: gh\nIssue title:\nT\n\nExact issue body:\nB\n\nExact report file (attach manually):\nR\n");
  });
});

describe("#2390 service lines (restart, install, doctor)", () => {
  it("the NotifyAccess repair and refusal, and a leftover's detail, in zh-TW", () => {
    setLocale("zh-TW");
    expect(notifyRepairLines({ kind: "repaired", path: "/u/zz.conf", from: "main", dropIns: ["/u/a.conf"] }, "agend.service", "systemctl daemon-reload"))
      .toEqual(["  ✓ /u/zz.conf：NotifyAccess=all —— systemd 先前載入的是 NotifyAccess=main（來自 /u/a.conf），它會拒絕 fleet 的就緒訊號，每 15 分鐘重新啟動一次（#2331）"]);
    const [refused] = notifyRepairLines({ kind: "refused", notifyAccess: "main", dropIns: [], detail: t("service.notify_still_set") }, "agend.service", "systemctl daemon-reload");
    expect(refused).toContain("AgEnD 自己的 drop-in 之後它仍然被設定");
    expect(refused).toContain("請刪除設定 NotifyAccess 的那一行，執行 `systemctl daemon-reload`，再執行 `agend restart`（#2331）。");
    const home = "/nonexistent-home-2390";
    expect(serviceLeftovers({ home, dropIns: [], systemUnit: null })).toEqual([]);
  });

  it("in English, the repair line is the same as before", () => {
    expect(notifyRepairLines({ kind: "repaired", path: "/u/zz.conf", from: "main", dropIns: [] }, "agend.service", "x"))
      .toEqual(["  ✓ /u/zz.conf: NotifyAccess=all — systemd had NotifyAccess=main loaded, which refuses the fleet's ready signal and restarts it every 15 minutes (#2331)"]);
  });
});

describe("#2390 CLI lines", () => {
  it("each line the audit found goes through t(), and reads in zh-TW", () => {
    const cli = src("cli.ts");
    for (const key of ["direct_refused", "fleet_restart_deprecated", "fleet_logs_removed", "system_install_kept", "no_own_installer", "install_activate_removed",
      "system_service_stopped", "system_service_stop_failed", "service_retry", "service_direct_hint", "service_redirect", "instance_restarted",
      "restart_failed", "fleet_unreachable", "force_whole_service", "unit_updated", "schedule_trigger_removed"]) {
      expect(cli, key).toContain(`t("cli.${key}"`);
      setLocale("zh-TW"); expect(cjk(t(`cli.${key}`, "x", "y")), key).toBe(true); setLocale("en");
    }
    expect(cli).not.toContain("Cannot connect to fleet (port ${port})");
  });

  it("the update line the updater parses stays English (update-launch reads its version from it)", () => {
    expect(src("cli.ts")).toContain("Updating AgEnD v${pkgVersion} → v${targetVersion} (its own installer)...");
    expect(src("update-launch.ts")).toContain("/Updating AgEnD v\\S+ → v(\\S+?)\\.\\.\\./");
  });
});
