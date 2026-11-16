/**
 * M-3219: Codex's 工具歷程 in the channel was bare beside Claude's — one plug per line with the raw tool names
 * (`🔌 exec_command`, `🔌 write_stdin` ×3, `plaud:get_file · 🔌 exec_command`). Codex 0.153+ runs every tool as one `exec`
 * custom tool call, a JS script driving `tools.*`; each call is now labelled as the tool it is, in Claude's style and with its
 * safety (a command by its intent or program name at `standard`, the redacted command at `verbose`; files and images by their
 * short path; MCP tools as `server · tool`), polls of a running command fold into it, and the words follow the fleet's language.
 *
 * The records are real rollout lines (tests/fixtures/codex-0169-tool-trace/SOURCES.md), read through the same rollout parser
 * the transcript monitor uses (codexToolRecord) and the same accumulator as the channel bubble.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { codexToolRecord } from "../src/transcript-records.js";
import { codeModeCalls, ProgressAccumulator, summarizeProgress } from "../src/tool-progress.js";
import { getLocale, setLocale, type Locale } from "../src/locale.js";

const priorLocale = getLocale();
afterAll(() => setLocale(priorLocale));

const records = readFileSync(new URL("./fixtures/codex-0169-tool-trace/code-mode.rollout.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
/** Each record's tool uses as the transcript monitor sees them, labelled for the bubble. */
function labels(locale: Locale, level: "standard" | "verbose"): string[] {
  setLocale(locale);
  return records.flatMap(record => {
    const events = { toolUses: [] as Array<{ name: string; input: unknown }>, toolResults: [], assistantTexts: [] };
    codexToolRecord(record, events as unknown as Parameters<typeof codexToolRecord>[1]);
    return events.toolUses.map(u => summarizeProgress(u.name, u.input, level));
  });
}

describe("M-3219: a real Codex code-mode rollout, line by line", () => {
  it("zh-TW, standard: each call as its tool — no raw tool names, no command arguments", () => {
    expect(labels("zh-TW", "standard")).toEqual([
      "⚙️ 執行指令：git",                                                // exec_command, a literal command: its program only
      "⚙️ 執行指令",                                                     // exec_command with a computed command (`cmd: c` in a loop)
      "",                                                                // write_stdin: a poll of the running command, folded into it
      "✏️ 編輯檔案：…/.artifacts/hub-name-m3172/image-review.md",          // apply_patch: the patch's file
      "🖼️ 查看圖片：/work/repo/.artifacts/m3133/preflight.png",           // view_image
      "🔌 codex_apps · github_fetch_workflow_run_jobs",                  // another MCP server's tool
      "🌐 網路搜尋",                                                     // web__run (its `sed` is low-signal at standard, as for Claude)
    ]);
  });
  it("English follows the fleet's language", () => {
    expect(labels("en", "standard")).toEqual([
      "⚙️ Running a command: git", "⚙️ Running a command", "", "✏️ Editing a file: …/.artifacts/hub-name-m3172/image-review.md",
      "🖼️ Viewing an image: /work/repo/.artifacts/m3133/preflight.png", "🔌 codex_apps · github_fetch_workflow_run_jobs", "🌐 Searching the web",
    ]);
  });
  it("verbose adds the command, trimmed — as Claude's Bash", () => {
    const got = labels("zh-TW", "verbose");
    expect(got[0]).toBe("⚙️ $ git ls-tree --name-only origin/release/2.3.5-alp");
    expect(got[1]).toBe("⚙️ 執行指令");
    expect(got[6]).toBe("🌐 網路搜尋 · ⚙️ $ sed -n '45,75p' tests/fixtures/codex-0162-newstr");
  });
});

