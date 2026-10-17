/**
 * The realistic smoke fixture's data: about 60 instances with long Latin and long CJK (zh-TW) names, display names and
 * team names, mixed backends, a General, ClassicBot rooms, and text written to the product's caps. Demo content only;
 * nothing here is a real account, person or host. Used by every smoke through ./index.mts.
 */

export const BACKENDS = ["claude-code", "codex", "kiro-cli", "grok", "opencode", "antigravity", "muse"] as const;

/** A fleet instance as the fixture writes it into fleet.yaml. */
export interface FixtureInstance {
  name: string;
  backend: (typeof BACKENDS)[number];
  displayName?: string;
  description?: string;
  team?: string;
  general?: boolean;
  /** How the harness reports it (getInstanceStatus). */
  status?: "running" | "paused" | "stopped" | "crashed";
}

/** Team names: long Latin, long CJK, short, and one mixed with an emoji. */
export const TEAMS = [
  "Platform Infrastructure & Release Engineering",
  "研一官網前端重構與部署小組",
  "QA",
  "資料平台 Data Platform",
  "Research",
  "鬥破蒼穹手遊伺服器維運組",
  "Mobile Clients (iOS / Android)",
  "文件與教學",
] as const;

const LATIN = [
  "agend-leader-t1503382358143799511", "agend-dev-claude-t1519896892392083558", "agend-reviewer-t1503382598640996543",
  "rd1-platform-backend-sr4-server-t1547091841202130997", "awp-ota-frontend-release-candidate-t1505801094666915890",
  "doupo-manifests-asset-pipeline-t1503382011555872809", "web-claude", "sol", "fable", "qa-1",
  "infra-terraform-state-reconciler-weekly-audit", "nightly-benchmarks", "docs-site-builder", "mobile-ios-release-train",
  "mobile-android-crash-triage", "data-warehouse-dbt-models-and-freshness", "kiro-steering-experiments", "grok-scout",
  "codex-refactor-bot", "opencode-sandbox", "agy-design-review", "muse-writer", "release-notes-drafter",
  "security-dependency-review-and-cve-triage", "observability-dashboards", "billing-reconciliation", "search-indexer",
  "customer-support-macros", "localization-zh-tw-review", "a",
];
const CJK = [
  "研一官網-t1544335726169165914", "鬥破開發-opus-t1547168934623445013", "鬥破企劃", "己把鳩團區-grok-bot",
  "資料清洗與報表自動化助理", "客服知識庫維護", "研發週報彙整", "伺服器監控與告警分流", "美術資源命名檢查",
  "多語系翻譯校對（繁中）", "測試案例產生器", "需求訪談紀錄整理", "部署前檢查清單", "效能分析與火焰圖解讀",
  "資料庫遷移演練", "合約條款比對", "行銷文案草稿", "遊戲數值平衡試算", "玩家回饋分類", "排程與值班表",
];
const DISPLAY = [
  "平台基礎設施與發佈工程負責人（主要）", "Grok — answers in the Classic room", "研一官網前端重構與部署助理",
  "Release captain for the Android and iOS trains, weekly", "資料平台 dbt 模型新鮮度監控", "夜間效能基準測試",
  // Emoji sequences a font may draw unjoined (a family as three people, flags as letters): names must still fit.
  "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧 家庭群組", "🇹🇼🇯🇵🇺🇸🇰🇷🇹🇼🇯🇵 跨區值班", "👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽 review bot",
];

/** About 60 instances: one General, long names in both scripts, every backend, teams, a few odd states. */
export function fixtureInstances(): FixtureInstance[] {
  const out: FixtureInstance[] = [{ name: "general", backend: "claude-code", general: true, displayName: "General 總管", status: "running" }];
  const names = [...LATIN, ...CJK];
  names.forEach((name, i) => {
    out.push({
      name,
      backend: BACKENDS[i % BACKENDS.length],
      ...(i % 4 === 0 ? { displayName: `${DISPLAY[(i / 4) % DISPLAY.length]} ${i}` } : {}),
      ...(i % 3 !== 2 ? { team: TEAMS[i % TEAMS.length] } : {}),
      ...(i % 5 === 1 ? { description: TEXT.description } : {}),
      status: i === 7 ? "crashed" : i === 11 ? "stopped" : i === 13 ? "paused" : "running",
    });
  });
  while (out.length < 60) out.push({ name: `filler-${String(out.length).padStart(2, "0")}-${"x".repeat(out.length % 20)}`, backend: BACKENDS[out.length % BACKENDS.length], status: "running" });
  return out;
}

