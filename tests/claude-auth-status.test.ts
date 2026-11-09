import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNT_IDENTITY_CAPABILITY, PLANS, identityOf, normalizeSubscriptionType, parseAccountIdentity, parseClaudeAuthStatus, redactedEmail, validMaskedEmail } from "../src/claude-auth-status.js";
import { RUNTIME_BUNDLE_MODULES } from "../src/runtime-build-info.js";

// Every address here is a fixture on example.com; no real person's address appears in a test or a screenshot.
const status = (over: Record<string, unknown> = {}) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "alice.fixture@example.com", orgName: "Fixture Org", subscriptionType: "team", planTier: "other", configDirectory: "C:\\fixture", ...over });
const masked = (email: unknown) => parseClaudeAuthStatus(status({ email })).maskedEmail;

describe("the e-mail in `claude auth status`", () => {
  it("is the whole address, so two accounts of one administrator with the same prefix stay apart", () => {
    expect(masked("abcd@example.com")).toBe("abcd@example.com");
    expect(masked("alice.fixture@example.com")).toBe("alice.fixture@example.com");
    expect(masked("abc@mail.example.co.uk")).toBe("abc@mail.example.co.uk");
    expect(masked("  abcd@example.com  ")).toBe("abcd@example.com");
    expect(masked("a.b+tag@example.com")).toBe("a.b+tag@example.com");
    expect(masked("a@example.com")).toBe("a@example.com");
    const first = masked("fixture.owner@example.com"), second = masked("fixture.main@example.com");
    expect(first).not.toBe(second);
    expect(redactedEmail(first)).toBe(redactedEmail(second));   // the redacted form is the one that cannot tell them apart: that is why the Accounts page shows the whole address
  });
  it("sends no e-mail, never a partial one, when it is missing, not ASCII, or not an address", () => {
    for (const bad of [undefined, null, 5, {}, ["a@example.com"], "", " ", "noatsign", "@example.com", "a@", "a@b", "a@.com", "a@example.", "a@exa..mple.com", "a b@example.com", "a@exa mple.com",
      "a@@example.com", "a@b@example.com", "*bc@example.com", "a@exa*mple.com", "a\n@example.com", "é@example.com", "ab@exämple.com", "名前@example.com", "ab@例え.jp", "𝒜𝒷𝒸@example.com",
      "x".repeat(255) + "@example.com", "ab@" + "x".repeat(250) + ".com", "'ab'@example.com", "ab***@example.com"]) {
      expect(masked(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
  it("checks the raw value BEFORE any trimming: padding that would make an over-long or non-ASCII value fit does not hide it", () => {
    const addr = "alice.fixture@example.com";
    for (const bad of [`\u00a0${addr}`, `${addr}\u00a0`, `\u3000${addr}`, `${addr}\u2003`, `\u200b${addr}`, `\ufeff${addr}`, `${" ".repeat(260)}${addr}`, `${addr}${" ".repeat(260)}`, `${" ".repeat(130)}${addr}${" ".repeat(130)}`,
      `${"\n".repeat(300)}${addr}`, `${addr}\n${"x".repeat(300)}`, `${" ".repeat(250)}${"a".repeat(250 - 12)}@example.com`]) {
      expect(masked(bad), JSON.stringify(bad).slice(0, 40)).toBeUndefined();
    }
    for (const ok of [` ${addr}`, `${addr} `, `\n${addr}\n`, `\t${addr}\r\n`, `  ${addr}  `]) expect(masked(ok), JSON.stringify(ok)).toBe(addr);       // the CLI's own surrounding white space is still fine
    const at254 = `${"a".repeat(254 - "@example.com".length)}@example.com`; expect(masked(at254)).toBe(at254);
    expect(masked(`  ${at254}`)).toBeUndefined(); expect(masked(`${at254}\n`)).toBeUndefined();                                           // the raw value is over the limit, so it is refused whole: not trimmed back into range
  });
  it("is dropped, not truncated, when it is over 254 characters; 254 exactly is kept whole", () => {
    const local = "a".repeat(64), domain = `${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(50)}.com`;
    const at254 = `${"a".repeat(254 - domain.length - 1)}@${domain}`;
    expect(at254).toHaveLength(254); expect(masked(at254)).toBe(at254);
    const at255 = `a${at254}`; expect(at255).toHaveLength(255);
    expect(masked(at255)).toBeUndefined(); expect(validMaskedEmail(at255)).toBe(false); expect(validMaskedEmail(at254.slice(0, 254))).toBe(true);
    expect(masked(`${local}@example.com`)).toBe(`${local}@example.com`);
  });
});

describe("the address contract is one pattern, enforced where a value arrives", () => {
  it("accepts a whole ASCII address and, for a Runtime's older cached status, the masked form", () => {
    for (const ok of ["abcd@example.com", "a@example.com", "junsionloh@gmail.com", "junsion.main@gmail.com", "a.b+tag@x-y.example.org", "ab@xn--bcher-kva.example"]) expect(validMaskedEmail(ok), ok).toBe(true);
    for (const ok of ["a***@example.com", "ab***@example.com", "ab***@mail.example.co.uk", "a.***@example.com", "a+***@x-y.example.org", "ab***@xn--bcher-kva.example"]) expect(validMaskedEmail(ok), ok).toBe(true);
  });
  it("refuses every near miss, including non-ASCII, white space, a second @ and over-long values", () => {
    for (const bad of ["abc***@example.com", "***@example.com", "ab**@example.com", "ab****@example.com", "ab***example.com", "ab***@example", "@example.com", "a@example", "a@b",
      "ab***@.com", "ab***@example..com", "ab***@exa*mple.com", "ab***@example.com ", " ab***@example.com", "ab***@example.com\n", "ab***@ex ample.com", "a b***@example.com", "ab***@example.com,other@example.com",
      "ab***@example.com@x", "ab*@example.com", "é***@example.com", "ab***@exämple.com", "ab***@" + "x".repeat(300) + ".com", "ab***@" + "x".repeat(250) + ".com",
      "alice@example.com ", " alice@example.com", "alice@example.com\n", "ali ce@example.com", "alice@exam ple.com", "alice@@example.com", "alice@b@example.com", "alice@example.com,bob@example.org",
      "é@example.com", "alice@exämple.com", "名前@example.com", "alice@例え.jp", "alice@.com", "alice@example..com", "alice@exa*mple.com", "al*ce@example.com", "alice@" + "x".repeat(300) + ".com",
      "x".repeat(255) + "@example.com", "a".repeat(250) + "@example.com", "", 5, null, undefined, {}]) {
      expect(validMaskedEmail(bad as never), JSON.stringify(bad)).toBe(false);
    }
  });
  it("parseAccountIdentity is closed, and its errors never echo the rejected value", () => {
    expect(parseAccountIdentity({ maskedEmail: "ab***@example.com", plan: "team" })).toEqual({ maskedEmail: "ab***@example.com", plan: "team" });
    expect(parseAccountIdentity({ maskedEmail: "alice.fixture@example.com", plan: "team" })).toEqual({ maskedEmail: "alice.fixture@example.com", plan: "team" });
    expect(parseAccountIdentity({ plan: "unknown" })).toEqual({ plan: "unknown" }); expect(parseAccountIdentity({ apiKey: true })).toEqual({ apiKey: true }); expect(parseAccountIdentity({})).toEqual({});
    const bad: unknown[] = [{ maskedEmail: "alice.fixture@exämple.com" }, { maskedEmail: "x".repeat(255) + "@example.com" }, { maskedEmail: "alice fixture@example.com" }, { email: "ab***@example.com" }, { maskedEmail: "ab***@example.com", name: "Alice" }, { plan: "Team" }, { plan: "gold" }, { plan: "other" },
      { plan: "team; drop" }, { maskedEmail: 5 }, { plan: 5 }, { apiKey: false }, { apiKey: "yes" }, { apiKey: true, plan: "team" }, { apiKey: true, maskedEmail: "ab***@example.com" }, { apiKey: true, maskedEmail: "alice.fixture@example.com" }, null, [], "ab***@example.com", 5];
    for (const value of bad) {
      let message = ""; try { parseAccountIdentity(value); } catch (error) { message = (error as Error).message; }
      expect(message, JSON.stringify(value)).toMatch(/^Invalid account identity: (identity|unknown field|maskedEmail|plan|apiKey)$/);
      for (const secret of ["alice", "fixture", "example", "Alice", "gold", "drop"]) expect(message).not.toContain(secret);
    }
  });
});

describe("redactedEmail: the form for any text that is not the Accounts page", () => {
  it("keeps one or two characters of the local part, then ***, then the whole domain", () => {
    expect(redactedEmail("abcd@example.com")).toBe("ab***@example.com"); expect(redactedEmail("ab@example.com")).toBe("a***@example.com"); expect(redactedEmail("a@example.com")).toBe("a***@example.com");
    expect(redactedEmail("alice.fixture@example.com")).toBe("al***@example.com"); expect(redactedEmail("ab***@example.com")).toBe("ab***@example.com");
  });
  it("is nothing for what is not an address, and never contains the rest of the local part", () => {
    for (const bad of [undefined, null, 5, "", "é@example.com", "x".repeat(255) + "@example.com", "a b@example.com"]) expect(redactedEmail(bad), JSON.stringify(bad)).toBeUndefined();
    expect(redactedEmail("alice.fixture@example.com")).not.toContain("alice.fixture");
  });
});

describe("the plan is from a fixed list", () => {
  it("is free, pro, max, team or enterprise, lower-case, and `unknown` for anything else", () => {
    expect(PLANS).toEqual(["free", "pro", "max", "team", "enterprise", "unknown"]);
    for (const plan of ["free", "pro", "max", "team", "enterprise"]) expect(parseClaudeAuthStatus(status({ subscriptionType: plan })).plan).toBe(plan);
    expect(parseClaudeAuthStatus(status({ subscriptionType: " Team " })).plan).toBe("team"); expect(parseClaudeAuthStatus(status({ subscriptionType: "ENTERPRISE" })).plan).toBe("enterprise");
    for (const other of ["gold", "max_5x", "team; drop table", "x".repeat(500), "constructor", "__proto__", "toString", "unknown", "Unknown"]) expect(parseClaudeAuthStatus(status({ subscriptionType: other })).plan, other).toBe("unknown");
  });
  it("is absent, not invented, when the CLI gives none", () => {
    for (const none of [undefined, null, "", "  ", 5, {}]) expect(parseClaudeAuthStatus(status({ subscriptionType: none })).plan, JSON.stringify(none)).toBeUndefined();
    expect(normalizeSubscriptionType(" Team ")).toBe("team"); expect(normalizeSubscriptionType(5)).toBeUndefined(); expect(normalizeSubscriptionType("  ")).toBeUndefined();
  });
});

describe("parseClaudeAuthStatus: signed in or not, and which account", () => {
  it("reads loggedIn and, for a signed-in account, the e-mail and the plan", () => {
    expect(parseClaudeAuthStatus(status())).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" });
    expect(identityOf(parseClaudeAuthStatus(status({ email: "ab@example.com", subscriptionType: "max" })))).toEqual({ maskedEmail: "ab@example.com", plan: "max" });
  });
  it("is only what is there: a plan without an e-mail, an e-mail without a plan, neither", () => {
    expect(parseClaudeAuthStatus(status({ email: undefined }))).toEqual({ loggedIn: true, plan: "team" });
    expect(parseClaudeAuthStatus(status({ subscriptionType: undefined }))).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com" });
    expect(parseClaudeAuthStatus(status({ email: undefined, subscriptionType: undefined }))).toEqual({ loggedIn: true });
    expect(identityOf(parseClaudeAuthStatus(status({ email: undefined, subscriptionType: undefined })))).toBeUndefined();
  });
  it("marks an API-key sign-in as that, with no e-mail and no plan, whatever else the answer carries", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }))).toEqual({ loggedIn: true, apiKey: true });
    expect(parseClaudeAuthStatus(status({ authMethod: "api_key" }))).toEqual({ loggedIn: true, apiKey: true });
    expect(identityOf(parseClaudeAuthStatus(status({ authMethod: "api_key" })))).toEqual({ apiKey: true });
  });
  it("is signed out (false) with no identity when the CLI says so, and unknown (null) when there is no readable answer", () => {
    expect(parseClaudeAuthStatus(status({ loggedIn: false }))).toEqual({ loggedIn: false });
    for (const text of [status({ loggedIn: "true" }), status({ loggedIn: undefined }), "", "not json", "null", "[]", "5", '"x"', "{", "}{", "x".repeat(70_000)]) expect(parseClaudeAuthStatus(text), text.slice(0, 30)).toEqual({ loggedIn: null });
    for (const bad of [undefined, null, 5, {}]) expect(parseClaudeAuthStatus(bad as never)).toEqual({ loggedIn: null });
  });
  it("finds the JSON when stdout and stderr are merged around it (what the host's authCheck always read)", () => {
    expect(parseClaudeAuthStatus(`warning: something\n${status()}\nmore text`)).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" });
    expect(parseClaudeAuthStatus(`${status({ loggedIn: false })}\n`)).toEqual({ loggedIn: false });
  });
  it("finds the answer among other text that has braces in it (what the reviewer ran), and the older regex's cases still hold", () => {
    const answer = { loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" as const };
    expect(parseClaudeAuthStatus(`warning {x}\n${status()}`)).toEqual(answer);
    expect(parseClaudeAuthStatus(`${status()}\nsee {docs}`)).toEqual(answer);
    expect(parseClaudeAuthStatus(`warning {x}\n${status()}\nsee {docs} and {more}`)).toEqual(answer);
    expect(parseClaudeAuthStatus(`unbalanced { warning\n${status()}`)).toEqual(answer);
    expect(parseClaudeAuthStatus(`stray } brace and {\n${status()}`)).toEqual(answer);
    expect(parseClaudeAuthStatus(`{"note":"not it"}\n{"other":{"loggedIn":"x"}}\n${status({ loggedIn: false })}`)).toEqual({ loggedIn: false });
    expect(parseClaudeAuthStatus(`{"debug":{"loggedIn":"nested"}}\n${status()}`)).toEqual(answer);
  });
  it("is not fooled by braces inside the answer's own strings", () => {
    expect(parseClaudeAuthStatus(status({ orgName: "Fixture {Org} } {" }))).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" });
    expect(parseClaudeAuthStatus(status({ orgName: 'quote " and } brace', email: "ab@example.com" }))).toEqual({ loggedIn: true, maskedEmail: "ab@example.com", plan: "team" });
    expect(parseClaudeAuthStatus(`{"x":"}"}\n${status()}`)).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" });
  });
  it("still says no readable answer when there is none, and does not grind on hostile input", () => {
    for (const text of ["{x}", "{x} {y} {z}", "{{{{", "}}}}", '{"loggedIn": maybe}', "see {docs}\nnothing else"]) expect(parseClaudeAuthStatus(text), text).toEqual({ loggedIn: null });
    for (const text of ["{".repeat(60_000), "{\"a\":".repeat(10_000), "{}".repeat(30_000), "{ ".repeat(30_000) + status()]) {
      const started = Date.now(); parseClaudeAuthStatus(text); expect(Date.now() - started, text.slice(0, 12)).toBeLessThan(500);
    }
  });
  it("takes the address from the `email` key only, and nothing else of the status", () => {
    const result = parseClaudeAuthStatus(status({ email: "alice.fixture@example.com", orgName: "other.org@example.com", displayName: "display.name@example.com" }));
    expect(result).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "team" });
    expect(JSON.stringify(result)).not.toContain("other.org"); expect(JSON.stringify(result)).not.toContain("display.name"); expect(Object.keys(result).sort()).toEqual(["loggedIn", "maskedEmail", "plan"]);
  });
  it("drops an address that does not fit, never truncating it into one that does", () => {
    for (const email of ["x".repeat(255) + "@example.com", "é@example.com", "a b@example.com", "a@b@example.com", "alice.fixture@exämple.com"]) {
      const result = parseClaudeAuthStatus(status({ email }));
      expect(result, email.slice(0, 20)).toEqual({ loggedIn: true, plan: "team" });
    }
  });
});

