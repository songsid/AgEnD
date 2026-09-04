import { describe, it, expect } from "vitest";
import { truncatePreview, splitTextFenceAware } from "../src/channel/markdown-chunk.js";

/** Fences are balanced when an even number of ``` lines are present. */
function fenceLines(s: string): number {
  return s.split("\n").filter(l => /^\s{0,3}```/.test(l)).length;
}
/**
 * CommonMark-correct: a fence closes only on the same character, at least as
 * long, with no info string. Counting fence-shaped lines is wrong — a ```ts
 * line inside an open block is content, not a close.
 */
function balanced(s: string): boolean {
  let open: { char: string; len: number } | null = null;
  for (const line of s.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (open === null) {
      if (m[1][0] !== "`" || !m[2].includes("`")) open = { char: m[1][0], len: m[1].length };
    } else if (m[2].trim() === "" && m[1][0] === open.char && m[1].length >= open.len) {
      open = null;
    }
  }
  return open === null;
}

// The message shape that produced the user report: a code block starting right
// after the second sentence, so a 100-char preview lands inside the fence.
const REPORTED = [
  "我查到根因了。",
  "",
  "問題在這段程式碼，你看一下：",
  "",
  "```ts",
  "const chunks = splitText(text, chunkLimit);",
  "for (const chunk of chunks) await channel.send(chunk);",
  "const preview = message.slice(0, 100);",
  "```",
  "",
  "所以只要訊息含 code block 就會壞掉。",
].join("\n");

describe("truncatePreview", () => {
  it("closes a code fence that the cut landed inside (the reported bug)", () => {
    // Precondition: a naive slice really is unbalanced, so this test would fail
    // against the old `message.slice(0, 100)`.
    expect(balanced(REPORTED.slice(0, 100))).toBe(false);

    const preview = truncatePreview(REPORTED, 100);
    expect(balanced(preview)).toBe(true);
    expect(preview.endsWith("```")).toBe(true);
    expect(preview).toContain("…");
  });

  it("leaves short text untouched", () => {
    expect(truncatePreview("hi", 100)).toBe("hi");
  });

  it("does not add a fence when the cut is outside any block", () => {
    const plain = "a".repeat(200);
    const preview = truncatePreview(plain, 100);
    expect(preview).toBe("a".repeat(99) + "…");
    expect(preview.length).toBeLessThanOrEqual(100);
    expect(fenceLines(preview)).toBe(0);
  });

  it("closes a dangling inline-code backtick", () => {
    const t = "run `npm test -- --run` then `npm run build` and check the output carefully";
    const cut = t.slice(0, 30);
    expect((cut.match(/`/g) ?? []).length % 2).toBe(1); // naive slice dangles
    const preview = truncatePreview(t, 30);
    expect((preview.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it("charges the closing fence against the limit", () => {
    for (const limit of [40, 60, 100, 120]) {
      const preview = truncatePreview(REPORTED, limit);
      expect(preview.length, `limit ${limit} overflowed: ${preview.length}`).toBeLessThanOrEqual(limit);
      expect(balanced(preview), `limit ${limit} unbalanced`).toBe(true);
    }
  });

  it("never exceeds the limit for any cut point of a fenced message", () => {
    for (let limit = 10; limit <= REPORTED.length; limit++) {
      const preview = truncatePreview(REPORTED, limit);
      expect(preview.length, `limit ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("keeps a fully-contained block balanced", () => {
    const preview = truncatePreview(REPORTED, 1000);
    expect(preview).toBe(REPORTED);
    expect(balanced(preview)).toBe(true);
  });
});

describe("splitTextFenceAware", () => {
  it("balances fences in every chunk and reopens with the info string", () => {
    const code = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const text = `intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\noutro`;
    const chunks = splitTextFenceAware(text, 400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
      expect(balanced(c)).toBe(true);
    }
    // Continuation chunks reopen the block with its language.
    expect(chunks[1].startsWith("```ts")).toBe(true);
    // No code line is lost.
    for (let i = 0; i < 80; i++) expect(chunks.join("\n")).toContain(`const line${i} = ${i};`);
  });

  it("never exceeds the limit even when it must add fences", () => {
    const text = "```\n" + "x".repeat(5000) + "\n```";
    for (const c of splitTextFenceAware(text, 2000)) {
      expect(c.length).toBeLessThanOrEqual(2000);
      expect(balanced(c)).toBe(true);
    }
  });

  it("returns short text as a single chunk", () => {
    expect(splitTextFenceAware("hello", 2000)).toEqual(["hello"]);
    expect(splitTextFenceAware("", 2000)).toEqual([]);
  });

  it("falls back to fixed-width slices for fence-free text (legacy contract)", () => {
    // discord-reactions.test.ts drives sendText with chunkLimit 4.
    expect(splitTextFenceAware("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
  });

  it("does not throw when the limit is too small to hold a fence", () => {
    const fenced = "```ts\nconst a = 1;\n```";
    expect(() => splitTextFenceAware(fenced, 4)).not.toThrow();
    expect(splitTextFenceAware(fenced, 4).join("")).toBe(fenced);
  });

  it("preserves all non-fence content", () => {
    const text = "a\n".repeat(1500);
    const joined = splitTextFenceAware(text, 500).join("\n").replace(/```\w*\n?/g, "");
    expect(joined.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });
});

// ── Edge cases fable found by probing real inputs (PR #698 review) ──

describe("cuts never land inside a fence line", () => {
  const t = "intro line\n```ts\nconst a = 1;\nconst b = 2;\n```\ntail";

  it("does not leave half an opener as a stray inline code span", () => {
    for (let limit = 10; limit <= t.length; limit++) {
      const out = truncatePreview(t, limit);
      expect(out.length, `limit ${limit}`).toBeLessThanOrEqual(limit);
      // A partial opener used to surface as "``" or a truncated info string.
      expect(out, `limit ${limit}: ${JSON.stringify(out)}`).not.toMatch(/(^|\n) {0,3}`{1,2}(?!`)/);
      expect(balanced(out), `limit ${limit}: ${JSON.stringify(out)}`).toBe(true);
    }
  });

  it("never reopens with a truncated info string", () => {
    for (let limit = 10; limit <= t.length; limit++) {
      const out = truncatePreview(t, limit);
      for (const line of out.split("\n")) {
        const m = /^ {0,3}`{3,}(.+)$/.exec(line);
        if (m) expect(["ts"], `limit ${limit} got info ${m[1]}`).toContain(m[1].trim());
      }
    }
  });

  it("emits no empty code block when the cut lands just past an opener", () => {
    for (let limit = 10; limit <= t.length; limit++) {
      expect(truncatePreview(t, limit)).not.toMatch(/```ts\n…\n```/);
    }
  });
});

describe("a closer may not carry an info string (CommonMark)", () => {
  it("does not invert the trailing prose into a code block", () => {
    // "```ts" while a block is open is content, not a close.
    const t = "```ts\nline1\n```ts\nline2\n```\n\nrest " + "y".repeat(40);
    for (const c of splitTextFenceAware(t, 30)) {
      expect(balanced(c), `unbalanced: ${JSON.stringify(c)}`).toBe(true);
    }
    // The prose after the block must not end up inside a fence.
    const chunks = splitTextFenceAware(t, 30);
    const tail = chunks.find(c => c.includes("rest "));
    expect(tail).toBeDefined();
    expect(openFenceAt(tail!, tail!.indexOf("rest "))).toBe(false);
  });

  it("treats a nested ```js inside a ````markdown block as content", () => {
    const t = "````markdown\n# title\n```js\nx\n```\n````\ntail " + "z".repeat(60);
    const chunks = splitTextFenceAware(t, 40);
    for (const c of chunks) {
      expect(balanced(c), `unbalanced: ${JSON.stringify(c)}`).toBe(true);
      expect(c.length).toBeLessThanOrEqual(40);
    }
    // The four-backtick block must be closed by four backticks, not three.
    const first = chunks[0];
    expect(first.startsWith("````markdown")).toBe(true);
    expect(first.trimEnd().endsWith("````")).toBe(true);
  });

  it("supports ~~~ fences", () => {
    const t = "~~~ts\n" + "const a = 1;\n".repeat(10) + "~~~\ntail";
    for (const c of splitTextFenceAware(t, 60)) {
      expect(balanced(c), `unbalanced ~~~: ${JSON.stringify(c)}`).toBe(true);
    }
  });
});

/** True when index `i` of `s` sits inside an open fence. */
function openFenceAt(s: string, i: number): boolean {
  const before = s.slice(0, i);
  let open: string | null = null;
  for (const line of before.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[2].trim() === "" && m[1][0] === open[0] && m[1].length >= open.length) open = null;
  }
  return open !== null;
}

describe("property: truncation never emits unrenderable markdown", () => {
  const CORPUS = [
    "intro line\n```ts\nconst a = 1;\n```\ntail",
    "a\n```\nx\n```\nb",
    "hi\n``````ts\nzz\n``````\nend",
    "p\n~~~py\nq\n~~~\nr",
    "one\ntwo\n```js\nconst x = `t`;\n```\nthree",
    "````markdown\n# t\n```js\nx\n```\n````\ntail",
    "no fences here at all, just prose that goes on",
    "lead `inline` and a block\n```sh\ncmd --flag\n```\ntrail",
  ];

  it("keeps every cut point of every balanced input balanced and within budget", () => {
    for (const t of CORPUS) {
      expect(balanced(t), `corpus entry not balanced: ${JSON.stringify(t)}`).toBe(true);
      for (let limit = 1; limit <= t.length + 2; limit++) {
        const out = truncatePreview(t, limit);
        expect(out.length, `${JSON.stringify(t)} @ ${limit}`).toBeLessThanOrEqual(Math.max(limit, t.length));
        expect(balanced(out), `${JSON.stringify(t)} @ ${limit} -> ${JSON.stringify(out)}`).toBe(true);
      }
    }
  });

  it("falls back to the ellipsis when no cut can fit the budget", () => {
    // limit 1: any cut plus its ellipsis is already 2 chars, so the loop
    // exhausts and the safe fallback is what answers.
    expect(truncatePreview("abc", 1)).toBe("…");
    expect(truncatePreview("```ts\nx\n```", 1)).toBe("…");
  });

  it("says nothing rather than half a fence when the budget is tiny", () => {
    const out = truncatePreview("````markdown\n# t\n````", 5);
    expect(out).toBe("…");
    expect(balanced(out)).toBe(true);
  });
});
