/**
 * PR #3553 review (P2 3): the session menu's controls and the revoke card's button are phone tap targets (style guide rule 7: the
 * shared --tap token, 44px), in the phone block of app.css, not one-off sizes or inline styles; and one kind of button has one height
 * (the UI gate's `buttons` check: Revoke 36px beside Sign out everywhere 44px failed `phone-dark-zh-TW:access:buttons`).
 * The real measurement is the UI gate (scripts/manual/smoke/smoke-settings-ui-gate.mts) and the PR's Chromium numbers; this keeps the
 * rules from being dropped, and keeps Re-bind off `.btn-sm` (`.webauth-chip .btn-sm` is 24px) so a stylesheet that is older than the
 * script still gives it the shared `.btn` height.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "..", "src", "ui", "shared", "app.css"), "utf8");
const AUTHORIZE = readFileSync(join(__dirname, "..", "src", "ui", "shared", "web-authorize.js"), "utf8");
const SESSION = readFileSync(join(__dirname, "..", "src", "ui", "shared", "app-session.js"), "utf8");
/** The text of every phone/touch `@media (max-width: 600px|899px) { … }` block (brace-matched). */
function phoneBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@media \(max-width: (?:600|899)px\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}
const phone = phoneBlocks(CSS).join("\n");
const rulesFor = (needle: RegExp) => [...phone.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => needle.test(m[1]!)).map((m) => m[2]!);

describe("PR #3553 review: phone tap targets are the shared --tap token", () => {
  it("the session menu's buttons and code box are --tap on a phone", () => {
    const decls = rulesFor(/\.pop\s+:is\(/).join(";");
    expect(decls).toMatch(/min-height:\s*var\(--tap\)/);
    expect(rulesFor(/\.pop\s+:is\([^)]*\.btn[^)]*\.field input|\.pop\s+:is\([^)]*\.field input[^)]*\.btn/).length).toBeGreaterThan(0);
  });
  it("the Web authority card's button is --tap with the Devices card's (one danger-button height on the page)", () => {
    const sel = [...phone.matchAll(/([^{}]+)\{([^{}]*min-height:\s*var\(--tap\)[^{}]*)\}/g)].map((m) => m[1]!).join(",");
    expect(sel).toMatch(/\.s-devices \.save-row \.btn/);
    expect(sel).toMatch(/\.s-web-authority \.save-row \.btn/);
  });
  it("Re-bind and Bind use the shared .btn (not .btn-sm, whose chip rule is 24px) and the code box is the shared .field input — no inline style", () => {
    const rebind = AUTHORIZE.slice(AUTHORIZE.indexOf("export function Rebind"), AUTHORIZE.indexOf("function body(a)"));
    expect(rebind).not.toMatch(/btn-sm/);
    expect(rebind).toMatch(/class="btn webauth-rebind"/);
    expect(rebind).toMatch(/class="field webauth-rebind-field"/);
    expect(rebind).not.toMatch(/style=/);
    expect(SESSION).not.toMatch(/style=/);
  });
});
