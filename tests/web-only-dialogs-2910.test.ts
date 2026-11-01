/**
 * #2910 D4: on a web-only fleet, a Claude Code or Codex dialog AgEnD holds for a person (a Bash or tool permission, a
 * trust / Bypass screen it did not recognise, "Background work is running", "Switch model?", Codex's selections, any
 * numbered prompt the #1691 catch-all holds) is put to the dashboard as a #2675 card: its own options as buttons, keyed
 * in on a verified cursor. Never Esc (on Claude's trust screen it exits the CLI). A chat fleet is unchanged (its parked
 * notice and General's controls). A shell prompt (sudo, password) on a web-only fleet with no General is a Notice
 * pointing at the agent's View. Real pane fixtures; the answer walk on a scripted pane; the fleet's gate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectionCard } from "../src/selection-card.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { remoteCardPrompt } from "../src/remote-card-prompt.js";
import { answerRemoteCard, type RemoteCardIo } from "../src/remote-card-answer.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { setLocale } from "../src/locale.js";
import type { RemoteQuestionCard } from "../src/backend/types.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
afterEach(() => {
  for (const fm of fleets.splice(0)) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8");

describe("#2910 D4 the card read from a CLI's own dialog", () => {
  it("Claude Bash permission (an option wrapped over two rows): its words, the command, every option; the cursor; no Esc", () => {
    const card = selectionCard(fixture("claude-2.1.291-bash-permission-prompt-wrapped.pane.txt"), "Claude Code")!;
    expect([card.kind, card.title, card.page, card.cursor, card.freeText, card.noSkip, card.webOnly]).toEqual(["question", "Claude Code", "options", 0, false, true, true]);
    expect(card.question.split("\n")).toEqual(["Bash command", "Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below", "Create a marker file", "touch perm-probe.txt", "Do you want to proceed?"]);
    expect(card.options.map(o => [o.n, o.title.slice(0, 40)])).toEqual([[1, "Yes"], [2, "Yes, and always allow access to /home/us"], [3, "Yes, and switch to auto mode · auto mode"], [4, "No"]]);
    expect(card.options[1]!.title.endsWith("from this project")).toBe(true);                   // its second row joined
  });
  it.each([
    ["claude-2.1.291-background-work-exit.pane.txt", "Claude Code", ["Exit and stop tasks", "Move to background and exit", "Stay"], /^Background work is running\nThe following will stop when you exit:\nshell · sleep 900$/],
    ["claude-2.1.296-switch-model-opus.pane.txt", "Claude Code", ["Yes, switch to Opus 5.5", "No, go back"], /^Switch model\?\nYour next response will be slower/],
    ["codex-0160-resume-cwd-picker.pane.txt", "Codex", ["Use session directory (/home/user/project-b)", "Use current directory (/home/user/project)", "Always use session directory", "Always use current directory"], /^Working directory · resume\nSession = latest cwd recorded in the resumed session\nCurrent = your current working directory$/],
    ["codex-0156-trust-narrow.pane.txt", "Codex", ["Trust and continue", "Quit"], /Trust this folder\? Codex can read, edit, and run files here/],
  ])("%s", (file, title, options, question) => {
    const card = selectionCard(fixture(file), title)!;
    expect([card.options.map(o => o.title), card.cursor, question.test(card.question)], card.question).toEqual([options, 0, true]);
  });
  it("a countdown in the dialog's words never makes it another card", () => {
    const at = (n: number) => `\n────────────────────\n Do you want to proceed? (auto-deny in ${n}s)\n ❯ 1. Yes\n   2. No\n`;
    expect(selectionCard(at(30), "x")!.identity).toBe(selectionCard(at(29), "x")!.identity);
  });
  it("the same card wherever the cursor is (identity is what is asked); another question is another card", () => {
    const pane = fixture("claude-2.1.291-background-work-exit.pane.txt");
    const moved = pane.replace("❯ 1. Exit", "  1. Exit").replace("  2. Move", "❯ 2. Move");
    const a = selectionCard(pane, "Claude Code")!, b = selectionCard(moved, "Claude Code")!;
    expect([b.cursor, b.identity === a.identity, selectionCard(pane.replace("sleep 900", "sleep 901"), "Claude Code")!.identity === a.identity]).toEqual([1, true, false]);
  });
  it("a dialog with no border (Codex) ends at a double blank row: the transcript above it is not its words", () => {
    const pane = "• I looked at the repo and found the secret token abc\n\n\n  Working directory · resume\n  Session = latest cwd\n\n› 1. Use session directory\n  2. Use current directory\n";
    expect(selectionCard(pane, "Codex")!.question).toBe("Working directory · resume\nSession = latest cwd");
  });
  it("not a dialog: a numbered list in the transcript above the composer, a list with no cursor, one option, a long footer, numbers that skip", () => {
    expect(selectionCard("Pick:\n❯ 1. a\n  3. b\n", "x")).toBeNull();
    const transcript = "Here is the plan:\n❯ 1. Read the file\n  2. Fix it\n\nThen I will report.\nMore text\nAnd more\n\n> \n";
    expect([selectionCard(transcript, "x"), selectionCard("Pick:\n  1. a\n  2. b\n", "x"), selectionCard("Pick:\n❯ 1. only\n", "x"),
      selectionCard("Pick:\n❯ 1. a\n  2. b\nf1\nf2\nf3\nf4\n", "x")]).toEqual([null, null, null, null]);
  });
  it("the backends offer it on the dialogs they hold — never on the Codex sign-in screen", () => {
    const claude = new ClaudeCodeBackend(temp("agend-2910-cc-")).getRuntimeDialogs();
    const permission = claude.find(d => /Claude Bash permission/.test(d.description))!;
    expect((permission.remoteCard?.(fixture("claude-2.1.291-bash-permission-prompt-wrapped.pane.txt")) as RemoteQuestionCard | null)?.options.length).toBe(4);
    for (const what of [/Background work is running/, /model\/effort switch/, /trust\/Bypass Permissions screen \(unrecognised shape\)/, /trust dialog \(unrecognised cursor\)/, /Bypass Permissions warning \(unrecognised cursor\)/]) {
      expect(claude.find(d => what.test(d.description))?.remoteCard, String(what)).toBeTypeOf("function");
    }
    // Every dialog that carries a card is one AgEnD holds (never answered by the scanner).
    expect(claude.filter(d => d.remoteCard).every(d => d.holdOnly === true && d.keys.length === 0)).toBe(true);
    const codex = new CodexBackend(temp("agend-2910-cx-")).getRuntimeDialogs();
    const selection = codex.find(d => /interactive selection needs human input/.test(d.description))!;
    // The sign-in screen with a `›` cursor (as a later version may draw it) is still never a card…
    const signin = fixture("codex-0156-signin.pane.txt").replace("> 1. Sign in with ChatGPT", "› 1. Sign in with ChatGPT").replace(/\n\n  ([23])\. /g, "\n  $1. ");
    expect(selection.remoteCard?.(signin)).toBeNull();
    expect(selectionCard(signin, "Codex")).not.toBeNull();                            // control: the shape alone would read as one
    expect([(selection.remoteCard?.(fixture("codex-0160-resume-cwd-picker.pane.txt")) as RemoteQuestionCard | null)?.options.length, selection.remoteCard?.(fixture("codex-0156-signin.pane.txt"))])
      .toEqual([4, null]);
    expect(codex.filter(d => d.remoteCard).every(d => d.holdOnly === true && d.keys.length === 0)).toBe(true);
    expect(codex.filter(d => d.remoteCard).map(d => d.description).length).toBe(5);
  });
});

describe("#2910 D4 the #1691 catch-all (a numbered prompt no table knows — Claude's Edit / Write / MCP permission menus)", () => {
  it("offers the prompt as a card titled with the instance's CLI; a yes/no prompt is not one", () => {
    const dir = temp("agend-2910-d-");
    const make = (backend: string) => new Daemon("worker", { working_directory: dir, backend, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, false, { binaryName: backend, getRuntimeDialogs: () => [], getErrorPatterns: () => [] } as any, undefined,
      { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any) as any;
    const edit = "\n─────────────────────────────\n Edit file\n src/app.ts\n Do you want to make this edit to app.ts?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session\n   3. No\n\n Esc to cancel\n";
    const claude = make("claude-code").unrecognisedPromptDialog.remoteCard(edit) as RemoteQuestionCard;
    expect([claude.title, claude.question, claude.options.map(o => o.title), claude.noSkip, claude.webOnly])
      .toEqual(["Claude Code", "Edit file\nsrc/app.ts\nDo you want to make this edit to app.ts?", ["Yes", "Yes, allow all edits during this session", "No"], true, true]);
    expect([make("codex").unrecognisedPromptDialog.remoteCard(edit).title, make("mystery").unrecognisedPromptDialog.remoteCard(edit).title, make("codex").unrecognisedPromptDialog.remoteCard("Overwrite? [y/n]")])
      .toEqual(["Codex", "CLI", null]);
  });
});

describe("#2910 D4 put to the person: its options only; Esc refused", () => {
  it("the buttons are the dialog's options (no Skip); the message says it is keyed in, and where else to answer", () => {
    setLocale("en");
    const card = selectionCard(fixture("claude-2.1.291-background-work-exit.pane.txt"), "Claude Code")!;
    const p = remoteCardPrompt("agent-1", card);
    expect([p.choices.map(c => c.action), p.webInput]).toEqual([["opt-1", "opt-2", "opt-3"], null]);
    expect(p.message.split("\n").at(-1)).toBe("Choose one below — it is keyed into the agent's terminal as you chose. Or answer it yourself in its View.");
    // A kiro question card keeps its Skip (unchanged).
    const kiro = { ...card, noSkip: undefined, webOnly: undefined } as RemoteQuestionCard;
    expect(remoteCardPrompt("agent-1", kiro).choices.at(-1)?.action).toBe("skip");
  });
  it("answered on a verified cursor: Down to option 3, Enter, the dialog closes; a skip is refused with no key", async () => {
    const base = fixture("claude-2.1.291-background-work-exit.pane.txt");
    const at = (n: number) => base.replace("❯ 1. Exit", "  1. Exit").replace(`  ${n}. `, `❯ ${n}. `).replace("❯ 1. Exit", "❯ 1. Exit");
    const screens = { cursor: 1, closed: false };
    const keys: string[] = [];
    const pane = () => (screens.closed ? "\n> \n" : screens.cursor === 1 ? base : at(screens.cursor));
    const io: RemoteCardIo = {
      locked: fn => fn(), read: async () => pane(), sleep: async () => {}, now: (() => { let t = 0; return () => (t += 10); })(), paste: async () => false,
      key: async key => { keys.push(key); if (key === "Down") screens.cursor++; if (key === "Up") screens.cursor--; if (key === "Enter") screens.closed = true; return true; },
    };
    const read = (p: string) => selectionCard(p, "Claude Code");
    const identity = read(base)!.identity;
    expect(await answerRemoteCard(io, read, identity, { kind: "skip" })).toEqual({ outcome: "refused", reason: "this dialog's Esc is not a skip" });
    expect(keys).toEqual([]);
    expect(await answerRemoteCard(io, read, identity, { kind: "option", n: 3 })).toEqual({ outcome: "answered" });
    expect(keys).toEqual(["Down", "Down", "Enter"]);
  });
});

describe("#2910 D4 the fleet: only a web-only fleet puts it to people", () => {
  function fleet(config: Record<string, unknown> = {}) {
    const dir = temp("agend-2910-dlg-");
    vi.stubEnv("AGEND_HOME", dir);
    const fm = new FleetManager(dir); fleets.push(fm);
    fm.fleetConfig = { defaults: {}, instances: { "agent-1": { working_directory: dir } }, ...config } as never;
    const posted = vi.spyOn(fm as any, "postNonceButtonPrompt").mockResolvedValue("n1");
    vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
    return { fm, any: fm as any, posted };
  }
  const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };
  it("web-only: posted to the dashboard with the dialog's options; a chat fleet: not posted (its parked notice stands)", async () => {
    const card = selectionCard(fixture("claude-2.1.291-background-work-exit.pane.txt"), "Claude Code")!;
    const web = fleet();
    await web.fm.postRemoteCard("agent-1", card);
    const args = web.posted.mock.calls[0]![0] as any;
    expect([args.prefix, args.adapterId, args.choices.map((c: any) => c.action), args.remoteCard ?? args.extra?.remoteCard?.identity === card.identity]).toEqual(["card-answer:", "web", ["opt-1", "opt-2", "opt-3"], true]);
    // A chat fleet whose agent has a topic to post in: still not posted (the gate, not a missing place, refuses it)…
    const chat = fleet(CHAT);
    vi.spyOn(chat.any, "remoteCardPlace").mockReturnValue({ adapter: {}, adapterId: "tg", chatId: "-100", threadId: "7" });
    await chat.fm.postRemoteCard("agent-1", card);
    expect(chat.posted).not.toHaveBeenCalled();
    // …while a kiro card (not webOnly) is posted in that topic, as before.
    await chat.fm.postRemoteCard("agent-1", { ...card, webOnly: undefined, noSkip: undefined });
    expect((chat.posted.mock.calls[0]?.[0] as any)?.adapterId).toBe("tg");
  });
  it("a shell prompt on a web-only fleet with no General: a Notice pointing at its View; with a General: the assist prompt on the dashboard (as before)", async () => {
    setLocale("en");
    const web = fleet();
    await web.fm.notifyInteractivePrompt("agent-1", "password");
    const notices = web.any.webNoticeStore().view().items;
    expect([notices.length, notices[0]?.instance, /agent-1 is waiting for input in its terminal \(.+\)\. Open its View to answer it there\./.test(notices[0]?.text ?? ""), web.posted.mock.calls.length])
      .toEqual([1, "agent-1", true, 0]);
    const withGeneral = fleet({ instances: { general: { working_directory: "/tmp/g", general_topic: true }, "agent-1": { working_directory: "/tmp/a" } } });
    vi.spyOn(withGeneral.fm as any, "findGeneralInstance").mockReturnValue("general");     // a running General
    await withGeneral.fm.notifyInteractivePrompt("agent-1", "password");
    expect((withGeneral.posted.mock.calls[0]?.[0] as any)?.prefix).toBe("interactive-assist:");
  });
});
