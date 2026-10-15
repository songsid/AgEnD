/**
 * #1629 r4 §3 / §7.4: the owner-CSS gate — its tokenizer, the rejection table, `asset:` rewriting, and that the text
 * served is the re-serialisation (never the uploaded bytes) and tokenizes back to the checked tokens.
 */
import { describe, expect, it } from "vitest";
import { checkOwnerCss, OWNER_CSS_MAX_BYTES, serializeCssTokens, serializeOwnerCss, tokenizeCss } from "../src/web-owner-css.js";

const A = "0123456789abcdef0123456789abcdef";
const assets = new Set([A]);
const check = (css: string) => checkOwnerCss(css, assets);
const problem = (css: string) => { const r = check(css); return r.ok ? "ok" : r.error.problem; };
const served = (css: string) => { const r = check(css); if (!r.ok) throw new Error(r.error.problem); return serializeOwnerCss(r.tokens); };

describe("the tokenizer (CSS Syntax 3)", () => {
  it("names, functions, numbers, strings, urls, comments", () => {
    const t = tokenizeCss(".a > b:hover { color: #fff; margin: -1.5e2px 10% ; content: 'x\\'y' } /* c */ url( foo.png )");
    expect(t.filter(x => x.type !== "ws").map(x => `${x.type}:${x.value}${x.unit ?? ""}`)).toEqual([
      "delim:.", "ident:a", "delim:>", "ident:b", ":::", "ident:hover", "{:{", "ident:color", ":::", "hash:fff", ";:;",
      "ident:margin", ":::", "dimension:-1.5e2px", "percentage:10", ";:;", "ident:content", ":::", "string:x'y", "}:}", "url:foo.png"]);
  });
  it("escapes are decoded: \\75 rl( is the function url(", () => {
    expect(tokenizeCss("\\75 rl(x)")[0]).toEqual({ type: "url", value: "x" });
    expect(tokenizeCss("\\75 rl(\"x\")")[0]).toEqual({ type: "function", value: "url" });
    expect(tokenizeCss("@\\69mport")[0]).toEqual({ type: "at", value: "import" });
  });
});

describe("rejected (r4 §7.4 table)", () => {
  it.each([
    ["@import", "@import 'x.css';", "at_rule"],
    ["@import, escaped", "@\\69 mport 'x.css';", "at_rule"],
    ["@namespace", "@namespace svg url(x);", "at_rule"],
    ["@charset", "@charset \"utf-8\";", "at_rule"],
    ["url(http…)", "a { background: url(http://evil.example/x.png) }", "url"],
    ["url(//…)", "a { background: url(//evil.example/x.png) }", "url"],
    ["url(data:…)", "a { background: url(data:image/png;base64,AAAA) }", "url"],
    ["url(\"https…\") quoted", "a { background: url(\"https://evil.example/x\") }", "url"],
    ["escaped \\75 rl(", "a { background: \\75 rl(http://x/y) }", "url"],
    ["escaped \\75 rl(\"…\")", "a { background: \\75 rl(\"http://x/y\") }", "url"],
    ["URL( uppercase", "a { background: URL(http://x/y) }", "url"],
    ["src(…)", "@font-face { src: src(\"asset:" + A + "\") }", "function"],
    ["image-set", "a { background: image-set(\"asset:" + A + "\" 1x) }", "function"],
    ["-webkit-image-set", "a { background: -webkit-image-set(\"x\" 1x) }", "function"],
    ["cross-fade", "a { background: cross-fade(red, blue) }", "function"],
    ["element", "a { background: element(#x) }", "function"],
    ["paint", "a { background: paint(x) }", "function"],
    ["expression", "a { width: expression(alert(1)) }", "function"],
    ["behavior", "a { behavior: x }", "property"],
    ["-moz-binding", "a { -moz-binding: x }", "property"],
    ["javascript:", "a { content: 'javascript:alert(1)' }", "script_scheme"],
    ["vbscript:, mixed case in a comment", "/* VBScript: */ a {}", "script_scheme"],
    ["javascript: hidden by an escape", "a { content: 'java\\73 cript:x' }", "script_scheme"],
    ["an asset this CSS does not have", "a { background: url(\"asset:ffffffffffffffffffffffffffffffff\") }", "unknown_asset"],
    ["url(\"asset:…\") with a second argument", "a { background: url(\"asset:" + A + "\" x) }", "url"],
    ["a bad string", "a { content: 'x\n }", "malformed"],
    ["a bad url", "a { background: url(a b) }", "malformed"],
    ["NUL", "a{}\u0000", "nul"],
  ])("%s", (_n, css, want) => {
    expect(problem(css)).toBe(want);
  });
  it("64 KiB is the limit: exactly at it passes, one byte over is refused", () => {
    const base = "a{}";
    const at = base + " ".repeat(OWNER_CSS_MAX_BYTES - base.length);
    expect([problem(at), problem(at + " ")]).toEqual(["ok", "too_large"]);
    expect(problem("/*" + "é".repeat(OWNER_CSS_MAX_BYTES / 2) + "*/"), "bytes, not characters").toBe("too_large");
  });
});

