/**
 * Icon parity guard: website/public icons must be identical to the dashboard
 * source at src/ui/icons. Run this in CI to catch drift before it ships.
 *
 * To update the icons: copy from src/ui/icons/ to website/public/ and
 * website/src/assets/logo.svg, then commit all three together.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}

describe("website icons match dashboard source (drift guard)", () => {
  it("website/public/favicon.svg === src/ui/icons/favicon.svg", () => {
    expect(sha256("website/public/favicon.svg")).toBe(sha256("src/ui/icons/favicon.svg"));
  });

  it("website/public/favicon.ico === src/ui/icons/favicon.ico", () => {
    expect(sha256("website/public/favicon.ico")).toBe(sha256("src/ui/icons/favicon.ico"));
  });

  it("website/public/apple-touch-icon.png === src/ui/icons/apple-touch-icon.png", () => {
    expect(sha256("website/public/apple-touch-icon.png")).toBe(sha256("src/ui/icons/apple-touch-icon.png"));
  });

  it("website/src/assets/logo.svg === src/ui/icons/favicon.svg", () => {
    // The Starlight logo asset is a copy of the dashboard's favicon.
    expect(sha256("website/src/assets/logo.svg")).toBe(sha256("src/ui/icons/favicon.svg"));
  });
});
