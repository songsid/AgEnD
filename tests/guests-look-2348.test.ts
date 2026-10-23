/**
 * #2348 follow-up: Settings → Access & security → Guests in the fixed template (#2330, #2478 item 7). Its rows are flat,
 * split by a rule; an edited row is the shared straight bar and a flat tint (`.s-dirty`), square and as wide as the
 * column; a state is coloured text; a chip is a square outline. Nothing in the section is a rounded fill or a ring: the
 * avatar's circle is the only radius. The section's g-* parts had no rules at all before (they rendered unstyled).
 * The rendered look is checked by scripts/manual/smoke/smoke-2348-guests-look.mts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.split(",").map((x) => x.trim()), body: m[2]! }));
const guestRules = rules.filter((r) => r.sels.some((x) => x.startsWith(".s-guests")));
const bodyOf = (sel: string) => rules.filter((r) => r.sels.includes(sel)).map((r) => r.body).join(";");
const decl = (sel: string, prop: string) => { const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bodyOf(sel)); return m ? m[1]!.trim() : null; };

describe("#2348: Guests in the fixed template", () => {
  it("every part the section draws has a rule (none renders unstyled)", () => {
    const js = readFileSync(join(process.cwd(), "src", "ui", "settings-guests.js"), "utf8");
    const used = [...new Set([...js.matchAll(/class(?:Name)?=["`$\{]*["`]?([^"`]*)/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => /^g-[a-z]+$/.test(c)))];
    expect(used.length, "the section uses g-* classes").toBeGreaterThan(8);
    const styled = new Set(guestRules.flatMap((r) => r.sels).flatMap((x) => [...x.matchAll(/\.(g-[a-z]+)/g)].map((m) => m[1])));
    expect(used.filter((c) => !styled.has(c) && !["g-removed", "g-send"].includes(c))).toEqual([]);
  });
  it("no rounded box, fill or ring: the avatar's circle is the only radius; a chip is a square outline", () => {
    const radii = guestRules.flatMap((r) => [...r.body.matchAll(/border-radius\s*:\s*([^;]+)/g)].map((m) => [r.sels.join(","), m[1]!.trim()]));
    expect(radii.filter(([sel, v]) => v !== "0" && !(sel === ".s-guests .g-av" && v === "50%"))).toEqual([]);
    expect(guestRules.filter((r) => /box-shadow|outline\s*:/.test(r.body)).map((r) => r.sels.join(","))).toEqual([]);
    expect(guestRules.filter((r) => /background/.test(r.body)).map((r) => r.sels.join(","))).toEqual([".s-guests .g-av"]);
    expect([decl(".s-guests .g-chip", "border-radius"), /^1px solid /.test(decl(".s-guests .g-chip", "border") ?? "")]).toEqual(["0", true]);
  });
  it("an edited row: the shared bar (.s-dirty hosts and draws it), square, and the column's full width", () => {
    const hosts = rules.find((r) => r.sels.includes(".lbar") && /position:\s*relative/.test(r.body))!.sels;
    const bars = rules.find((r) => r.sels.includes(".lbar::before"))!.sels;
    expect([hosts.includes(".s-dirty"), bars.includes(".s-dirty::before")]).toEqual([true, true]);
    // .s-dirty alone is square but starts aligned (a field); `.s-guests .guest-row` must not undo either.
    expect([decl(".s-guests .guest-row", "border-radius"), decl(".s-guests .guest-row", "border")]).toEqual([null, null]);
    expect([decl(".s-guests .guest-row.s-dirty", "border-radius"), decl(".s-guests .guest-row.s-dirty", "align-self")]).toEqual(["0", "stretch"]);
  });
  it("a state is coloured text: signed in, code sent, a DM that failed", () => {
    expect([decl(".s-guests .g-state.on", "color"), decl(".s-guests .g-state.sent", "color"), decl(".s-guests .g-state.warn", "color")])
      .toEqual(["var(--ok)", "var(--accent)", "var(--danger)"]);
  });
  it("on a phone a name or a time never breaks inside (an agent's name at its hyphens, 'last seen <time>')", () => {
    expect([decl(".s-guests .g-when", "white-space"), decl(".s-guests .g-wrote", "white-space")]).toEqual(["nowrap", "nowrap"]);
  });
});
