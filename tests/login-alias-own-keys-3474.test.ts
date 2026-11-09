/**
 * #3474, M-2716 (Fable, #3471 review): `/login <backend>` looks the typed word up in LOGIN_BACKEND_ALIASES, and falls back to
 * the word itself for LOGIN_FLOWS. Both were plain objects, so `/login __proto__` resolved to Object.prototype and
 * `/login constructor` to the Object function — an inherited property taken as a backend. Own keys only now.
 */
import { describe, expect, it } from "vitest";
import { LOGIN_BACKEND_ALIASES, LOGIN_FLOWS } from "../src/login-flows.js";
import { admitProfileLogin } from "../src/login-controller.js";

const INHERITED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("M-2716: /login backend words resolve own keys only", () => {
  it("no inherited property is an alias or a flow", () => {
    for (const word of INHERITED) {
      expect(LOGIN_BACKEND_ALIASES[word], word).toBeUndefined();
      expect(LOGIN_FLOWS[word], word).toBeUndefined();
    }
  });

  it("the real aliases and flows are unchanged", () => {
    expect({ ...LOGIN_BACKEND_ALIASES }).toEqual({ claude: "claude-code", "claude-code": "claude-code", codex: "codex", grok: "grok",
      kiro: "kiro-cli", "kiro-cli": "kiro-cli", agy: "antigravity", antigravity: "antigravity", opencode: "opencode" });
    for (const name of ["claude-code", "codex", "kiro-cli", "antigravity"]) expect(LOGIN_FLOWS[name]?.backend ?? name, name).toBe(name);
  });

  it("`/login __proto__ <profile>` and `/login constructor <profile>` are a refusal about that word, not an inherited object", () => {
    for (const word of ["__proto__", "constructor"]) {
      const r = admitProfileLogin(word, "work");
      expect("refusal" in r, word).toBe(true);
      expect((r as { refusal: string }).refusal, word).toContain(word);
    }
  });
});
