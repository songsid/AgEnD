/**
 * The website's Engineering Notes / 技術日誌 section (the user's choice, 2026-10-20): Markdown posts under
 * website/src/content/notes/{en,zh-tw}/, an index (newest first) and a post page in both languages, and a nav and
 * footer entry on every page. Every post has a date, title, summary and tags; a translation shares its file name.
 * The rendered pages are checked by `astro build` in CI; this pins the wiring and each post's front matter.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SITE = join(import.meta.dirname, "..", "website");
const read = (p: string) => readFileSync(join(SITE, p), "utf8");
const posts = (locale: string) => {
  const dir = join(SITE, "src", "content", "notes", locale);
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")) : [];
};
function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split("\n").filter(l => /^\w+:/.test(l)).map(l => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

describe("Engineering Notes (website)", () => {
  it("the collection: posts in en/ and zh-tw/ with a date, title, summary and tags", () => {
    const config = read("src/content.config.ts");
    expect(config).toMatch(/notes: defineCollection\(\{\n\s*loader: glob\(\{ pattern: '\{en,zh-tw\}\/\*\.md', base: '\.\/src\/content\/notes' \}\)/);
    for (const field of ["title: z.string()", "date: z.coerce.date()", "summary: z.string()", "tags: z.array(z.string())"]) expect(config).toContain(field);
  });
  it("an index and a post page in each language", () => {
    for (const page of ["src/pages/notes/index.astro", "src/pages/notes/[slug].astro", "src/pages/zh-tw/notes/index.astro", "src/pages/zh-tw/notes/[slug].astro"]) {
      expect(existsSync(join(SITE, page)), page).toBe(true);
    }
    expect(read("src/components/NotesIndex.astro")).toMatch(/\.sort\(\(a, b\) => b\.data\.date\.getTime\(\) - a\.data\.date\.getTime\(\)\)/);
  });
  it("every page's nav and footer link to the section, in its language", () => {
    const base = read("src/layouts/Base.astro");
    expect(base).toContain("const notesHref = locale === 'en' ? `${base}/notes/` : `${base}/zh-tw/notes/`;");
    expect(base.match(/href=\{notesHref\}/g)).toHaveLength(2);
    expect(JSON.parse(read("src/i18n/en.json")).nav.notes).toBe("Engineering Notes");
    expect(JSON.parse(read("src/i18n/zh-tw.json")).nav.notes).toBe("技術日誌");
  });
  it("both languages have every notes string", () => {
    const en = JSON.parse(read("src/i18n/en.json")).notes, zh = JSON.parse(read("src/i18n/zh-tw.json")).notes;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
  it.each(["en", "zh-tw"])("each %s post has its front matter, and its translation shares its file name", (locale) => {
    const other = locale === "en" ? "zh-tw" : "en";
    for (const file of posts(locale)) {
      const fm = frontMatter(read(`src/content/notes/${locale}/${file}`));
      expect(fm.date, file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const key of ["title", "summary", "tags"]) expect(fm[key], `${file} ${key}`).toBeTruthy();
      expect(posts(other), `${file} has no ${other} translation`).toContain(file);
    }
  });
});
