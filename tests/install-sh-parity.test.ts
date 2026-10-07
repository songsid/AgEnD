/**
 * #1296: website/public/install.sh must stay in sync with install.sh.
 *
 * The website copy was missing the shell-completion block (lines 248-262 in
 * the repo root). This test locks the two files to identical content so no
 * future edit can silently add/remove a feature in one but not the other.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("install.sh parity (#1296)", () => {
  it("website/public/install.sh is identical to install.sh", () => {
    const root = join(import.meta.dirname, "..");
    const repo = readFileSync(join(root, "install.sh"), "utf-8");
    const website = readFileSync(join(root, "website", "public", "install.sh"), "utf-8");
    expect(website).toBe(repo);
  });
});
