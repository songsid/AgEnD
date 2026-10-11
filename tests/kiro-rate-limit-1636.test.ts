import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KiroBackend, wrapTolerant } from "../src/backend/kiro.js";

/**
 * #1636: kiro's chat prints its rate limit and its monthly cap WITHOUT the `Kiro is having trouble responding right
 * now:` header and without an exception name (upstream Amazon Q Developer CLI, Throttling and MonthlyLimitReached
 * branches — tests/fixtures/kiro-2.29.1-audit/). Before #1636 neither output matched any kiro error pattern: a
 * throttled or capped instance was never classified and nobody was told.
 */
const FIXTURES = join(process.cwd(), "tests", "fixtures", "kiro-2.29.1-audit");

/** The Throttling branch's two lines, as written to the pane (legacy UI), then kiro's prompt. */
const THROTTLED = [
  " ⚠️  Kiro rate limit reached:",
  "    Request quota exceeded. Please wait a moment and try again.",
  "",
  "> ",
].join("\n");
/** The same under the TUI, which puts its `●` bullet in front of a message (cf. the #440 header pane). */
const THROTTLED_TUI = [
  "● ⚠️  Kiro rate limit reached:",
  "  Request quota exceeded. Please wait a moment and try again.",
  "",
].join("\n");
/** MonthlyLimitReached with a subscription: the reset date on the same line. */
const MONTHLY_INLINE = ["Monthly request limit reached - The limits reset on 11/01.", "", "> "].join("\n");
/** Without one: the phrase alone on its line, the reset sentence a few lines below. */
const MONTHLY_BELOW = [
  "Monthly request limit reached",
  "",
  "Upgrade for increased limits, or wait for the reset. The limits reset on 11/01.",
  "",
  "Use /subscribe to upgrade your subscription.",
].join("\n");

/**
 * The free-tier layout as upstream builds it (MonthlyLimitReached: the phrase, "\n\n", ui_text::limit_reached_text(),
 * then " The limits reset on MM/01."): the reset date lands on the 5th line after the phrase (Prism, #1637 R1).
 */
const LIMIT_REACHED_TEXT = [
  "You've used all your free requests for this month. You have two options:",
  "",
  "1. Upgrade to a paid subscription for increased limits. See our Pricing page for what's included> https://aws.amazon.com/q/developer/pricing/",
  "2. Wait until next month when your limit automatically resets.",
].join("\n");
const MONTHLY_FREE_TIER = `Monthly request limit reached\n\n${LIMIT_REACHED_TEXT} The limits reset on 11/01.\n\nUse /subscribe to upgrade your subscription.\n\n> `;
/** A pane `columns` wide, read as the error monitor reads it (capture-pane without -J): every row cut at the column,
 *  mid-word, and its trailing spaces dropped. */
const wrapAt = (text: string, columns: number) =>
  text.split("\n").flatMap(line => (line.length <= columns ? [line] : line.match(new RegExp(`.{1,${columns}}`, "g"))!)).map(r => r.trimEnd()).join("\n");
const wrap80 = (text: string) => wrapAt(text, 80);

/** Exactly what the monitor does: the first pattern in array order wins. */
function classify(pane: string) {
  return new KiroBackend("/tmp/test", TEST_KIRO_COMPAT).getErrorPatterns().find(ep => ep.pattern.test(pane));
}
const patterns = () => new KiroBackend("/tmp/test", TEST_KIRO_COMPAT).getErrorPatterns();

