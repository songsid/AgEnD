/**
 * The typed one-time code, as a primitive.
 *
 * Shared by the pre-fleet setup page (`setup-auth.ts`) and the dashboard login
 * (`web-login.ts`). What is shared is only what has no policy in it: the
 * alphabet, how a code is generated, shown and read back, and how two strings
 * are compared. Attempt budgets, lifetimes and what a redeemed code is *worth*
 * differ between the two and stay with their owners — the setup page burns
 * itself on the fifth failure, a long-lived fleet must not.
 */
import { randomInt, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32, minus nothing: the digits 0/1 are absent from it already. */
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const ONE_TIME_CODE_LENGTH = 8;

export function generateOneTimeCode(): string {
  let code = "";
  for (let i = 0; i < ONE_TIME_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** `ABCD-EFGH` — a shape that survives being read aloud and retyped. */
export function formatOneTimeCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the person typed, as the code it was meant to be.
 *
 * Case and the dash are presentation. Rejecting `abcd efgh` would be rejecting
 * a correct answer, and the person retyping it has no idea which detail was
 * wrong — so they spend attempts on formatting.
 */
export function normalizeOneTimeCode(input: string): string {
  return input.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * Fixed-length constant-time compare.
 *
 * Both sides are padded to the same length first: `timingSafeEqual` throws on a
 * mismatch, and returning early on one leaks the length through timing.
 */
export function constantTimeMatches(provided: string, expected: string): boolean {
  const width = Math.max(provided.length, expected.length, 1);
  const a = Buffer.alloc(width);
  const b = Buffer.alloc(width);
  a.write(provided, "utf8");
  b.write(expected, "utf8");
  return timingSafeEqual(a, b) && provided.length === expected.length;
}
