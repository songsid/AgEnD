/**
 * M-3666 (the user approved the zh-TW glossary on 2026-11-24): the Chinese UI uses one word per concept — Agent for
 * an instance, 工作階段 for a session, 後端 for a backend, 上下文 for Context, 通道 for a tunnel, 主題 for a topic,
 * 窗格 for a pane, 人設 for a persona and the rest of docs/terminology.md. Config keys, slash commands, paths and
 * quoted protocol strings stay as they are.
 *
 * The check blocks only clear errors (the user's rule): 管理者 (M-2820: 管理員), the Japanese 覧 (覽) and the
 * simplified-form 占用 (佔用). English terms are not hard-blocked yet; the spot checks below pin the applied words.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", "dist", "fixtures"]);
function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|js|mjs|cjs|mts|md|mdx|html|json)$/.test(n)) out.push(p);
  }
  return out;
}
/** The clear errors: each with the word to write instead. */
export const ZH_CLEAR_ERRORS: ReadonlyArray<readonly [string, string]> = [["管理者", "管理員"], ["覧", "覽"], ["占用", "佔用"]];

/** Every hit as `path:line: word → fix`. Released notes (docs/CHANGELOG*) and evidence records (docs/evidence/, which quote the
 *  before values) are history; the glossary names the words it forbids. */
export function clearErrorHits(paths: string[], read: (p: string) => string = (p) => readFileSync(p, "utf8")): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = relative(ROOT, p).split("\\").join("/");
    if (/^docs\/CHANGELOG[^/]*\.md$/.test(rel) || rel.startsWith("docs/evidence/") || rel === "docs/terminology.md") continue;
    read(p).split("\n").forEach((line, i) => {
      for (const [bad, good] of ZH_CLEAR_ERRORS) if (line.includes(bad)) out.push(`${rel}:${i + 1}: ${bad} → ${good}`);
    });
  }
  return out;
}

describe("M-3666: the zh-TW clear-error check", () => {
  const scanned = () => ["src", "docs", "website/src", "scripts"].flatMap((d) => files(join(ROOT, d)));

  it("no source, doc, site page or script says 管理者, 覧 or 占用", () => {
    const all = scanned();
    expect(all.length).toBeGreaterThan(300);   // the walk reached the tree
    expect(clearErrorHits(all)).toEqual([]);
  });

  it("control: each clear error is caught on its line, and the right word is not", () => {
    const fake = { [join(ROOT, "src", "x.ts")]: "ok 管理員\n請聯絡管理者\n瀏覧器\n連接埠已被占用\n已被佔用 瀏覽器" };
    const hits = clearErrorHits(Object.keys(fake), (p) => fake[p]!);
    expect(hits).toEqual(["src/x.ts:2: 管理者 → 管理員", "src/x.ts:3: 覧 → 覽", "src/x.ts:4: 占用 → 佔用"]);
  });

  it("control: released notes, evidence records and the glossary itself are not scanned", () => {
    const fake = { [join(ROOT, "docs", "CHANGELOG.zh-TW.md")]: "占用", [join(ROOT, "docs", "terminology.md")]: "管理者",
      [join(ROOT, "docs", "evidence", "zh-tw-audit-m3663", "README.md")]: "瀏覧器", [join(ROOT, "docs", "evidence.md")]: "占用" };
    expect(clearErrorHits(Object.keys(fake), (p) => fake[p]!)).toEqual(["docs/evidence.md:1: 占用 → 佔用"]);
  });
});

describe("M-3666: the approved words, on the strings the audit found", () => {
  afterEach(async () => { (await import("../src/locale.js")).setLocale("en"); });

  it.each([
    ["clear.not_connected", [], "❌ Agent 未連線（IPC 無法連線）"],
    ["ctx.used", [42], "📊 上下文：42% 已用"],
    ["ctx.effort_configured", ["high"], "推理強度：high（設定值，之後可能在 CLI 內被改過）"],
    ["ctx.auto_pause_disabled", [], "自動暫停：已停用"],
    ["instance.not_found", ["dev"], "❌ 找不到 Agent：dev"],
    ["web_auth.refusal_not_admin_session", [], "它不是管理員的工作階段。"],
    ["dashboard.progress.tunnel", [], "啟動通道"],
    ["status.table_header", [], "| Agent | 後端 | 模型 | 上下文 | 推理強度 | 執行狀態 |"],
    ["exit.instance_notice", ["dev"], "🛑 dev 已停止（正常退出，結束碼 0）。管理員可至 General 重新啟動。"],
    ["delivery.not_found", [], "找不到這筆訊息的送達紀錄（Delivery not found）"],
    ["delivery.retention_expired", [], "找不到送達紀錄——此筆記錄早於保留期限，已被清除"],
  ] as const)("zh-TW %s", async (key, args, zh) => {
    const { setLocale, t } = await import("../src/locale.js");
    setLocale("zh-TW");
    expect(t(key, ...(args as unknown as string[]))).toBe(zh);
  });

  it("kept as they are: a Discord option name, a quoted CLI button, the protocol literal and the proxy word (815bfe4a forbids 代理)", async () => {
    const { setLocale, t } = await import("../src/locale.js");
    setLocale("zh-TW");
    expect(t("classic.backend_required")).toContain("`/start` 指令中選擇 `backend`");
    expect(t("inst.dialog_parked_hold_claude_resume")).toContain("「Resume full session as-is」");
    expect(t("delivery.forged_warning", "peer", "xmsg-1")).toMatch(/；Delivery not found$/);
    expect(t("dashboard.progress.fail.download-failed")).toContain("proxy");
    expect(t("setup.platform_general.skipped")).toContain("quickstart →「Add another platform」");   // quickstart prints it in English
  });

  it("the web UI: persona → 人設, team → 團隊, pane → 窗格, emoji and `workspaces` kept", () => {
    const read = (f: string) => readFileSync(join(ROOT, "src", "ui", f), "utf8");
    expect(read("shared/view-strings.js")).toContain("改顯示 Bot 的頭像、人設 emoji 或名稱第一個字。");
    expect(read("shared/view-strings.js")).toContain("⚠ 無法載入 {name} 的窗格（HTTP {status}）。");
    expect(read("panel-fleet.js")).toContain('newTeam: "新增團隊"');
    expect(read("settings-strings.js")).toContain("Agent 會在 AgEnD 的 `workspaces` 裡有自己的資料夾");
    expect(read("settings-strings.js")).toContain('statusEmojis: "狀態 emoji"');
  });
});
