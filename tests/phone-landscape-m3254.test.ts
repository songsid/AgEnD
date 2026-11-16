/**
 * M-3254 (the user, 11-16): a phone held sideways gets the phone layout. One query says "phone" everywhere — every
 * script's matchMedia and every stylesheet's phone block:
 *   (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)
 * a phone's width, or a touch screen in a short window that is no wider than a phone sideways (a tablet's keyboard,
 * which shrinks the window under interactive-widget=resizes-content, never flips a tablet). The desktop-only blocks
 * say exactly the rest (DESK). Measured in Chromium by scripts/manual/smoke/smoke-phone-landscape-m3254.mts.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PHONE = "(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";
const DESK = "(min-width: 900px) and (pointer: fine), (min-width: 900px) and (pointer: none), (min-width: 900px) and (min-height: 501px), (min-width: 1024px)";
const files = execFileSync("git", ["ls-files", "src/ui"], { encoding: "utf8" }).split("\n").filter(Boolean);
const read = (f: string) => readFileSync(f, "utf8");

/** A tiny evaluator for these media query lists: comma = or, "and" = and; width, height and pointer features. */
type Env = { w: number; h: number; pointer: "fine" | "coarse" | "none" };
function matches(q: string, e: Env): boolean {
  return q.split(/,\s*/).some((part) => [...part.matchAll(/\(([a-z-]+):\s*([a-z0-9]+)\)/g)].every(([, f, v]) => {
    const n = parseFloat(v);
    switch (f) {
      case "max-width": return e.w <= n;
      case "min-width": return e.w >= n;
      case "max-height": return e.h <= n;
      case "min-height": return e.h >= n;
      case "pointer": return e.pointer === v;
      default: throw new Error(`unknown feature ${f}`);
    }
  }));
}

describe("M-3254: one phone query", () => {
  it("the phone and the desk queries split every window in two: a phone's width, or a touch screen sideways — and nothing else", () => {
    for (const w of [320, 440, 899, 900, 956, 1023, 1024, 1180, 1366]) for (const h of [200, 440, 500, 501, 820, 956]) for (const pointer of ["fine", "coarse", "none"] as const) {
      const e = { w, h, pointer }, phone = matches(PHONE, e);
      expect(phone !== matches(DESK, e), JSON.stringify(e)).toBe(true);
      expect(phone, JSON.stringify(e)).toBe(w <= 899 || (pointer === "coarse" && h <= 500 && w <= 1023));
    }
    // The user's iPhone sideways, an iPad sideways, a tablet sideways with its keyboard up, a desk with a short window.
    expect([{ w: 956, h: 440, pointer: "coarse" }, { w: 1180, h: 820, pointer: "coarse" }, { w: 1280, h: 380, pointer: "coarse" }, { w: 1366, h: 400, pointer: "fine" }]
      .map((e) => matches(PHONE, e as Env))).toEqual([true, false, false, false]);
  });
  it("every script asks the one query: no matchMedia on the bare phone width is left", () => {
    const bad: string[] = [], seen: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      for (const m of read(f).matchAll(/"([^"]*\b899px[^"]*)"/g)) { (m[1] === PHONE ? seen : bad).push(`${f}: ${m[1]}`); }
    }
    expect(bad).toEqual([]);
    // The shell's drawer, the app's swipe, the sheets, Fleet, the chat, the agent list's density (M-3252), the Office.
    for (const f of ["src/ui/shared/app-shell.js", "src/ui/shared/app.js", "src/ui/shared/agent-sheet.js", "src/ui/panel-fleet.js", "src/ui/panel-chat.js",
      "src/ui/shared/instance-nav.js", "src/ui/fleet-office.js"]) expect(seen.some((s) => s.startsWith(`${f}:`)), f).toBe(true);
  });
  it("every stylesheet's phone block is the one query (or a wider touch one); every desk-only block is DESK", () => {
    const touch = new Set(["(max-width: 899px), (pointer: coarse)", "(pointer: coarse), (max-width: 899px)", "(max-width:899px),(pointer:coarse)"]);
    const bad: string[] = [];
    for (const f of files.filter((x) => /\.(css|html)$/.test(x))) {
      for (const m of read(f).matchAll(/@media ([^{]*\b(?:899|900)px[^{]*?)\s*\{/g)) {
        const q = m[1].trim();
        const ok = q === PHONE || touch.has(q) || q === DESK || q === DESK.split(", ").map((p) => p + q.slice(q.lastIndexOf(" and (max-width:"))).join(", ");
        if (!ok) bad.push(`${f}: @media ${q}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
