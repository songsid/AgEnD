/**
 * #3716: the web chat links a bare URL that follows a CJK character or full-width punctuation ("開好了：https://…"), as
 * Discord does, and ends it at the first CJK character or full-width punctuation ("https://x/y交給" links only https://x/y).
 * Everything else is unchanged: safeHref, the trailing ASCII trim, no links in code, [label](url). The real chat-render.js.
 */
import { beforeAll, describe, expect, it } from "vitest";

let R: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  R = (globalThis as any).AgendChatRender;
});
const U = "https://github.com/songsid/AgEnD/issues/3715";
const a = (href: string, label = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer" data-trust="link">${label}</a>`;
const md = (s: string) => R.renderMarkdown(s) as string;

describe("#3716: a bare URL after CJK text or full-width punctuation", () => {
  it.each([
    ["full-width colon", `開好了：${U}`, `開好了：${a(U)}`],
    ["full-width comma", `連結，${U}`, `連結，${a(U)}`],
    ["ideographic comma", `兩個、${U}`, `兩個、${a(U)}`],
    ["full-width parentheses", `（${U}）`, `（${a(U)}）`],
    ["corner brackets", `「${U}」`, `「${a(U)}」`],
    ["white corner brackets", `『${U}』`, `『${a(U)}』`],
    ["a CJK character", `看${U}`, `看${a(U)}`],
    ["kana", `こちら${U}`, `こちら${a(U)}`],
    ["Hangul", `여기${U}`, `여기${a(U)}`],
  ])("%s before it: linked", (_n, text, html) => {
    expect(md(text)).toBe(`<p>${html}</p>`);
  });
  it.each([
    ["Chinese text right after", `${U}交給你`, `${a(U)}交給你`],
    ["full-width period", `${U}。`, `${a(U)}。`],
    ["full-width exclamation", `${U}！好`, `${a(U)}！好`],
    ["ideographic full stop after an ASCII dot", `${U}.交給`, `${a(U)}.交給`],
    ["full-width question mark", `是${U}？`, `是${a(U)}？`],
  ])("it ends at the first CJK character or full-width punctuation (%s)", (_n, text, html) => {
    expect(md(text)).toBe(`<p>${html}</p>`);
  });
  it("a sentence with two links in Chinese", () => {
    expect(md(`PR：https://a.example/1，issue：https://b.example/2。`))
      .toBe(`<p>PR：${a("https://a.example/1")}，issue：${a("https://b.example/2")}。</p>`);
  });
});

describe("unchanged", () => {
  it("start of a line, after a space or (, the trailing ASCII trim", () => {
    expect(md(`${U}`)).toBe(`<p>${a(U)}</p>`);
    expect(md(`see ${U}.`)).toBe(`<p>see ${a(U)}.</p>`);
    expect(md(`(${U})`)).toBe(`<p>(${a(U)})</p>`);
    expect(md(`see ${U}, then`)).toBe(`<p>see ${a(U)}, then</p>`);
  });
  it("not after an ASCII letter or other text (a scheme inside a word stays text)", () => {
    expect(md(`x${U}`)).toBe(`<p>x${U}</p>`);
    expect(md(`a:${U}`)).toBe(`<p>a:${U}</p>`);
  });
  it("safeHref: no other scheme, no quotes", () => {
    expect(md(`：javascript:alert(1)`)).toBe(`<p>：javascript:alert(1)</p>`);
    expect(md(`：ftp://x.example/a`)).not.toContain("<a ");
    expect(md(`：https://x.example/"a`)).not.toContain('href="https://x.example/&quot;');
  });
  it("no links inside inline code or a code block, even after CJK punctuation", () => {
    expect(md("`：" + U + "`")).not.toContain("<a ");
    expect(md("```\n開好了：" + U + "\n```")).not.toContain("<a ");
  });
  it("[label](url), also after CJK punctuation", () => {
    expect(md(`見：[issue](${U})`)).toBe(`<p>見：${a(U, "issue")}</p>`);
    expect(md(`[說明](${U})。`)).toBe(`<p>${a(U, "說明")}。</p>`);
  });
});