describe("#1636: kiro's rate limit and monthly cap are classified", () => {
  it.each([["the legacy UI", THROTTLED], ["the TUI", THROTTLED_TUI]])("the rate-limit lines (%s) are rate_limit / notify", (_ui, pane) => {
    expect(classify(pane)).toMatchObject({ type: "rate_limit", action: "notify", message: expect.stringMatching(/rate limit reached/) });
  });

  it.each([["the reset on the same line", MONTHLY_INLINE], ["the reset a few lines below", MONTHLY_BELOW]])("the monthly cap (%s) is rate_limit / notify", (_shape, pane) => {
    expect(classify(pane)).toMatchObject({ type: "rate_limit", action: "notify", message: expect.stringMatching(/request limit reached — it resets/) });
  });

  it("the monthly cap with upstream's whole free-tier text, as written and wrapped at 80 columns, is rate_limit / notify", () => {
    expect(MONTHLY_FREE_TIER.split("\n").findIndex(l => l.includes("The limits reset on"))).toBe(5);
    expect(wrap80(MONTHLY_FREE_TIER)).not.toContain("The limits reset on");          // the wrap splits it
    for (const pane of [MONTHLY_FREE_TIER, wrap80(MONTHLY_FREE_TIER), wrap80(MONTHLY_FREE_TIER).replace(/\n> $/, "")]) {
      expect(classify(pane), pane).toMatchObject({ type: "rate_limit", action: "notify", message: expect.stringMatching(/request limit reached — it resets/) });
    }
  });

  it("Prism R2: a narrow pane wraps the rate-limit pair and the subscriber's reset line mid-word — both still classify", () => {
    for (const columns of [40, 48]) {
      for (const [pane, message] of [[THROTTLED, /Kiro rate limit reached/], [MONTHLY_INLINE, /request limit reached — it resets/]] as const) {
        const narrow = wrapAt(pane, columns);
        expect(narrow, "the wrap really splits a phrase").not.toBe(pane);
        expect(classify(narrow), narrow).toMatchObject({ type: "rate_limit", action: "notify", message: expect.stringMatching(message) });
      }
    }
  });

  it("…and the quotes stay unmatched when the pane wraps them too", () => {
    for (const columns of [40, 48]) {
      for (const quote of [
        "When kiro prints Monthly request limit reached - The limits reset on 11/01. AgEnD notifies.",
        "kiro prints ⚠️  Kiro rate limit reached: and then Request quota exceeded. Please wait a moment and try again.",
        "- Monthly request limit reached",
      ]) {
        expect(classify(wrapAt(quote, columns)), wrapAt(quote, columns)).toBeUndefined();
      }
    }
  });

  it("wrapTolerant allows one row break per gap, never a blank row, and keeps the words exact", () => {
    const re = new RegExp(`^${wrapTolerant("Kiro rate limit")}$`);
    expect(["Kiro rate limit", "Kiro\nrate limit", "Kiro rate li\nmit", "Kiro \nrate limit", "Kiro\n rate limit"].map(t => re.test(t))).toEqual([true, true, true, true, true]);
    expect(["Kiro\n\nrate limit", "Kiro rate\n\nlimit", "Kiro rate limits", "Kiro rates limit", "Kiroratelimit", "Kiro ratelimit"].map(t => re.test(t))).toEqual([false, false, false, false, false, false]);
  });

  it("Prism R3: words run together or a reset that is not \"reset on\" do not match", () => {
    for (const pane of [
      "Monthlyrequestlimitreached",
      "Kiroratelimitreached:\nRequestquotaexceeded.Pleasewaitamomentandtryagain.",
      "Monthly request limit reached - The limits reset once testing finishes.",
    ]) {
      expect(classify(pane), pane).toBeUndefined();
    }
    expect(classify("Monthly\nrequest limit reached")).toMatchObject({ type: "rate_limit" });   // a real row break between words
  });

  it("an expired login on the same pane still wins: auth pauses, first match", () => {
    const pane = `${THROTTLED}\nYou are not logged in, please log in with kiro-cli login\n`;
    expect(classify(pane)).toMatchObject({ type: "auth_error", action: "pause" });
    expect(classify(`${MONTHLY_INLINE}\nExpiredTokenException: The security token included in the request is expired`)).toMatchObject({ type: "auth_error" });
  });

  it("a quote does not match: mid-sentence, one line of the pair, or the monthly phrase inside a sentence, a list item or quotes", () => {
    for (const pane of [
      "kiro prints ⚠️  Kiro rate limit reached: and then Request quota exceeded. Please wait a moment and try again.",
      "If it says Kiro rate limit reached:\n    Request quota exceeded. Please wait a moment and try again. we notify.",
      " ⚠️  Kiro rate limit reached:\n\n> ",
      "    Request quota exceeded. Please wait a moment and try again.",
      "When kiro prints Monthly request limit reached - The limits reset on 11/01. AgEnD notifies.",
      "Monthly request limit reached, so I stopped for today.",
      "- Monthly request limit reached",
      "`Monthly request limit reached`",
    ]) {
      expect(classify(pane), pane).toBeUndefined();
    }
  });

  it("they sit after the auth entry and before the header catch-all (first match stays meaningful)", () => {
    const list = patterns();
    const at = (re: RegExp) => list.findIndex(ep => re.test(ep.message));
    const auth = list.findIndex(ep => ep.type === "auth_error");
    const rate = at(/Kiro rate limit reached/), monthly = at(/request limit reached — it resets/);
    const catchAll = list.findIndex(ep => ep.pattern.source === "having trouble responding");
    expect(auth).toBeGreaterThanOrEqual(0);
    expect([auth < rate, auth < monthly, rate < catchAll, monthly < catchAll, catchAll === list.length - 1]).toEqual([true, true, true, true, true]);
  });

  it("the literals they are built on are in both kiro-cli-chat versions, once each (fixtures from the binaries)", () => {
    for (const version of ["2.29.0", "2.29.1"]) {
      const strings = readFileSync(join(FIXTURES, `kiro-cli-chat-${version}.strings.txt`), "utf8");
      for (const literal of ["Kiro rate limit reached:", "Request quota exceeded. Please wait a moment and try again.", "Monthly request limit reached", "The limits reset on "]) {
        expect(strings, `${version}: ${literal}`).toContain(`## ${JSON.stringify(literal).replace(/^"|"$/g, "'")}: count 1`);
      }
    }
    const upstream = readFileSync(join(FIXTURES, "upstream-chat-mod-throttling-monthly.rs.txt"), "utf8");
    expect(upstream).toContain("ConverseStreamErrorKind::Throttling");
    expect(upstream).toMatch(/\(error_messages::TROUBLE_RESPONDING, eyre!\(err\), false\)/);   // no header on this path
    expect(upstream).toContain("ConverseStreamErrorKind::MonthlyLimitReached");
  });
});
