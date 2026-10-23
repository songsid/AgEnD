/**
 * Office review (#2399 carry, Fable's surviving mutant): a write that awaits its request body asks again, once the body
 * is in, whether the request may still go on (`permitWebContinuation`: a public-link session revoked meanwhile, a
 * Settings execution cancelled). On some routes the public link is refused before the body and no Settings execution can
 * reach them, so dropping the call changes no answer — an equivalent mutant no request can catch. So this pins it where
 * it is written: every body read in src/web-api.ts is followed by the check, directly or through the route's `again()`,
 * and every `again` asks it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src", "web-api.ts"), "utf8");

/** Each body read (not the helper that does it) whose next lines neither check nor call again(): `line: text`. */
export function unchecked(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!/\bawait (?:parseBody|readBoundedWebBody)\(req\b/.test(line)) return;
    if (/^\s*return JSON\.parse\(\(await readBoundedWebBody\(req/.test(line)) return;          // parseBody itself
    const next = lines.slice(i, i + 4).join("\n");
    if (!/permitWebContinuation\(req, res, ctx\)|\bagain\(\)/.test(next)) out.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  return out;
}
/** Each `const again = …` whose body does not ask permitWebContinuation. */
export function againWithoutCheck(src: string): string[] {
  const lines = src.split("\n");
  return lines.flatMap((line, i) => (/\bconst again = /.test(line) && !/permitWebContinuation\(/.test(lines.slice(i, i + 4).join("\n")) ? [`${i + 1}: ${line.trim()}`] : []));
}

describe("every write that awaits its body asks again whether it may go on", () => {
  it("each body read in web-api.ts is followed by permitWebContinuation (or the route's again())", () => {
    expect(SRC.match(/\bawait (?:parseBody|readBoundedWebBody)\(req\b/g)!.length).toBeGreaterThan(20);
    expect(unchecked(SRC)).toEqual([]);
  });
  it("each again() asks permitWebContinuation", () => {
    expect(SRC.match(/\bconst again = /g)!.length).toBeGreaterThan(1);
    expect(againWithoutCheck(SRC)).toEqual([]);
  });
  it("the PUT /ui/offices check is one of them (the mutant Fable found survives no more)", () => {
    const mutant = SRC.replace(/(try \{ body = await parseBody\(req\); \} catch \{ json\(res, 400, \{ error: "Invalid JSON" \}\); return; \}\n\s*)if \(!permitWebContinuation\(req, res, ctx\)\) return;\n(\s*const now = who\(\);\n\s*if \("status" in now\))/, "$1$2");
    expect(mutant).not.toBe(SRC);
    expect(unchecked(mutant).length).toBe(1);
  });
});