describe("M-3219: the turn as the user saw it — no bare lines", () => {
  // The user's trace: commands, an MCP call beside a command, and the command's polls (shapes as in the fixture).
  const turn = [
    'text(await tools.exec_command({cmd:"ffprobe -i /data/meeting.m4a","max_output_tokens":2000}));',
    'const f=await tools.mcp__plaud__get_file({file_id:"f-1"});text(await tools.exec_command({cmd:"python3 transcribe.py /tmp/a.m4a",yield_time_ms:1000}));',
    'text(await tools.write_stdin({session_id:6862,chars:"",yield_time_ms:1000,max_output_tokens:600}));',
    'text(await tools.write_stdin({session_id:6862,chars:"",yield_time_ms:1000,max_output_tokens:600}));',
    'text(await tools.write_stdin({session_id:6862,chars:"",yield_time_ms:1000,max_output_tokens:600}));',
    'text(await tools.exec_command({cmd:"npm test",workdir:"/work/repo"}));',
  ];
  it("each command once, the MCP call by server and tool, the polls folded", () => {
    setLocale("zh-TW");
    const acc = new ProgressAccumulator();
    for (const js of turn) acc.add(summarizeProgress("exec", js));
    expect(acc.render().split("\n")).toEqual(["⚙️ 執行指令：ffprobe", "🔌 plaud · get_file · ⚙️ 執行指令：python3", "🧪 執行測試"]);
    expect(acc.render()).not.toMatch(/write_stdin|exec_command|🔌 exec/);
  });
});

describe("M-3219: reading the script", () => {
  it("a parenthesis or a quote inside a string does not end the call", () => {
    // An unbalanced ")" or "(" inside a string: read as code, the first would end the call early, the second never let it end.
    expect(codeModeCalls('await tools.exec_command({cmd:"echo \\")\\" && npm test"}); tools.view_image({path:\'/x/y (1.png\'}); tools.write_stdin({})'))
      .toEqual([{ name: "exec_command", args: '{cmd:"echo \\")\\" && npm test"}' }, { name: "view_image", args: "{path:'/x/y (1.png'}" }, { name: "write_stdin", args: "{}" }]);
  });
  it("single-quoted and plain template commands are read; an interpolated one is not guessed", () => {
    setLocale("zh-TW");
    expect(summarizeProgress("exec", "await tools.exec_command({cmd:'npm test'})")).toBe("🧪 執行測試");
    expect(summarizeProgress("exec", "await tools.exec_command({cmd:`git status`})")).toBe("🔎 檢視 git 狀態");
    expect(summarizeProgress("exec", "await tools.exec_command({cmd:`rm -rf ${dir}`})")).toBe("⚙️ 執行指令");
  });
  it("secrets in a command are redacted at verbose and never shown at standard", () => {
    setLocale("zh-TW");
    const js = 'await tools.exec_command({cmd:"curl -H \'Authorization: Bearer abcdefghijklmnop\' https://x"})';
    expect(summarizeProgress("exec", js, "standard")).toBe("⚙️ 執行指令：curl");
    const verbose = summarizeProgress("exec", js, "verbose");
    expect(verbose).toContain("[REDACTED]");
    expect(verbose).not.toContain("abcdefghijklmnop");
  });
  it("a patch of several files names them; plan bookkeeping and AgEnD's own tools are not lines", () => {
    setLocale("zh-TW");
    const patch = JSON.stringify("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Delete File: src/b.ts\n*** End Patch");
    expect(summarizeProgress("exec", `text(await tools.apply_patch(${patch}));`)).toBe("✏️ 編輯檔案：src/a.ts, src/b.ts");
    expect(summarizeProgress("exec", 'await tools.update_plan({plan:[{step:"x",status:"in_progress"}]})')).toBe("");
    expect(summarizeProgress("exec", 'await tools.mcp__agend_example_t1__reply({text:"hi"})')).toBe("");
  });
  it("the same tools called directly (before code mode) are labelled the same way", () => {
    setLocale("zh-TW");
    expect(summarizeProgress("exec_command", { cmd: "npm test" })).toBe("🧪 執行測試");
    expect(summarizeProgress("write_stdin", { session_id: 1, chars: "" })).toBe("");
    expect(summarizeProgress("apply_patch", "*** Begin Patch\n*** Add File: docs/x.md\n+a\n*** End Patch")).toBe("✏️ 編輯檔案：docs/x.md");
    expect(summarizeProgress("view_image", { path: "/x.png" })).toBe("🖼️ 查看圖片：/x.png");
  });
});
