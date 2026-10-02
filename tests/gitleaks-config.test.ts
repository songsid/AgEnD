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
const source = /^regexes = \['''(.+)'''\]$/m.exec(toml)?.[1] ?? "";
// RE2's (?i) prefix is JS's "i" flag; the rest of the pattern is common syntax.
const nonceField = new RegExp(source.replace(/^\(\?i\)/, ""), "i");

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
