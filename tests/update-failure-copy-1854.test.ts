/** #1854 rank5: localized chat failure copy, with the existing updater/marker contracts. No process is spawned. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, type Locale } from "../src/locale.js";
import { beginUpdateProgress, readUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";
import { formatUpdateProgress } from "../src/update-progress.js";
import { openUpdateLog, updateFixHint, updateLogPath, watchUpdateLaunch } from "../src/update-launch.js";

let dir: string;
let priorLocale: Locale;
beforeEach(() => { priorLocale = getLocale(); dir = mkdtempSync(join(tmpdir(), "agend-1854-update-")); });
afterEach(() => { setLocale(priorLocale); rmSync(dir, { recursive: true, force: true }); });
const shell = (locale: Locale) => locale === "en" ? "Run `agend update` from a host shell." : "請在主機終端機執行 `agend update`。";
const childOf = (child: EventEmitter) => child as unknown as Pick<ChildProcess, "once">;

describe.each(["en", "zh-TW"] as const)("#1854 watcher in %s", locale => {
  it.each(["error", "signal", "exit", "no-status", "undefined-status"] as const)("%s has exact localized copy, once, without a raw spawn-error leak", event => {
    setLocale(locale);
    const child = new EventEmitter(), messages: string[] = [];
    watchUpdateLaunch(childOf(child), message => messages.push(message));
    if (event === "error") child.emit("error", Error("private manager detail"));
    else child.emit("exit", event === "exit" ? 7 : event === "undefined-status" ? undefined : null, event === "signal" ? "SIGTERM" : null);
    child.emit("exit", 1, null);
    const reason = locale === "en"
      ? event === "error" ? "updater launch failed" : event === "signal" ? "updater was interrupted" : event === "exit" ? "updater exited 7" : "updater exited without a status"
      : event === "error" ? "更新程序啟動失敗" : event === "signal" ? "更新程序遭中斷" : event === "exit" ? "更新程序以代碼 7 結束" : "更新程序未提供結束代碼";
    expect(messages).toEqual([`${shell(locale)} ${locale === "en" ? `/update could not complete (${reason}).` : `/update 未完成（${reason}）。`}`]);
    expect(messages[0]).not.toContain("private manager detail");
  });

  it.each([0, 75])("exit %i keeps the existing successful/pending handoff", code => {
    setLocale(locale);
    const child = new EventEmitter(), messages: string[] = [];
    watchUpdateLaunch(childOf(child), message => messages.push(message));
    child.emit("exit", code, null);
    expect(messages).toEqual([]);
  });

  it("keeps action/log evidence before a long masked cause through the real 300-character marker", () => {
    setLocale(locale);
    const path = updateLogPath(dir);
    writeFileSync(path, "npm error old-run-only\n");
    const log = openUpdateLog(path, "--- new run ---")!;
    const token = "ghp_" + "A".repeat(36);
    const raw = `npm error code EACCES\nnpm error ${token} ${"x".repeat(800)}\n`;
    writeFileSync(path, raw, { flag: "a" }); closeSync(log.fd);
    const target = { adapterId: "telegram-main", chatId: "group", threadId: "1", messageId: "progress" };
    beginUpdateProgress(dir, target, 1000);
    setUpdateProgressStage(dir, "downloading");
    const child = new EventEmitter(), messages: string[] = [];
    watchUpdateLaunch(childOf(child), message => { messages.push(message); setUpdateProgressStage(dir, "failed", { error: message }); }, path, log.offset);
    child.emit("exit", 1, null);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    const logLabel = locale === "en" ? `Full log: ${path}.` : `完整日誌：${path}。`;
    const causeLabel = locale === "en" ? "Cause: npm error code EACCES" : "原因：npm error code EACCES";
    expect(message.startsWith(shell(locale))).toBe(true);
    expect(message).toContain(logLabel);
    expect(message).toContain(causeLabel);
    expect(message.indexOf(logLabel)).toBeLessThan(message.indexOf(causeLabel));
    expect(message).not.toContain(token);
    expect(message).not.toContain("old-run-only");
    expect(readFileSync(path, "utf8")).toContain(raw); // full evidence stays on disk, not rewritten by formatting
    const marker = readUpdateProgress(dir)!;
    expect(marker.progress).toMatchObject({ stage: "failed", failedStage: "downloading", target });
    expect(marker.progress.error).toBe(message.replace(/\s+/g, " ").trim().slice(0, 300));
    expect(marker.progress.error).toHaveLength(300);
    expect(marker.progress.error).toContain(shell(locale));
    expect(marker.progress.error).toContain(logLabel);
    expect(formatUpdateProgress(marker, 4000)).toContain(locale === "en" ? "Update failed during download/install" : "更新在「下載／安裝」階段失敗");
  });

  it("localizes the ENOTEMPTY explanation without changing the validated repair command", () => {
    setLocale(locale);
    const staging = "/usr/lib/node_modules/@songsid/.agend-fixture";
    const output = `npm error code ENOTEMPTY\nnpm error dest ${staging}\n`;
    const command = `\`rm -rf '${staging}' && agend update\``;
    const explanation = locale === "en"
      ? `remove the directory an interrupted install left, then update again: ${command}`
      : `移除安裝中斷留下的目錄，再更新：${command}`;
    expect(updateFixHint(output)).toBe(explanation);
    expect(updateFixHint(output.replace(staging, "/usr/lib/node_modules/@other/.agend-fixture"))).toBeNull();
    const path = updateLogPath(dir), log = openUpdateLog(path, "--- run ---")!;
    writeFileSync(path, output, { flag: "a" }); closeSync(log.fd);
    const child = new EventEmitter(), messages: string[] = [];
    watchUpdateLaunch(childOf(child), message => messages.push(message), path, log.offset);
    child.emit("exit", 1, null);
    expect(messages[0]!.startsWith(locale === "en" ? `Fix: ${explanation}` : `修復方式：${explanation}`)).toBe(true);
    expect(messages[0]!.indexOf(command)).toBeLessThan(messages[0]!.indexOf(locale === "en" ? "Cause:" : "原因："));
  });
});
