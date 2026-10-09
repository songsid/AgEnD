import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The allowlist is judged by gitleaks in CI, which these tests cannot run. What
 * they can pin is the shape that makes it safe: the regex is matched against the
 * finding's own `match` text (not the whole line), and it accepts only the
 * Sec-WebSocket-Key header field carrying a 16-byte nonce.
 *
 * The accepted strings below are the `Match` values real gitleaks 8.24.3/8.25.0
 * reported for those fixtures (note the stray leading "n" and the trailing literal
 * backslash-r in the first one). Secrets are generated at run time so this file
 * has no high-entropy literal of its own for the scan to trip on.
 */
const toml = readFileSync(join(process.cwd(), ".gitleaks.toml"), "utf-8");
const target = /^regexTarget = "(\w+)"$/m.exec(toml)?.[1];
/** Every pattern in the `regexes = [ … ]` array, one triple-quoted literal each (single- or multi-line array). */
const regexesBlock = /^regexes = \[([\s\S]*?)\]$/m.exec(toml)?.[1] ?? "";
const patterns = [...regexesBlock.matchAll(/'''(.+?)'''/g)].map(m => m[1]!);
// RE2's (?i) prefix is JS's "i" flag; the rest of the pattern is common syntax.
const compile = (pattern: string) => (pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "i") : new RegExp(pattern));
const source = patterns.find(p => /sec-websocket-key/i.test(p)) ?? "";
const nonceField = source ? compile(source) : /(?!)/;

const NONCE = "dGhlIHNhbXBsZSBub25jZQ=="; // RFC 6455 section 1.3 example
const secret = (n: number): string => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);
const apiKey = ["api", "key"].join("_");

describe(".gitleaks.toml Sec-WebSocket-Key allowlist", () => {
  it("is matched against the finding's match, never the whole line", () => {
    expect(target).toBe("match");
    expect(source).not.toBe("");
  });

  it("uses the single [allowlist] table that the pinned gitleaks 8.24.3 applies", () => {
    expect(toml).toMatch(/^\[allowlist\]$/m);
    expect(toml).not.toMatch(/^\[\[allowlists\]\]/m);
  });

  it("lets a WebSocket handshake nonce through in every shape gitleaks reports it", () => {
    for (const match of [
      "nSec-WebSocket-Key: " + NONCE + "\\r",
      'sec-websocket-key": "' + NONCE + '"',
      'Sec-WebSocket-Key: "' + NONCE + '"',
      "Sec-WebSocket-Key: " + NONCE,
      "SEC-WEBSOCKET-KEY=" + NONCE,
    ]) {
      expect(nonceField.test(match), match).toBe(true);
    }
  });

  it("still reports a real key that shares a line with the header name", () => {
    const real = secret(32);
    for (const match of [
      `${apiKey}: "${real}"`,                  // x = { api_key: "…" }; // Sec-WebSocket-Key
      `${apiKey} = "${real}"`,                 // next to a real header on the same line
      "sk_live_" + secret(28),                 // a Stripe-shaped key with the header in a comment
      `${apiKey}="${real}"; // Sec-WebSocket-Key`,
    ]) {
      expect(nonceField.test(match), match).toBe(false);
    }
  });

  it("does not accept a secret merely filed under the header's name", () => {
    expect(nonceField.test("Sec-WebSocket-Key: " + secret(32))).toBe(false);            // wrong length
    expect(nonceField.test("Sec-WebSocket-Key: " + secret(22) + "==" + secret(8))).toBe(false); // trailing payload
    expect(nonceField.test("Sec-WebSocket-Key: " + secret(24))).toBe(false);            // not a 16-byte nonce
    // A longer value that is still correctly "=="-padded base64 (25 bytes -> 36 chars): the
    // real nonce is exactly 16 bytes, so this is a secret and has to be reported.
    expect(nonceField.test("Sec-WebSocket-Key: " + randomBytes(25).toString("base64"))).toBe(false);
    expect(nonceField.test("Sec-WebSocket-Key: ")).toBe(false);
  });
});

/**
 * #1450: the nodejs/release-keys commit the runtime build pins its keyring to is a public 40-hex git SHA. gitleaks'
 * generic-api-key fires on "KEYS" in the constant's name; the allowlist takes exactly that constant with a 40-hex value.
 */
describe(".gitleaks.toml release-keys commit allowlist", () => {
  const releaseKeys = patterns.find(p => p.includes("RELEASE_KEYS_COMMIT"));
  const allowed = releaseKeys ? compile(releaseKeys) : /(?!)/;
  const hex = (n: number) => randomBytes(n).toString("hex").slice(0, n);

  it("is one of the match-target regexes, next to the WebSocket and token-env-name ones", () => {
    expect(releaseKeys).toBeDefined();
    expect(patterns).toHaveLength(3);
  });

  it("allows only RELEASE_KEYS_COMMIT with a 40-hex value", () => {
    expect(allowed.test(`RELEASE_KEYS_COMMIT = "${hex(40)}"`)).toBe(true);
  });

  it.each([
    ["a non-hex value under the name", () => `RELEASE_KEYS_COMMIT = "${secret(40)}"`],
    ["a hex value of another length", () => `RELEASE_KEYS_COMMIT = "${hex(64)}"`],
    ["the same hex under another name", () => `${apiKey} = "${hex(40)}"`],
    ["the constant followed by more text", () => `RELEASE_KEYS_COMMIT = "${hex(40)}"; ${apiKey} = "${secret(32)}"`],
    ["a lower-case look-alike name", () => `release_keys_commit = "${hex(40)}"`],
  ])("still reports %s", (_name, match) => {
    expect(allowed.test(match())).toBe(false);
  });
});

describe(".gitleaks.toml token env NAME allowlist (#1519)", () => {
  const tokenEnv = patterns.find(p => p.startsWith("token_env"));
  const allowed = tokenEnv ? compile(tokenEnv) : /(?!)/;

  it("lets the name of a token's env var through, as gitleaks 8.24.3 reported it", () => {
    expect(tokenEnv).toBeDefined();
    // The Match value of the real finding (tests/hot-add-connection-1519.test.ts:20), and the shapes fleet.yaml uses.
    for (const match of ['bot_token_env: "AGEND_TEST_P6_PRIMARY"', 'bot_token_env: "AGEND_DISCORD_2_TOKEN"', "bot_token_env: AGEND_TELEGRAM_TOKEN", 'token_env": "TG_MAIN"']) {
      expect(allowed.test(match), match).toBe(true);
    }
  });

  it.each([
    ["a token under the name's key", () => `bot_token_env: "${secret(40)}"`],
    ["an upper-case key with no underscore (AWS-shaped)", () => `bot_token_env: "AKIA${secret(16).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}"`],
    ["a Telegram-shaped token", () => `bot_token_env: "123456:${secret(35)}"`],
    ["the name followed by a real key", () => `bot_token_env: "AGEND_X_TOKEN", ${apiKey}: "${secret(32)}"`],
    ["the same value under another key", () => `${apiKey}: "AGEND_TEST_P6_PRIMARY"`],
  ])("still reports %s", (_name, match) => {
    expect(allowed.test(match())).toBe(false);
  });
});
