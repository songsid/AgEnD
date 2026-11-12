/**
 * #3724: the working bar above the web chat composer keeps one height in every state, so a state change never moves the
 * conversation or the composer. The mini DOM has no layout, so this pins the contract the browser smoke
 * (scripts/manual/smoke/smoke-work-bar-height.mts) measures: the strip is always rendered (web-chat-c3: idle = an empty
 * `work-bar idle`), and its stylesheet gives it one fixed block size — desktop the Stop button's 30 px, phone / touch the
 * 44 px tap target — with the status text on one line. The rules live in chat-work-bar.css, the stylesheet panel-chat.js
 * links itself, so a tab whose older app.css is cached still gets them (upgrade skew).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/ui/shared/chat-work-bar.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string, within = css) => {
  const m = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m").exec(within);
  return m ? m[2]! : "";
};
const decl = (body: string, prop: string) => (new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1] ?? "").trim();

describe("#3724: the working bar's height is reserved", () => {
  it("desktop: one fixed block size (the Stop button's 30 px), contents clipped, never growing", () => {
    const bar = rule(".work-bar");
    expect([decl(bar, "block-size"), decl(bar, "min-block-size"), decl(bar, "max-block-size")]).toEqual(["30px", "30px", "30px"]);
    expect(decl(bar, "box-sizing")).toBe("border-box");
    expect(decl(bar, "overflow")).toBe("hidden");
  });
  it("phone / touch: the same three at the tap target (44 px), so the larger Stop fits and idle keeps the same height", () => {
    const media = /@media \(max-width: 899px\), \(pointer: coarse\) \{([^@]*?\.work-bar \{[^}]*\})\s*\}/m.exec(css)?.[1] ?? "";
    const bar = rule(".work-bar", media);
    expect([decl(bar, "block-size"), decl(bar, "min-block-size"), decl(bar, "max-block-size")]).toEqual(["var(--tap, 44px)", "var(--tap, 44px)", "var(--tap, 44px)"]);
  });
  it("the status text stays on one line (cut, not wrapped); the dot and the timer never shrink", () => {
    const lbl = rule(".work-bar .lbl");
    expect([decl(lbl, "white-space"), decl(lbl, "overflow"), decl(lbl, "text-overflow")]).toEqual(["nowrap", "hidden", "ellipsis"]);
    expect(decl(rule(".work-bar .elapsed, .work-bar .pulse"), "flex")).toBe("none");
  });
});
