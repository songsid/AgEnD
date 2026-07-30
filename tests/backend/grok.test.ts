import { describe, expect, it } from "vitest";
import { GrokBackend } from "../../src/backend/grok.js";

describe("GrokBackend intro logo skip", () => {
  const backend = new GrokBackend("/tmp/agend-grok-test");

  /** Braille X frame from a live stuck intro (ANSI stripped). No ready prompt. */
  const pureLogoPane =
    "⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀";

  /** Post-Enter welcome still shows the same braille art above the input box. */
  const welcomeWithPrompt = `
   ╭────────────────────────────────────────╮
   │  ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄   Grok Build Beta  0.2.112
   │  ⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀
   │  ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀   Grok 4.5 is here!
   │                   New worktree
   ╰────────────────────────────────────────╯
  ╭──────────────────────────────────────────╮
  │ ❯                                        │
  ╰─────────────────── Grok 4.5 (high) · always-approve ─╯
`;

  it("startup + runtime dialogs dismiss pure intro logo with Enter", () => {
    for (const dialogs of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const logo = dialogs.find(d => d.description.includes("intro logo"));
      expect(logo).toBeDefined();
      expect(logo!.keys).toEqual(["Enter"]);
      expect(logo!.pattern.test(pureLogoPane)).toBe(true);
    }
  });

  it("does not re-Enter when the welcome screen already has a prompt", () => {
    for (const dialogs of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const logo = dialogs.find(d => d.description.includes("intro logo"))!;
      expect(logo.pattern.test(welcomeWithPrompt)).toBe(false);
    }
  });

  it("ready pattern matches the post-logo prompt, not the pure logo", () => {
    const ready = backend.getReadyPattern();
    expect(ready.test(pureLogoPane)).toBe(false);
    expect(ready.test(welcomeWithPrompt)).toBe(true);
    expect(ready.test("Grok 4.5 (high)")).toBe(true);
  });

  it("still auto-approves workspace trust", () => {
    const trust = backend.getStartupDialogs().find(d => d.description.includes("trust"));
    expect(trust?.pattern.test("Do you trust the contents of this directory?")).toBe(true);
    expect(trust?.keys).toEqual(["y"]);
  });
});
