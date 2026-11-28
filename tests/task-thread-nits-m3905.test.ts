/**
 * M-3905 (the user look at #4569's comment threads): the zh labels say 「新增反應」, 「不通知 Agent」 and 「建立卡片」; on a phone a
 * comment's head moves its time and tools to a second line rather than cutting a short name ("gene…"); a comment's words avoid
 * a last line of a character or two broken off (text-wrap pretty), breaking as the chat's messages do. Measured in Chromium at every phone width by
 * scripts/manual/task-thread-nits-m3905/capture.mts (docs/evidence/task-thread-nits-m3905).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(f, "utf8");
const PHONE = "(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";

describe("M-3905: task comment threads, zh wording and phone layout", () => {
  it("the zh labels: 新增反應, 不通知 Agent, 建立卡片 (EN unchanged)", () => {
    const thread = read("src/ui/fleet-task-thread.js"), card = read("src/ui/fleet-task-card.js");
    expect(thread).toContain('react: "新增反應"');
    expect(thread).toContain('toNobody: "不通知 Agent"');
    expect(thread).not.toMatch(/"加反應"|不通知 agent/);
    expect(card).toContain('evCreated: "建立卡片"');
    expect(card).not.toContain('"開卡"');
    expect(thread).toContain('react: "Add reaction"');
    expect(thread).toContain('toNobody: "No agent notified"');
    expect(card).toContain('evCreated: "opened it"');
  });
  it("on a phone a comment's head may wrap (the name first); a comment's words wrap pretty and keep zh words whole (M-3908)", () => {
    const css = read("src/ui/shared/task-board.css");
    expect(css).toContain(`@media ${PHONE} { .tl-comment > .tl-head { flex-wrap: wrap;`);
    // M-3908: keep-all as well (zh words whole), with text-wrap pretty.
    expect(css).toMatch(/\.tl-comment \.tl-body \{ word-break: keep-all; overflow-wrap: anywhere; text-wrap: pretty; \}/);
    // The desk keeps its one-line head.
    expect(css).toContain(".tl-comment > .tl-head { flex-wrap: nowrap; }");
  });
});
