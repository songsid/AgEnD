/**
 * #1773: a user's bubble hugs its text. The message (align-self: flex-end) is as wide as its widest child — usually the
 * meta row, now with times like 「昨天 下午03:58」 (#1770) — and a block body stretched to it, so 「目前進度」 sat in a
 * bubble twice its width. The body is fit-content, at most the message's width, pushed right under its meta; a long
 * message still wraps at the message's max-width (min(80%, 620px); 88% on a phone). Agent messages are untouched.
 * The layout itself is checked in a real browser (the PR's smoke, desktop and 390 px); here, the rules that make it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1]!.split(",").map(s => s.trim()), decl: m[2]! }));
const decl = (sel: string) => rules.filter(r => r.selectors.includes(sel)).map(r => r.decl).join(";");
const prop = (sel: string, name: string) => {
  const all = [...decl(sel).matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "g"))].map(m => m[1]!.trim());
  return all.at(-1) ?? null;
};

describe("#1773: the user's bubble hugs its text", () => {
  it("the body is as wide as its content, at most the message, on the right", () => {
    expect([prop(".msg.user .body", "width"), prop(".msg.user .body", "max-width"), prop(".msg.user .body", "margin-left")]).toEqual(["fit-content", "100%", "auto"]);
  });

  it("the message still caps the width a long one wraps at, and its meta stays right-aligned", () => {
    expect(decl(".msg.user")).toMatch(/(?:^|;)\s*max-width\s*:\s*min\(80%, 620px\)/);
    expect(prop(".msg.user", "align-self")).toBe("flex-end");
    expect(prop(".msg.user .meta", "justify-content")).toBe("flex-end");
    expect(css).toMatch(/@media \(max-width: 899px\)[\s\S]*?\.msg\.user \{ max-width: 88%; \}/);
  });

  it("agent messages and status lines get no such width", () => {
    for (const sel of [".msg.agent .body", ".msg .body", ".msg.agent", ".msg.status-line"]) expect(prop(sel, "width"), sel).toBeNull();
    expect(prop(".msg.agent", "align-self")).toBe("stretch");
  });
});