describe("one parser, written once", () => {
  it("is part of the Runtime bundle, and the capability is named", () => {
    expect(RUNTIME_BUNDLE_MODULES).toContain("claude-auth-status.js"); expect(ACCOUNT_IDENTITY_CAPABILITY).toBe("account-identity");
  });
  it("no other source file builds the `***@` form, and none matches the `loggedIn` field of `claude auth status` with a regular expression", () => {
    const masks: string[] = [], loggedIn: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (!["node_modules", "vendor"].includes(entry.name)) walk(path); continue; }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8"), name = path.replace(resolve("src") + "/", "");
      if (/\$\{[^}]*\}\*\*\*@|["'`]\*\*\*@/.test(text)) masks.push(name);   // a mask being BUILT (a template or a string ending in ***@), not a mention in a comment
      if (text.includes('"loggedIn":\\s')) loggedIn.push(name);   // a regular expression reading the CLI's answer, the thing this parser replaces
    } };
    walk(resolve("src"));
    expect(masks).toEqual(["claude-auth-status.ts"]);
    expect(loggedIn).toEqual([]);
  });
});

// The keys a real `claude auth status` printed (Claude Code 2.1.318, an account signed in on the WSL computer; the names only were recorded, never a value).
// The values here are fixtures on example.com.
const REAL_KEYS = ["analyticsDisabled", "apiProvider", "authMethod", "configDirectory", "email", "loggedIn", "loginExpiresAt", "orgId", "orgName", "planTier", "projectsDirectory", "storedClaudeAiLogin", "subscriptionType"];
const realStatus = (over: Record<string, unknown> = {}) => ({
  analyticsDisabled: false, apiProvider: "firstParty", authMethod: "claude.ai", configDirectory: "/home/fixture/.claude", email: "alice.fixture@example.com", loggedIn: true,
  loginExpiresAt: "2030-01-01T00:00:00.000Z", orgId: "00000000-0000-0000-0000-000000000000", orgName: "Fixture Org", planTier: "other", projectsDirectory: "/home/fixture/.claude/projects",
  storedClaudeAiLogin: true, subscriptionType: "max", ...over,
});
describe("the keys of a real `claude auth status`", () => {
  it("has exactly the fixture's keys, so the fixture below is the real shape", () => {
    expect(Object.keys(realStatus()).sort()).toEqual([...REAL_KEYS].sort());
  });
  it("every key the parser reads is one a real status has", () => {
    const source = readFileSync(resolve(__dirname, "../src/claude-auth-status.ts"), "utf8");
    const read = new Set([...source.matchAll(/\brow\.([A-Za-z]+)\b|\(value as Record<string, unknown>\)\.([A-Za-z]+)/g)].map(match => match[1] ?? match[2]));
    for (const key of ["loggedIn", "authMethod", "email", "subscriptionType"]) expect(read.has(key), `the parser reads ${key}`).toBe(true);
    const fromCli = [...read];
    for (const key of fromCli) expect(REAL_KEYS, `${key} is not a key of a real status`).toContain(key);
  });
  it("reads an account sign-in: e-mail and plan, from the real keys, and nothing else of the status", () => {
    const result = parseClaudeAuthStatus(JSON.stringify(realStatus()));
    expect(result).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "max" });
    const text = JSON.stringify(result);
    for (const private_ of ["Fixture Org", "00000000-0000", "/home/fixture"]) expect(text).not.toContain(private_);
  });
  it("reads each plan name as the plan the status names it", () => {
    for (const plan of ["free", "pro", "max", "team", "enterprise"]) expect(parseClaudeAuthStatus(JSON.stringify(realStatus({ subscriptionType: plan }))).plan).toBe(plan);
    expect(parseClaudeAuthStatus(JSON.stringify(realStatus({ subscriptionType: "Max " }))).plan).toBe("max");
    expect(parseClaudeAuthStatus(JSON.stringify(realStatus({ subscriptionType: "something_new" }))).plan).toBe("unknown");
  });
  it("reads an API-key sign-in and a signed-out status, with the same keys around them", () => {
    expect(parseClaudeAuthStatus(JSON.stringify(realStatus({ authMethod: "api_key", email: undefined, subscriptionType: undefined })))).toEqual({ loggedIn: true, apiKey: true });
    expect(parseClaudeAuthStatus(JSON.stringify(realStatus({ loggedIn: false, email: undefined, subscriptionType: undefined, storedClaudeAiLogin: false })))).toEqual({ loggedIn: false });
  });
  it("reads it with the CLI's text around it, as both streams are merged", () => {
    const text = `Checking...\n${JSON.stringify(realStatus(), null, 2)}\n`;
    expect(parseClaudeAuthStatus(text)).toEqual({ loggedIn: true, maskedEmail: "alice.fixture@example.com", plan: "max" });
  });
});
