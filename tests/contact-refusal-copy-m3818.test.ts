/**
 * M-3818: the refusal for an agent whose retained history has several known people (contact.refusedEarlier) names the way
 * out the way the unknown-origin refusal does: Clear retained origin, on the holding agent's own Permissions page (the
 * 11-26 confusion looked for it on the forwarding room's page instead).
 */
import { describe, expect, it } from "vitest";
import { tForLocale } from "../src/locale.js";

describe("contact.refusedEarlier names the clear path", () => {
  it("en", () => {
    const text = tForLocale("en", "contact.refusedEarlier");
    expect(text).toContain("on this agent's own page: Settings → Permissions → Clear retained origin");
    expect(text).toContain("not a room's page that forwarded to it");
    expect(text).toContain("Do not resend");
  });
  it("zh-TW", () => {
    const text = tForLocale("zh-TW", "contact.refusedEarlier");
    expect(text).toContain("這個 Agent 自己的「設定」→「權限」→「清除保留的來源」");
    expect(text).toContain("不是轉交給它的房間頁面");
    expect(text).toContain("請勿重送");
  });
  it("the unknown-origin refusal still names it too", () => {
    expect(tForLocale("en", "contact.refusedUnknown")).toContain("Permissions → Clear retained origin");
  });
});