/** ClassicBot rooms (classicBot.yaml): long CJK and Latin room names, two bots in one room. */
export const CLASSIC_ROOMS = [
  { instanceName: "classic-己把鳩團區-5823-grok-bot", name: "己把鳩團區（玩家討論與活動公告）", channelId: "-1005823000001", backend: "grok" },
  { instanceName: "classic-己把鳩團區-5823-claude-bot", name: "己把鳩團區（玩家討論與活動公告）", channelId: "-1005823000001", backend: "claude-code" },
  { instanceName: "classic-鬥破企劃-7393", name: "鬥破企劃", channelId: "-1007393000002", backend: "claude-code" },
  { instanceName: "classic-customer-escalations-and-refund-requests-2291", name: "Customer escalations & refund requests", channelId: "-1002291000003", backend: "codex" },
];

/** Text at the product's caps (graphemes, line breaks), in zh-TW and English. */
export const TEXT = {
  /** 60 graphemes, one line (TAGLINE_MAX_GRAPHEMES). */
  taglineCjk: "負責平台基礎設施、發佈流程與夜間效能基準，也協助新成員熟悉部署前檢查清單與值班交接，有問題請直接在主題裡留言喔！",
  taglineLatin: "Keeps release trains on time, triages crashes, writes notes",
  /** 280 graphemes with 3 line breaks (BIO_MAX_GRAPHEMES / BIO_MAX_BREAKS). */
  bioCjk: [
    "我是研一官網前端重構與部署的助理，主要負責把設計稿轉成可重用的元件，並在每次發佈前跑完整的檢查清單。",
    "平常會整理每週的變更摘要、追蹤效能指標，也會在夜間基準測試結果異常時主動在主題裡回報，附上火焰圖與可能的原因。",
    "如果你需要我協助，請在訊息裡說清楚目標、期限與驗收方式；我會先回覆計畫，確認後才開始動手，避免做白工。",
    "注意：我不會直接推送到正式環境，所有變更都會先開 PR 並等待審查通過，謝謝大家的耐心與配合！",
  ].join("\n"),
  bioLatin: "Release captain for the mobile trains.\nI cut the branches, watch the crash dashboards, and write the changelog.\nAsk me for the status of any build, or why a test is flaky.\nI never push to production without a review.",
  description: "Long description used for the org chart and the details page: keeps the dbt models fresh, flags late sources, and posts a weekly summary to the team topic — 每週一早上九點彙整。",
  planName: "Team Premium (6.25x)",
  planNameLong: "Team Premium (6.25x) — 研發部門共用訂閱，含額外用量與優先支援",
  profileName: "Han 漢 — 平台工程 Platform Engineering",
  widgetLabels: ["今日完成的工作項目數量（含審查）", "Open pull requests waiting for review", "夜間基準：p95 延遲", "Build", "部署前檢查清單完成度"],
  widgetValues: ["12 / 15（80%）", "7 — oldest is 3 days", "182 ms（比上週快 12%）", "#4821 passed", "9 of 11 items checked"],
  chatCjk: "好的，我已經完成部署前檢查清單的前九項，剩下兩項需要你確認：\n1. 資料庫遷移腳本是否要在離峰時段執行？\n2. CDN 快取要不要在發佈後立刻清除？\n\n| 項目 | 狀態 | 負責人 |\n|---|---|---|\n| 單元測試 | ✅ 通過 | 研一官網-t1544335726169165914 |\n| 端對端測試 | ⏳ 進行中 | QA |\n\n請在今天下午五點前回覆，謝謝！",
  chatLatin: "Here is the summary of last night's benchmark run: p95 latency is **182 ms** (down 12% week over week), and the only regression is in `search-indexer`'s cold start. Full flame graph attached; the hot path is `buildIndex → tokenize → normalizeCjk`.",
};
