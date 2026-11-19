/**
 * M-3387 (the user, beta.14): the switch-to-restricted confirm listed ~50 raw AgEnD tool names as what would stop. Now:
 * - every AgEnD MCP tool a restricted room loses (src/channel/mcp-tools.ts TOOLS outside CLASSIC_RESTRICTED_TOOLS) is in
 *   exactly ONE kind (src/ui/contact-tool-groups.js) — a new tool fails this file until it is put in one;
 * - the confirm says the kinds with counts, the AI tool's own tools (the backend's names, e.g. Bash) on their own line, and
 *   the two layers (AgEnD's tools go with the switch; the AI tool's own stop only where the command-line guard covers the
 *   room), then the not-covered sentence when it applies — en and zh-TW, verbatim;
 * - every name stays one click away: the dialog's "show all", closed until opened.
 */
import { afterEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../src/contact-auth-types.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } });
const LOST = TOOLS.map((t) => t.name).filter((n) => !CLASSIC_RESTRICTED_TOOLS.includes(n));

async function modules(lang: "en" | "zh-TW" = "en") {
  const p = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/classic-ops" }); pages.push(p);
  const i18n = await import("/assets/app-i18n.js" as string);
  i18n.setLang(lang, { store: false });
  const groups = await import("/ui/js/contact-tool-groups.js" as string);
  const perm = await import("/ui/js/contact-permissions.js" as string);
  const C = await import("/assets/ui-confirm.js" as string);
  return { p, i18n, groups, perm, C };
}

describe("M-3387: every AgEnD tool a restricted room loses is in exactly one kind", () => {
  it("TOOL_GROUPS covers the tools outside the restricted ceiling once each — none missing, none extra, none twice", async () => {
    const { groups } = await modules();
    const listed = groups.TOOL_GROUPS.flatMap((g: any) => g.tools);
    const twice = listed.filter((n: string, i: number) => listed.indexOf(n) !== i);
    expect(twice, "in two kinds").toEqual([]);
    expect(LOST.filter((n) => !listed.includes(n)), "an AgEnD tool in no kind: add it to src/ui/contact-tool-groups.js").toEqual([]);
    expect(listed.filter((n: string) => !LOST.includes(n)), "a name that is not a tool a restricted room loses").toEqual([]);
    expect(LOST.length).toBeGreaterThan(40);
  });
  it("a name it doesn't know is the AI tool's own (its layer), never counted as AgEnD's", async () => {
    const { groups } = await modules();
    const r = groups.groupWouldDisable(["Bash", "get_fleet_status", "hub_room_post", "mcp__drive__write", "Bash"]);
    expect([r.groups.map((g: any) => [g.id, g.tools]), r.cli, r.agendCount])
      .toEqual([[["fleet", ["get_fleet_status"]], ["hub", ["hub_room_post"]]], ["Bash", "mcp__drive__write"], 2]);
  });
});

describe("M-3387: the switch confirm's words", () => {
  const roomTools = { publicRead: true, allowedMcpTools: [], wouldDisable: [...LOST, "Bash"] };
  const guard = { state: "not-covered", backend: "codex" };
  it("en: the kinds with counts, the AI tool's own tools, the two layers, then the not-covered sentence", async () => {
    const { perm, groups } = await modules("en");
    const n = (id: string) => groups.TOOL_GROUPS.find((g: any) => g.id === id).tools.length;
    expect(perm.wouldDisableText(roomTools, guard)).toBe([
      [`AgEnD tools this room loses (${LOST.length}):`, `• Fleet status and settings (${n("fleet")})`, `• Creating, starting and stopping agents and teams (${n("agents")})`,
        `• Usage and logs (${n("usage")})`, `• Schedules (${n("schedules")})`, `• Task board and decisions (${n("tasks")})`, `• Appearance, office and emoji (${n("look")})`,
        `• Repositories and deployments (${n("repos")})`, `• Hub rooms (${n("hub")})`].join("\n"),
      "The AI tool's own tools (1): Bash",
      "Two layers: switching takes AgEnD's own tools away from this room. The AI tool's own tools (its shell, files, web) are stopped by the command-line guard, and only where the guard covers this room.",
      "This AI tool or version isn't covered by the guard: it runs with its normal permissions; only contact approval applies.",
    ].join("\n\n"));
    expect(perm.wouldDisableText(roomTools, guard)).not.toContain("office_pack_upload");
  });
  it("zh-TW: the same, in Traditional Chinese", async () => {
    const { perm, groups, i18n } = await modules("zh-TW");
    const n = (id: string) => groups.TOOL_GROUPS.find((g: any) => g.id === id).tools.length;
    try {
      expect(perm.wouldDisableText(roomTools, guard)).toBe([
        [`這個房間會失去的 AgEnD 工具（${LOST.length} 個）：`, `• Fleet 狀態與設定（${n("fleet")}）`, `• 建立、啟動與停止 Agent 和團隊（${n("agents")}）`, `• 用量與紀錄（${n("usage")}）`,
          `• 排程（${n("schedules")}）`, `• 任務板與決策（${n("tasks")}）`, `• 外觀、辦公室與表情（${n("look")}）`, `• 程式庫與部署（${n("repos")}）`, `• Hub 房間（${n("hub")}）`].join("\n"),
        "AI 工具本身的工具（1 個）：Bash",
        "分成兩層：切換後，這個房間會失去 AgEnD 自己的工具；AI 工具本身的工具（命令列、檔案、網路）則由命令列防護停用，而且只有在防護涵蓋這個房間時才會停用。",
        "這個 AI 工具或版本不在防護範圍內：它會以原本的權限執行，只有聯絡申請需要核准。",
      ].join("\n\n"));
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("show all: the dialog keeps every name behind a closed expander", async () => {
    const { p, perm, C } = await modules("en");
    (globalThis as any).confirm = undefined;                        // the dialog itself answers here
    await p.mount(h(C.ConfirmHost, {}));
    const answer = C.confirmDialog({ title: "Switch", message: perm.wouldDisableText(roomTools, guard), more: perm.wouldDisableMore(roomTools), confirmLabel: "Switch" });
    await settle(4);
    const more = p.root.querySelector("dialog details.confirm-more") as any;
    expect([(more?.querySelector("summary")?.textContent || "").trim(), more?.hasAttribute("open")]).toEqual([`Show all ${LOST.length + 1} tool names`, false]);
    expect(more.querySelectorAll("li").map((li: any) => li.textContent)).toEqual([...LOST, "Bash"]);
    p.root.querySelectorAll("dialog button").find((b: any) => b.textContent.trim() === "Cancel").click();
    expect(await answer).toBe(false);
  });
});