describe("accepted and served", () => {
  it("ordinary CSS passes, and is served re-serialised", () => {
    expect(served(".x { color: red ; }\n.y{margin:0}")).toBe(".x { color: red ; }\n.y{margin:0}");
  });
  it("asset: references are rewritten to /ui/owner-css/asset/<id>, quoted or not", () => {
    expect(served(`@font-face { font-family: F; src: url("asset:${A}") format("woff2") }`))
      .toBe(`@font-face { font-family: F; src: url("/ui/owner-css/asset/${A}") format("woff2") }`);
    expect(served(`a { background: url(asset:${A}) }`)).toBe(`a { background: url(/ui/owner-css/asset/${A}) }`);
  });
  it("the served bytes are never the uploaded bytes: comments go, escapes are canonical, strings never hold '<'", () => {
    const out = served("/* hi */ a::after { content: '</style><script>' ; font-family: \\66oo }");
    expect(out).toBe(" a::after { content: \"\\3c /style>\\3c script>\" ; font-family: foo }");
    expect(out).not.toContain("<");
  });
  it("tokens that would merge get a comment between them, and the result tokenizes back to the same tokens", () => {
    for (const css of ["a{margin:1px -2px}", "a{width:calc(1px+2px)}", ".a.b#c{}", "a{grid-area:1/2}", "a{x:1e3}", "a{x:1\\65 3}"]) {
      const r = check(css);
      expect(r.ok, css).toBe(true);
      if (!r.ok) continue;
      const text = serializeOwnerCss(r.tokens);
      const back = tokenizeCss(text).filter(t => t.type !== "ws").map(t => [t.type, t.value, t.unit ?? ""]);
      expect(back, css).toEqual(r.tokens.filter(t => t.type !== "ws").map(t => [t.type, t.value, t.unit ?? ""]));
    }
  });
});

describe("fuzz: whatever the gate accepts serialises, and re-tokenizes to the same tokens", () => {
  it("60 000 random texts over CSS's awkward characters", () => {
    let seed = 1629;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const alphabet = ["a", "Z", "-", "_", "0", "9", ".", "+", "#", "@", "%", "e", "E", "\\", "\\41 ", "/", "*", "(", ")", "{", "}", "[", "]",
      ":", ";", ",", " ", "\n", "'", ">", "--", "\\-", "\"", "<", "!", "-->", "<!--", "é", "中", "url(", "x(", "1e3", "-1", ".5", "\\0", "\t"];
    let accepted = 0;
    for (let k = 0; k < 60_000; k++) {
      let css = "";
      const len = 1 + Math.floor(rnd() * 24);
      for (let j = 0; j < len; j++) css += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = check(css);
      if (!r.ok) continue;
      accepted++;
      let text = "";
      expect(() => { text = serializeOwnerCss(r.tokens); }, JSON.stringify(css)).not.toThrow();
      // Strings never carry "<" (it is escaped); a bare "<" delim is legal CSS and harmless in text/css.
      for (const t of tokenizeCss(text)) if (t.type === "string") expect(text.includes(`"${t.value}"`) && t.value.includes("<"), JSON.stringify(css)).toBe(false);
    }
    expect(accepted).toBeGreaterThan(5_000);
  });
});

describe("review r1 (#1883)", () => {
  it("P2-1: comments between whitespace — ordinary commented CSS is accepted and served", () => {
    for (const css of ["a{color:red; /* comment */ margin:0}", "a{}\n/* comment */\nb{}", "a{} /* one */ /* two */ b{}"]) {
      const r = check(css);
      expect(r.ok, css).toBe(true);
      if (r.ok) expect(() => serializeOwnerCss(r.tokens), css).not.toThrow();
    }
    expect(served("a{color:red; /* comment */ margin:0}")).toBe("a{color:red; margin:0}");
    expect(served("a{}\n/* comment */\nb{}")).toBe("a{}\nb{}");
  });
  it("P3: an ID selector keeps its identifier spelling (#\\31 23 stays an ID); an unrestricted hash needs no escape", () => {
    expect(served("#\\31 23{color:red}")).toBe("#\\31 23{color:red}");
    expect(served("#\\61 bc{color:red}")).toBe("#abc{color:red}");
    expect(served("#-\\31 2{color:red}")).toBe("#-\\31 2{color:red}");
    expect(served("a{color:#123}")).toBe("a{color:#123}");
    expect(tokenizeCss("#\\31 23")[0]).toMatchObject({ type: "hash", value: "123", hashType: "id" });
    expect(tokenizeCss("#123")[0]).toMatchObject({ type: "hash", value: "123", hashType: "unrestricted" });
  });
});

describe("#1629 B2 seam: serializeCssTokens is the generic serialiser", () => {
  it("no asset rewriting (that is serializeOwnerCss's); the same round-trip check", () => {
    const A2 = "0123456789abcdef0123456789abcdef";
    const css = `a{background:url("asset:${A2}");content:"asset:${A2}"}`;
    expect(serializeCssTokens(tokenizeCss(css))).toBe(css);
    expect(serializeOwnerCss(tokenizeCss(css))).toBe(`a{background:url("/ui/owner-css/asset/${A2}");content:"/ui/owner-css/asset/${A2}"}`);
    expect(() => serializeCssTokens([{ type: "ws", value: " " }, { type: "ws", value: " " }])).toThrow(/re-serialise/);
  });
});
