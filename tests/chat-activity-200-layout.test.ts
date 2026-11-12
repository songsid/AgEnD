/**
 * AGEND-200 (the preview feedback on #3648, laid out as Multica's run list): the opened activity block —
 *   a step is one line, opened by the whole line (one toggle, one place); nothing in the block scrolls;
 *   the command is shown once, as code (the raw JSON only for a tool we do not read); an edit as removed / added text;
 *   `bash -lc '…'` is the command; a long path is `.../parent/leaf`; three or more calls of one tool fold into one line;
 *   failed / running are the icon's colour and one small word, on every kind of step.
 * The collapsed line is not touched (chat-activity-197-ui.test.ts keeps it).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";
import type { LogStep } from "../src/log-steps.js";

type Mod = any;
let row: Mod, act: Mod, i18n: Mod;
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  row = await import("/ui/js/log-row.js");
  act = await import("/ui/js/chat-activity.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; i18n.setLang("en"); });

const T0 = Date.now() - 30_000;
const tool = (id: string, over: Partial<LogStep> = {}): LogStep => ({ id, turn: "t", ts: T0, kind: "tool", tool: "Read", cat: "read", subject: "/srv/w/src/a.ts", status: "done", ...over } as LogStep);

async function mount(items: LogStep[], thinking = true) {
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const host = doc.createElement("div"); doc.body.append(host);
  const group = { items, trailing: [], ended: true, level: "id", from: T0, to: T0 + 9000, partial: false };
  act.mountActivity(host, group, () => ({ paths: { cwd: "/srv/w", home: "/home/me" }, thinking }));
  await settle();
  fire(host.querySelector("summary"), "click"); await settle();
  return host;
}

describe("what a step shows", () => {
  it("`bash -lc '…'` is the command; anything else is left alone", () => {
    expect(row.stripShellWrapper("bash -lc 'npm run build'")).toBe("npm run build");
    expect(row.stripShellWrapper(`/bin/zsh -c "git status"`)).toBe("git status");
    expect(row.stripShellWrapper("npm run build")).toBe("npm run build");
    expect(row.stripShellWrapper("bash script.sh")).toBe("bash script.sh");
  });
  it("AGEND-210: the wrapper ends at its own closing quote — extra words after it are arguments, a second command is not unwrapped", () => {
    expect(row.stripShellWrapper("bash -lc 'echo hi' name arg1")).toBe("echo hi");           // $0 and $1: the script is still the command
    expect(row.stripShellWrapper(`sh -c "echo \\"hi\\"" x`)).toBe('echo "hi"');
    expect(row.stripShellWrapper("bash -c 'a' && echo 'b'")).toBe("bash -c 'a' && echo 'b'");   // two commands: left as they are (greedy matching gave `a' && echo 'b`)
    expect(row.stripShellWrapper("bash -lc 'a'; rm -rf x")).toBe("bash -lc 'a'; rm -rf x");
    expect(row.stripShellWrapper("bash -c 'a' | tee out")).toBe("bash -c 'a' | tee out");
    expect(row.stripShellWrapper("bash -lc 'cd x && ls'")).toBe("cd x && ls");                  // && inside the quotes is the script's own
  });
  it("a long path is `.../parent/leaf`; a short one, a list or a pattern is not touched", () => {
    expect(row.shortPath("/home/me/deep/er/file.png")).toBe(".../er/file.png");
    expect(row.shortPath("src/a.ts")).toBe("src/a.ts");
    expect(row.shortPath("a/b/c")).toBe("a/b/c");
    expect(row.shortPath("a/b/c/d.ts, e/f/g/h.ts")).toBe("a/b/c/d.ts, e/f/g/h.ts");
    expect(row.shortPath("TODO  in  /a/b/c/d")).toBe("TODO  in  /a/b/c/d");
  });
  it("AGEND-210: a Windows path (backslashes) is shortened too, with its own separator; a short one is left", () => {
    expect(row.shortPath("C:\\Users\\me\\proj\\src\\a.ts")).toBe("...\\src\\a.ts");
    expect(row.shortPath("src\\a.ts")).toBe("src\\a.ts");
    expect(row.shortPath("a\\b\\c")).toBe("a\\b\\c");
    expect(row.shortPath("C:\\a/b/c/d.ts")).toBe(".../c/d.ts");                                // a mix: the forward slash wins
  });
  it("the arguments: a command once as code; an edit as old / new; nothing the title already says; the rest as JSON", () => {
    const v = (x: object, cat: string) => row.inputView(x, cat);
    expect(v({ input: '{"command":"bash -lc \'ls\'","description":"list"}', subject: "ls" }, "run")).toEqual({ code: "ls" });
    expect(v({ input: '{"cmd":"npm test"}', subject: "npm test" }, "run")).toEqual({ code: "npm test" });
    expect(v({ input: '{"command":"ls","env":{"A":"1"}}', subject: "ls" }, "run").raw).toContain('"env"');
    expect(v({ input: '{"file_path":"/a/b.ts","old_string":"x","new_string":"y"}', subject: "/a/b.ts" }, "edit")).toEqual({ diff: { old: "x", next: "y" } });
    expect(v({ input: '{"file_path":"/a/b.ts","offset":3,"limit":9}', subject: "/a/b.ts" }, "read")).toBeNull();
    expect(v({ input: '{"query":"select:x","max_results":1}' }, "other").raw).toContain("select:x");
    expect(v({ input: '{"command":"a very long command that was cut', subject: "a" }, "run")).toEqual({ raw: '{"command":"a very long command that was cut' });
    expect(v({}, "run")).toBeNull();
  });
});

describe("three or more calls of one tool are one line", () => {
  it("folds a run of GROUP_MIN done calls; two stay two; a failure, a command and the live newest step stay out", () => {
    const reads = (n: number, from = 0) => Array.from({ length: n }, (_, i) => tool(`r${from + i}`, { subject: `/srv/w/f${from + i}.ts` }));
    const g = act.foldRuns([...reads(3), tool("e", { tool: "Edit", cat: "edit" }), ...reads(2, 10)]);
    expect(g.map((x: any) => (x.group ? `${x.tool}×${x.items.length}` : x.id))).toEqual(["Read×3", "e", "r10", "r11"]);
    const failed = act.foldRuns([...reads(2), tool("x", { status: "failed" }), tool("r9")]);
    expect(failed.some((x: any) => x.group)).toBe(false);
    const cmds = act.foldRuns([1, 2, 3].map((i) => tool(`c${i}`, { tool: "Bash", cat: "run", subject: `ls ${i}` })));
    expect(cmds.some((x: any) => x.group)).toBe(false);
    const all = reads(4);
    const live = act.foldRuns(all, (x: any) => x === all[3]);
    expect(live.map((x: any) => (x.group ? x.items.length : x.id))).toEqual([3, "r3"]);
  });
});

describe("the opened block", () => {
  const steps = [
    { id: "t1", turn: "t", ts: T0, kind: "thinking", body: "First line of the reasoning.\nSecond line, only when opened." } as LogStep,
    tool("c", { tool: "Bash", cat: "run", subject: "cp a.txt /tmp/a.txt", input: '{"command":"cp a.txt /tmp/a.txt"}', body: "copied" }),
    tool("f", { tool: "Bash", cat: "run", subject: "npm test", status: "failed", exitCode: 1, durationMs: 900, input: '{"command":"npm test"}', body: "FAIL" }),
    tool("r", { tool: "Read", cat: "read", subject: "/srv/w/src/a.ts" }),
  ];
  it("every step is one line; the ones with more have ONE toggle (the line), in the same place; failure is a small word", async () => {
    const host = await mount(steps);
    const items = [...host.querySelectorAll(".log-item")];
    expect(items).toHaveLength(4);
    // thinking, the command, the failed command: the line is the toggle; a Read with nothing to open has none
    expect(items.map((li: any) => li.querySelectorAll(".log-fold").length)).toEqual([1, 1, 1, 0]);
    expect(host.querySelectorAll(".link-btn")).toHaveLength(0);                       // no "Show output / Show all thinking" links
    expect(host.querySelector(".s-failed .log-status.failed").textContent).toContain(i18n.t("log.failed"));
    expect(host.querySelector(".s-failed .log-status.failed").textContent).toContain(i18n.t("log.exit", 1));
    expect(host.querySelector(".log-item.s-done .log-status")).toBeNull();            // a step that went well says nothing
    expect(host.querySelector(".log-item.s-failed .log-head").classList.contains("log-fold")).toBe(true);
  });
  it("the command is shown once, as code — no raw arguments JSON for a command", async () => {
    const host = await mount(steps);
    fire(host.querySelectorAll(".log-fold")[1], "click"); await settle();
    const li = host.querySelectorAll(".log-item")[1];
    expect(li.querySelector(".log-code").textContent).toBe("$ cp a.txt /tmp/a.txt");
    expect(li.textContent).not.toContain('"command"');
    expect(li.textContent).toContain("copied");
    expect(li.querySelector(".log-fold").getAttribute("aria-expanded")).toBe("true");
  });
  it("thinking: a short preview until its line is opened, then all of it", async () => {
    const host = await mount(steps);
    const sum = () => host.querySelector(".log-think");
    expect(sum().textContent).toBe("First line of the reasoning.…");
    fire(host.querySelector(".log-more"), "click"); await settle();
    expect(sum().textContent).toBe("First line of the reasoning.\nSecond line, only when opened.");
    expect(sum().classList.contains("open")).toBe(true);
  });
  it("a command with the shell wrapper shows the command; a long path is shortened, its title keeps the full one", async () => {
    const host = await mount([
      tool("x", { tool: "exec_command", cat: "run", subject: "bash -lc 'npm run build'" }),
      tool("y", { subject: "/home/me/deep/er/file.png", tool: "Read" }),
    ]);
    const subs = [...host.querySelectorAll(".log-subject")];
    expect(subs.map((e: any) => e.textContent)).toEqual(["npm run build", ".../er/file.png"]);
    expect(subs[1].getAttribute("title")).toBe("/home/me/deep/er/file.png");
  });
  it("a run of reads is one line that opens to its calls", async () => {
    const host = await mount([1, 2, 3, 4].map((i) => tool(`r${i}`, { subject: `/srv/w/f${i}.ts` })));
    expect(host.querySelectorAll(".log-item.k-group")).toHaveLength(1);
    expect(host.querySelector(".k-group .log-subject").textContent).toBe("Read · 4 calls");
    expect(host.querySelectorAll(".log-sub .log-item")).toHaveLength(0);
    fire(host.querySelector(".k-group .log-fold"), "click"); await settle();
    expect(host.querySelectorAll(".log-sub .log-item")).toHaveLength(4);
  });
});

describe("the style: nothing in the block scrolls; one status language", () => {
  const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
  const rules = (sel: string) => css.split("\n").filter((l) => l.startsWith(sel));
  it("the opened body has no height cap and no scroll; neither has a thinking row", () => {
    for (const l of [...rules(".act-block .act-body"), ...rules(".act-block .log-think"), ...rules(".act-block .log-sum")]) expect(l).not.toMatch(/max-height|overflow-y\s*:\s*(auto|scroll)/);
  });
  it("no coloured left bar on a step (failed is the icon and a word)", () => {
    expect(css).not.toContain(".act-block .log-item.s-failed::before");
    expect(css).not.toContain(".act-block .log-item.k-error::before");
    expect(css).toMatch(/\.act-block \.log-item\.s-failed \.log-icon/);
  });
});
