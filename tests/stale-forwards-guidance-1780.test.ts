/**
 * #1780: an agent whose loaded `send_to_instance` schema predates `forwards` (a Claude Code session resumed across the
 * beta.7 upgrade keeps its first copy) wrote the verification id into the text instead — which grants nothing. Every
 * place that teaches forwarding names that failure and says to pass the parameter anyway.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("forwarding guidance names the stale-schema failure (#1780)", () => {
  it("cross-instance-messaging skill: the id goes in `forwards`, not the text; pass it even if the loaded schema lacks it", () => {
    const skill = read("src/general-knowledge/skills/cross-instance-messaging/SKILL.md");
    for (const s of ["The ID goes in the `forwards` parameter, never only in the message text", "\"Delivery not found\"",
      "has no `forwards`, pass it anyway", "keeps the tool copy it first loaded (reloading does not refresh it)", "AgEnD's server accepts the parameter"]) expect(skill, s).toContain(s);
  });
  it("worker-collaboration skill: relay with `forwards` even when the loaded copy lacks it", () => {
    expect(read("src/general-knowledge/skills/worker-collaboration/SKILL.md"))
      .toContain("put the ID in `forwards` (even if your loaded copy of the tool's schema lacks the parameter: the server accepts it), not in the text");
  });
  it("send_to_instance / delegate_task descriptions: an ID in the text grants nothing", () => {
    const description = (name: string) => TOOLS.find(t => t.name === name)!.description!;
    expect(description("send_to_instance")).toContain("an ID in the message text grants nothing");
    expect(description("delegate_task")).toContain("mentions grant nothing");
  });
  it("docs (EN + zh-TW) describe the failure and the remedy", () => {
    const en = read("docs/delivery-verification.md"), zh = read("docs/delivery-verification.zh-TW.md");
    for (const s of ["**The ID must be in `forwards`, not in the text.**", "Pass the parameter anyway", "#1780"]) expect(en, s).toContain(s);
    for (const s of ["**ID 必須放在 `forwards`，不是寫在文字裡。**", "照樣傳這個參數即可", "#1780"]) expect(zh, s).toContain(s);
  });
});
