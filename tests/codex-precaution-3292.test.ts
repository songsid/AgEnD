import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { codexPrecaution } from "../src/backend/codex-precaution.js";
import { remoteCardPrompt } from "../src/remote-card-prompt.js";
import { answerRemoteCard, type RemoteCardIo } from "../src/remote-card-answer.js";
import { setLocale } from "../src/locale.js";
import { CodexBackend } from "../src/backend/codex.js";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex-0169-precaution-${name}.pane.txt`, import.meta.url), "utf8");
const backend = () => Object.assign(Object.create(CodexBackend.prototype), { configuredStatusLineItems: ["context-remaining"], configuredStatusLinePattern: undefined }) as CodexBackend;
const cases = ["root", "stopped", "confirm", "disabled", "narrow", "pager", "overlap"];
describe("Codex 0.169 precaution screens", () => {
  it.each(cases)("holds %s without automatic keys and emits a neutral card", name => {
    const pane = fixture(name), b = backend();
    for (const dialogs of [b.getStartupDialogs(), b.getRuntimeDialogs()]) {
      const dialog = dialogs.find(d => d.description.includes("safety review") && d.isActive?.(pane));
      expect(dialog).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
      const card = dialog!.remoteCard!(pane)!;
      expect(card).toMatchObject({ kind: "question", noSkip: true, freeText: false });
      expect(JSON.stringify(card)).not.toMatch(/synthetic demonstration|Synthetic findings|stale draft|terminal text/);
    }
    expect(b.isDeliveryInputReadyPane(pane)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(pane)).toBe(false);
  });
});

it.each(cases)("accepts ANSI %s with the same private identity", name => {
  const plain = fixture(name), ansi = plain.split("\n").map(r => `\x1b[2m${r}\x1b[0m`).join("\n");
  expect(codexPrecaution(ansi)).toEqual(codexPrecaution(plain));
});
it("offers only the owner-approved choices, retaining physical rows and no disabled acknowledgement", () => {
  const titles = (name: string) => codexPrecaution(fixture(name))!.card.options.map(o => o.title);
  expect(titles("root")).toEqual(["Review findings"]);
  expect(titles("stopped")).toEqual([]);
  expect(titles("confirm")).toEqual(["Acknowledge and continue", "Back"]);
  expect(titles("disabled")).toEqual(["Back"]);
  expect(titles("pager")).toEqual(["Back"]);
  expect(codexPrecaution(fixture("disabled"))!.card.options[0].row).toBe(1);
  for (const name of cases) {
    const prompt = remoteCardPrompt("demo-agent", codexPrecaution(fixture(name))!.card);
    expect(JSON.stringify(prompt)).not.toMatch(/New chat|Resume another|Agent command center|synthetic demonstration|Synthetic findings/);
    expect(prompt.webInput).toBeNull();
  }
});
it("distinguishes live menus from transcript quotes, incomplete rows, altered options and extra chrome", () => {
  for (const name of cases) {
    expect(codexPrecaution(fixture(name) + "\n› Ask Codex to do anything\n  Context 80% left")).toBeNull();
    expect(codexPrecaution(fixture(name) + "\n• Working (2s · esc to interrupt)")).toBeNull();
  }
  for (const pane of [fixture("confirm").replace("Back", "Another action"), fixture("root").replace("Review findings", "Review something"),
    fixture("confirm").replace("2. Back", "3. Back"), fixture("confirm").replace("›", " "),
    fixture("pager").replace("q close", "esc close"), fixture("confirm") + "\n  3. Extra option"])
    expect(codexPrecaution(pane)).toBeNull();
});
it("keeps cursor motion stable but fences a changed private report or enabled state", () => {
  const pane = fixture("confirm"), moved = pane.replace("› 1.", "  1.").replace("  2. Back", "› 2. Back");
  expect(codexPrecaution(moved)?.card.identity).toBe(codexPrecaution(pane)?.card.identity);
  expect(codexPrecaution(fixture("disabled"))?.card.identity).not.toBe(codexPrecaution(pane)?.card.identity);
  expect(codexPrecaution(fixture("pager").replace("Synthetic findings", "Changed findings"))?.card.identity).not.toBe(codexPrecaution(fixture("pager"))?.card.identity);
});
function driver(start: string, disabled = false) {
  let pane = start, time = 0;
  const keys: string[] = [];
  const io: RemoteCardIo = { locked: fn => fn(), read: async () => pane, paste: async () => { throw Error("No paste"); },
    now: () => time, sleep: async ms => { time += ms; }, key: async key => {
      keys.push(key);
      if (key === "q") pane = fixture("confirm");
      else if (key === "Up" && !disabled) pane = pane.replace("  1. Acknowledge", "› 1. Acknowledge").replace("› 2. Back", "  2. Back");
      else if (key === "Down" && !disabled) pane = pane.replace("› 1. Acknowledge", "  1. Acknowledge").replace("  2. Back", "› 2. Back");
      else if (key === "Enter") pane = "ordinary composer";
      return true;
    } };
  return { io, keys, change: (next: string) => { pane = next; }, read: (p: string) => codexPrecaution(p)?.card ?? null };
}
it("walks the verified cursor then uses Enter; never a digit or an automatic acknowledgement", async () => {
  const pane = fixture("confirm").replace("› 1.", "  1.").replace("  2. Back", "› 2. Back"), h = driver(pane);
  const id = codexPrecaution(pane)!.card.identity;
  expect(h.keys).toEqual([]);
  expect(await answerRemoteCard(h.io, h.read, id, { kind: "option", n: 1 })).toEqual({ outcome: "answered" });
  expect(h.keys).toEqual(["Up", "Enter"]);
});
it("closes the report with q and keys Back on a disabled confirmation's actual row", async () => {
  for (const [name, want] of [["pager", "q"], ["disabled", "Enter"]]) {
    const pane = fixture(name), h = driver(pane, true);
    expect(await answerRemoteCard(h.io, h.read, codexPrecaution(pane)!.card.identity, { kind: "option", n: 1 })).toEqual({ outcome: "answered" });
    expect(h.keys).toEqual([want]);
  }
});
it("refuses stale, hidden, skip and disabled-ack actions without any keys", async () => {
  for (const name of ["root", "disabled", "stopped"]) {
    const pane = fixture(name), h = driver(pane);
    const id = codexPrecaution(pane)!.card.identity;
    expect((await answerRemoteCard(h.io, h.read, id, { kind: "option", n: 2 })).outcome).toBe("refused");
    expect((await answerRemoteCard(h.io, h.read, id, { kind: "skip" })).outcome).toBe("refused");
    h.change(fixture("pager"));
    expect((await answerRemoteCard(h.io, h.read, id, { kind: "option", n: 1 })).outcome).toBe("stale");
    expect(h.keys).toEqual([]);
  }
});
it("stops if moving onto acknowledgement is disabled or the request changes under the lock", async () => {
  const pane = fixture("confirm").replace("› 1.", "  1.").replace("  2. Back", "› 2. Back"), h = driver(pane, true);
  expect((await answerRemoteCard(h.io, h.read, codexPrecaution(pane)!.card.identity, { kind: "option", n: 1 })).outcome).toBe("stopped");
  expect(h.keys).toEqual(["Up"]);
  const changed = driver(pane);
  changed.io.locked = async fn => { changed.change(fixture("disabled")); return fn(); };
  expect((await answerRemoteCard(changed.io, changed.read, codexPrecaution(pane)!.card.identity, { kind: "option", n: 1 })).outcome).toBe("stopped");
  expect(changed.keys).toEqual([]);
});
it("localises only the neutral summary and actions", () => {
  try { setLocale("zh-TW"); const card = codexPrecaution(fixture("confirm"))!.card;
    expect(card.question).toContain("安全審查"); expect(card.options[0].title).toBe("確認並繼續");
  } finally { setLocale("en"); }
});

it.each(["root", "stopped", "disabled"])("holds a narrow %s menu when long choices wrap", name => {
  const pane = fixture(name).replace("Agent command center", "Agent command\n     center")
    .replace("Resume another chat", "Resume another\n     chat")
    .replace("Acknowledge findings and continue", "Acknowledge findings\n       and continue");
  expect(codexPrecaution(pane)?.stage).toBe(name === "disabled" ? "confirmation" : name);
});
