/**
 * #1218 phase 1: the Log tab's step model and parsers (src/log-steps.ts). claude-code from a shape-faithful synthetic
 * transcript (record types, keys and nesting as claude-code 2.1.x writes them; all content synthetic); codex from the
 * real 0.162.0 rollout already in the repo (tests/fixtures/reply-guard-1510) and from records shaped like the newer
 * item_completed events. Masking: only actual secret values (the user's decision) — secret-shaped strings are built
 * here at run time, never committed (gitleaks).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKFILL_MAX_BYTES, ClaudeStepParser, CodexStepParser, RESULT_MAX, TEXT_MAX, bounded, describeTool, maskSecrets, readTailRecords, stepsOf,
} from "../src/log-steps.js";
import { LINE_MAX_BYTES } from "../src/transcript-jsonl.js";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1218-steps-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const FIX = join(import.meta.dirname, "fixtures");
const CLAUDE = join(FIX, "log-steps-1218", "claude.jsonl");
const CODEX = join(FIX, "reply-guard-1510", "codex-0.162.0", "rollout.jsonl");
const brief = (s: { kind: string; tool?: string; cat?: string; subject?: string; status?: string; body?: string; turn: string; note?: string }) =>
  [s.turn, s.kind, s.tool ?? "", s.cat ?? "", s.subject ?? "", s.status ?? "", s.note ?? "", (s.body ?? "").slice(0, 30)].join("|");

describe("masking: only actual secret values, everything else stays readable", () => {
  // Built at run time: a committed literal would trip the secret scan (#gitleaks), and that is the point of them.
  const gh = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
  const opaque = "Zx9" + "Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz".repeat(2);
  it("known key shapes, Bearer, key=value, URL userinfo and long mixed-case opaque tokens are masked", () => {
    const out = maskSecrets(`push https://bob:${"hunter2pass"}@git.example/x token=${"abcdef123456"} ${gh} Authorization: Bearer ${"abc.def.ghi12345"} ${opaque}`);
    expect(out).not.toContain(gh);
    expect(out).not.toContain(opaque);
    expect(out).not.toContain("hunter2pass");
    expect(out).toContain("[REDACTED]");
  });
  // #1788 review P1 (Fable): the ways secrets are actually written — built at run time (gitleaks).
  const J = (...p: string[]) => p.join("");
  it.each([
    ["a JSON field (as arguments are shown)", JSON.stringify({ password: J("hunter2", "hunter2"), api_key: J("abc123", "def456ghi") }, null, 1), [J("hunter2", "hunter2"), J("abc123", "def456ghi")]],
    ["an export", J("export DB_PASSWORD=", "hunter2hunter2"), [J("hunter2", "hunter2")]],
    ["an env prefix", J("GITHUB_TOKEN=", "abcdef1234567890", " npm publish"), [J("abcdef", "1234567890")]],
    ["a .env file's lines", J("STRIPE_SECRET_KEY=sk_live_", "abcdef123456\nDB_PASSWORD=", "p4ss/w0rd"), [J("sk_live_", "abcdef123456"), J("p4ss/", "w0rd")]],
    ["an AWS secret with /", J("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), [J("wJalrXUtnFEMI/", "K7MDENG")]],
    ["a private key block", J("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nQyNTUxOQAAACDx/abc\n-----END OPENSSH ", "PRIVATE KEY-----"), ["QyNTUxOQAAACDx/", "b3BlbnNzaC1rZXkt"]],
    ["a private key block cut off", J("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEowIBAAKCAQEAx"), ["MIIEowIBAAKCAQEAx"]],
    ["a flag", J("mysql --password ", "hunter2hunter2", " -u root"), [J("hunter2", "hunter2")]],
    ["a YAML value in quotes", J("client_secret: '", "abc/def+ghi", "'"), [J("abc/def", "+ghi")]],
    // #1788 review r2 P2: a quoted value runs to the same quote, spaces included (a passphrase).
    ["a quoted passphrase in an export", J('export DB_PASSWORD="correct ', 'horse battery staple"'), ["correct", "horse", "battery", "staple"]],
    ["a single-quoted YAML value with spaces", J("db_password: 'two ", "words here'"), ["two", "words", "here"]],
    ["a quoted flag value with spaces", J('mysql --password "open ', 'sesame please" -u root'), ["open", "sesame", "please"]],
    // r2 P3: a key given after its name as an argument.
    ["a key as an argument", J("aws configure set aws_secret_access_key ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), [J("wJalrXUtnFEMI/", "K7MDENG")]],
  ])("masked: %s", (_name, text, gone) => {
    const out = maskSecrets(text as string);
    for (const g of gone as string[]) expect(out, g).not.toContain(g);
    expect(out).toContain("[REDACTED]");
  });
  it("linear on long input: a 200 KB run of word characters (a long output) is masked in well under a second", () => {
    for (const t of ["w".repeat(200_000), "ab_".repeat(60_000), "password_".repeat(20_000), 'a_password="x '.repeat(14_000), "db_password: 'x ".repeat(12_000), "token ".repeat(30_000), "token a1".repeat(25_000), 'a_password=\\"x '.repeat(12_000), "x".repeat(100_000) + J(" https://u:", "pw@host")]) {
      const t0 = performance.now();
      const out = maskSecrets(t);
      expect(performance.now() - t0, t.slice(0, 12)).toBeLessThan(500);
      if (t.includes("https://")) expect(out.endsWith("https://u:[REDACTED]@host")).toBe(true);
    }
  });
  it("numbers, booleans and null are kept whatever the name: token counts stay readable", () => {
    const keep = 'tokens used: 1234; max_tokens=4096; password_length: 12; "input_token_count": 12, "secret_set": true, "token_limit": "4096", "use_token": "false"';
    expect(maskSecrets(keep)).toBe(keep);
  });

  // #1788 review r3 (Fable): arguments are shown as JSON, where a command's quotes are escaped (\") — they are masked
  // before they become JSON, through the real paths: a claude tool_use input and a codex function_call's arguments.
  const pass = J("correct horse ", "battery staple"), hunter = J("hunter2", "hunter2"), yaml = J("two words ", "here");
  const samples: Array<[string, Record<string, unknown>, string[]]> = [
    ["a quoted passphrase in a command", { command: J('export DB_PASSWORD="', pass, '" && run') }, ["correct", "battery", "staple"]],
    ["a quoted secret without spaces", { command: J('export DB_PASSWORD="', hunter, '"') }, [hunter]],
    ["a YAML file's quoted password", { file_path: "config.yml", content: J('db:\n  password: "', yaml, '"\n') }, ["two words", "here"]],
  ];
  it.each(samples)("claude tool_use input: %s", (_n, input, gone) => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input }] } }));
    const shown = JSON.stringify(p.steps);
    for (const g of gone) expect(shown, g).not.toContain(g);
    expect(p.steps[0]!.input).toContain("[REDACTED]");
  });
  it.each(samples)("codex function_call arguments: %s", (_n, input, gone) => {
    const p = new CodexStepParser();
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: JSON.stringify(input) } }));
    const shown = JSON.stringify(p.steps);
    for (const g of gone) expect(shown, g).not.toContain(g);
    expect(p.steps[0]!.input).toContain("[REDACTED]");
  });
  it("arguments: a secret-named key is masked whole unless plain; a string that is not JSON is masked as text; long values count as cut", () => {
    const p = new ClaudeStepParser();
    const input = { api_key: J("abc ", "def"), max_tokens: "4096", password: "", nested: [{ client_secret: J("x y ", "z") }], note: "fine", body: "b".repeat(5000) };
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Custom", input }] } }));
    const s = p.steps[0]!;
    expect(s.input).toContain('"api_key": "[REDACTED]"');
    expect(s.input).toContain('"max_tokens": "4096"');
    expect(s.input).toContain('"password": ""');
    expect(s.input).toContain('"client_secret": "[REDACTED]"');
    expect(s.input).toContain('"note": "fine"');
    expect(s.input!.length).toBe(2000);
    expect(s.inputCut).toBe(JSON.stringify({ ...input, api_key: "[REDACTED]", nested: [{ client_secret: "[REDACTED]" }] }, null, 1).length - 2000);
    const c = new CodexStepParser();
    c.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c", name: "x", arguments: J('{not json DB_PASSWORD="', hunter, '"') } }));
    expect(c.steps[0]!.input).not.toContain(hunter);
  });
  // #1788 review P3s: a long value is still masked in what is shown; JSON text and object results are masked too.
  it("a Write longer than can be shown: a secret in its shown start is masked", () => {
    const p = new ClaudeStepParser();
    const content = J('db:\n  DB_PASSWORD="', yaml, '"\n') + "x".repeat(4000);
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "a.yml", content } }] } }));
    expect(p.steps[0]!.inputCut).toBeGreaterThan(0);
    expect(p.steps[0]!.input).toContain("[REDACTED]");
    expect(JSON.stringify(p.steps)).not.toContain("two words");
  });
  it("a result that is JSON text (escaped quotes) and a result that is an object are masked", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "mcp__db__run", input: {} }] } }));
    p.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: JSON.stringify({ env: J('DB_PASSWORD="', hunter, '" TOKEN="', pass, '"') }) }] } }));
    expect(p.steps[0]!.body).toContain('DB_PASSWORD=\\"[REDACTED]\\"');
    for (const g of [hunter, "battery"]) expect(JSON.stringify(p.steps), g).not.toContain(g);
    const c = new CodexStepParser();
    c.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c", name: "x", arguments: "{}" } }));
    c.push(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c", output: { api_key: J("abc ", "def"), log: J('export DB_PASSWORD="', hunter, '"'), count: 3 } } }));
    expect(c.steps[0]!.body).toContain('"api_key":"[REDACTED]"');
    expect(c.steps[0]!.body).toContain('"count":3');
    // A long secret-named key (past what a text rule's name reaches) is masked by its key in an object result.
    const k = new CodexStepParser();
    k.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "k", name: "x", arguments: "{}" } }));
    k.push(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "k", output: { storage_account_primary_connection_string_access_key: J("Default ", "Endpoints") } } }));
    expect(k.steps[0]!.body).not.toContain("Endpoints");
    expect(JSON.stringify(c.steps)).not.toContain(hunter);
  });
  it("arguments given as a JSON string (an MCP call's) and a subject made from an array are masked the same way", () => {
    const c = new CodexStepParser();
    c.push(JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "m", server: "db", tool: "run", arguments: JSON.stringify({ sql: J("SET password = '", pass, "'"), dsn: J('postgres DB_PASSWORD="', hunter, '"') }), status: "completed" } } }));
    expect(c.steps[0]!.input).toContain('"dsn"');
    expect(JSON.stringify(c.steps)).not.toContain(hunter);
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "shell", input: { command: ["bash", "-lc", J('export DB_PASSWORD="', hunter, '"')] } }] } }));
    expect(p.steps[0]!.subject).toContain("[REDACTED]");
    expect(JSON.stringify(p.steps)).not.toContain(hunter);
  });
  it("prose after a secret word stays; only a key-shaped argument is masked; quotes are kept around the mask", () => {
    const keep = "the access_token expired yesterday; reset the password through the account settings page; the api_key v2beta1 "
      + "header; see secret_rotation documentation_for_operators";
    expect(maskSecrets(keep)).toBe(keep);
    expect(maskSecrets(J('export DB_PASSWORD="a b"'))).toBe('export DB_PASSWORD="[REDACTED]"');
    expect(maskSecrets(J("db_password: 'x y'"))).toBe("db_password: '[REDACTED]'");
    expect(maskSecrets(J("password: 'x y'"))).toBe("password: [REDACTED]"); // the bubble's redactor then takes the quotes too
    expect(maskSecrets('max_tokens="4096" token_limit: \'100\' password=""')).toBe('max_tokens="4096" token_limit: \'100\' password=""');
  });
  it("a git SHA, a UUID, a long instance name and a long path are not secrets", () => {
    const keep = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b 123e4567-e89b-12d3-a456-426614174000 agend-web-claude-t1554485732591276113 /home/han/Projects/AgEnD-agend-web-claude/src/log-steps.ts";
    expect(maskSecrets(keep)).toBe(keep);
  });
  it("bounded: only the part that can be shown (and a margin) is masked — what is cut far past it is counted as written", () => {
    const text = "x".repeat(10) + " ".repeat(2000) + J("password=", "hunter2hunter2");
    expect(bounded(text, 10)).toEqual({ text: "x".repeat(10), cut: text.length - 10 });
  });
  it("bounded: masked first, then cut, with the count of what was cut; never inside a surrogate pair", () => {
    expect(bounded("x".repeat(10), 4)).toEqual({ text: "xxxx", cut: 6 });
    const b = bounded("😀".repeat(5), 3);
    expect(b.text).toBe("😀");
    expect(b.text.length + b.cut).toBe(10);
  });
});

describe("describeTool: a category and a subject, for words the page renders in its language", () => {
  it.each([
    ["Read", { file_path: "src/a.ts" }, "read", "src/a.ts"],
    ["Edit", { file_path: "src/b.ts", old_string: "x", new_string: "y" }, "edit", "src/b.ts"],
    ["Grep", { pattern: "TODO", path: "src" }, "search", "TODO in src"],
    ["Bash", { command: "npm test -- --run x" }, "run", "npm test -- --run x"],
    ["WebFetch", { url: "https://example.com/a" }, "web", "https://example.com/a"],
    ["Task", { description: "review the diff" }, "agent", "review the diff"],
    ["TodoWrite", { todos: [{}, {}, {}] }, "plan", "3"],
    ["mcp__github__get_issue", { number: 1 }, "mcp", "github:get_issue"],
    ["mcp__agend__reply", { text: "hi" }, "message", "agend:reply"],
    ["exec_command", { cmd: "ls -la" }, "run", "ls -la"],
    ["apply_patch", "*** Begin Patch\n*** Update File: src/c.ts\n@@\n*** Add File: d.ts\n", "edit", "src/c.ts, d.ts"],
    ["exec", "const r = await tools.exec_command({cmd:'ls'});\nawait tools.view_image({})", "run", "exec_command, view_image"],
    ["fs_read", { operations: [{ path: "/w/x.md" }] }, "read", "/w/x.md"],
    ["SomethingNew", { a: 1 }, "other", undefined],
  ])("%s", (name, input, cat, subject) => {
    expect(describeTool(name, input)).toEqual(subject === undefined ? { cat } : { cat, subject });
  });
  it("a subject is one line, masked and at most 300 characters", () => {
    const d = describeTool("Bash", { command: "echo " + "y".repeat(500) + "\nsecond line" });
    expect(d.subject!.length).toBe(300);
    expect(d.subject).not.toContain("\n");
  });
});

describe("claude-code: the transcript as steps", () => {
  const parse = () => { const p = new ClaudeStepParser(); for (const l of readFileSync(CLAUDE, "utf8").split("\n")) p.push(l); return p; };

  it("prompts, text, tool calls with their results, errors, turn ends and states — never thinking, meta or bookkeeping", () => {
    expect(parse().steps.map(brief)).toEqual([
      "pr1|user||||||[user:han via telegram] 目前進度？",
      "pr1|assistant||||||Checking the branch.",
      "pr1|tool|Bash|run|git status --short|done|| M src/a.ts",
      "pr1|tool|Read|read|/w/web-dev/src/a.ts|done||1\texport const a = 1;",
      "pr1|tool|Grep|search|TODO in src|failed||rg: src: No such file",
      "pr1|tool|mcp__agend__reply|message|agend:reply|done||sent",
      "pr1|tool|Read|read|/w/web-dev/shot.png|done||[image]",
      "pr1|turn_end||||||",
      "u16|user||||||/compact",
      "u16|state|||||compacted|",
      "u18|user||||||Run the tests",
      "u18|tool|Bash|run|npm test|interrupted||",
      "u18|error|||||429|API Error: 429 rate limited",
      "u21|user||||||Try again",
    ]);
  });

  it("a result completes its call in place (same id), with its duration; the call's input is kept for the page", () => {
    const p = new ClaudeStepParser();
    const lines = readFileSync(CLAUDE, "utf8").split("\n");
    const call = p.push(lines[5]!);
    expect(call).toMatchObject([{ id: "toolu_01", kind: "tool", status: "running", input: expect.stringContaining('"command": "git status --short"') }]);
    const done = p.push(lines[6]!);
    expect(done).toMatchObject([{ id: "toolu_01", status: "done", durationMs: 2000, body: " M src/a.ts" }]);
    expect(p.steps.filter(s => s.id === "toolu_01")).toHaveLength(1);
  });

  it("the turn's end: a call still running when turn_duration comes is interrupted", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "user", message: { role: "user", content: "go" } }));
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 9" } }] } }));
    const out = p.push(JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 9 }));
    expect(out.map(s => [s.kind, s.status ?? "", s.durationMs ?? ""])).toEqual([["tool", "interrupted", ""], ["turn_end", "", 9]]);
  });

  it("texts and results are masked and cut, with the count of what was cut", () => {
    const p = new ClaudeStepParser();
    const gh = "ghp_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3".repeat(2);
    p.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(TEXT_MAX + 50) }, { type: "tool_use", id: "t", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${gh}" x` } }] } }));
    p.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "t", type: "tool_result", content: `${gh}\n` + "o".repeat(RESULT_MAX + 7) }] } }));
    const [text, tool] = p.steps;
    expect([text!.body!.length, text!.bodyCut]).toEqual([TEXT_MAX, 50]);
    expect(JSON.stringify(tool)).not.toContain(gh);
    expect(tool!.body!.length).toBe(RESULT_MAX);
    expect(tool!.bodyCut).toBeGreaterThan(0);
  });

  it("a result too long to parse completes its call from its head: the start of its text and its size", () => {
    const p = new ClaudeStepParser();
    p.push(JSON.stringify({ type: "assistant", timestamp: "2026-10-13T08:00:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "big", name: "Read", input: { file_path: "huge.log" } }] } }));
    const head = '{"parentUuid":"p","type":"user","message":{"role":"user","content":[{"tool_use_id":"big","type":"tool_result","content":"line one\\nline two with \\"quotes\\" and \\u4e2d';
    const out = p.push({ at: 0, head, bytes: 900_000, complete: true, offset: 0 });
    expect(out).toMatchObject([{ id: "big", status: "done", bodyBytes: 900_000, body: 'line one\nline two with "quotes" and 中' }]);
  });
});

describe("codex: the rollout as steps", () => {
  it("the real 0.162.0 rollout: prompts, exec_command calls with exit status and wall time, replies, turn ends", () => {
    const p = new CodexStepParser();
    for (const l of readFileSync(CODEX, "utf8").split("\n")) if (l.trim()) p.push(l);
    const tools = p.steps.filter(s => s.kind === "tool");
    expect(tools.map(s => [s.tool, s.cat, s.subject, s.status, s.exitCode ?? null])).toEqual([
      ["exec_command", "run", "sleep 20; echo tool-done", "failed", null],     // its args named the command "command"
      ["exec_command", "run", "sleep 20; echo tool-done", "done", 0],
      ["exec_command", "run", "sleep 20; echo tool-done", "done", 0],
      ["exec_command", "run", "sleep 20; echo tool-done", "done", 0],
    ]);
    expect(tools[1]).toMatchObject({ durationMs: 19863, body: "tool-done\n" });
    expect(tools[0]!.body).toMatch(/^failed to parse function arguments/);
    const kinds = p.steps.map(s => s.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("turn_end");
    expect(kinds.filter(k => k === "assistant").length).toBeGreaterThan(0);
    expect(JSON.stringify(p.steps)).not.toMatch(/environment_context|user_instructions/);
  });

  it("item_completed items: commands with exit code and duration, MCP calls, file changes; agent/user items are not doubled", () => {
    const p = new CodexStepParser();
    const ev = (payload: unknown) => JSON.stringify({ timestamp: "2026-10-13T08:00:00.000Z", type: "event_msg", payload });
    const ri = (payload: unknown) => JSON.stringify({ timestamp: "2026-10-13T08:00:01.000Z", type: "response_item", payload });
    for (const l of [
      ev({ type: "task_started", turn_id: "t1" }),
      ri({ type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }),
      ev({ type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "fix it" }] } }),
      ri({ type: "reasoning", encrypted_content: "zzz", summary: [] }),
      ri({ type: "custom_tool_call", call_id: "c1", name: "exec", input: "await tools.exec_command({cmd:'git status'})", status: "completed" }),
      ev({ type: "item_completed", item: { type: "CommandExecution", id: "exec-1", command: ["git", "status"], status: "completed", exit_code: 0, aggregated_output: "clean", duration: { secs: 1, nanos: 500_000_000 } } }),
      ev({ type: "item_completed", item: { type: "CommandExecution", id: "exec-2", command: ["npm", "test"], status: "failed", exit_code: 1, aggregated_output: "1 failed", duration: { secs: 12, nanos: 0 } } }),
      ri({ type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed" }] }),
      ev({ type: "item_completed", item: { type: "McpToolCall", id: "m1", server: "github", tool: "get_issue", arguments: { number: 7 }, status: "completed", result: { content: [{ type: "text", text: "issue body" }] }, duration: { secs: 0, nanos: 300_000_000 } } }),
      ev({ type: "item_completed", item: { type: "FileChange", id: "f1", changes: { "/w/src/a.ts": { type: "update", unified_diff: "@@" } }, status: "completed", stdout: "Success", stderr: "" } }),
      ev({ type: "item_completed", item: { type: "AgentMessage", id: "a", content: [{ type: "text", text: "done" }] } }),
      ri({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }),
      ev({ type: "task_complete", turn_id: "t1", last_agent_message: "done", duration_ms: 20000 }),
    ]) p.push(l);
    expect(p.steps.map(brief)).toEqual([
      "t1|user||||||fix it",
      "t1|tool|exec|run|exec_command|done||Script completed",
      "t1|tool|command|run|git status|done||clean",
      "t1|tool|command|run|npm test|failed||1 failed",
      "t1|tool|github:get_issue|mcp|github:get_issue|done||issue body",
      "t1|tool|file_change|edit|/w/src/a.ts|done||Success",
      "t1|assistant||||||done",
      "t1|turn_end||||||",
    ]);
    expect(p.steps[3]).toMatchObject({ exitCode: 1, durationMs: 12000 });
    expect(p.steps[7]).toMatchObject({ durationMs: 20000 });
  });

  it("codex's own context records (environment, instructions, permissions) are not a person's prompt", () => {
    const p = new CodexStepParser();
    const user = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    for (const t of ["<environment_context>\n<cwd>/w</cwd>", "<user_instructions>be brief</user_instructions>", "<permissions>x</permissions>", "the real question"]) p.push(user(t));
    expect(p.steps.map(s => s.body)).toEqual(["the real question"]);
  });

  it("an aborted turn interrupts what still runs; a turn ending with no reply is marked failed", () => {
    const p = new CodexStepParser();
    const ev = (payload: unknown) => JSON.stringify({ type: "event_msg", payload });
    p.push(ev({ type: "task_started", turn_id: "t1" }));
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: '{"cmd":"sleep 99"}' } }));
    const out = p.push(ev({ type: "turn_aborted", turn_id: "t1", reason: "interrupted" }));
    expect(out.map(s => [s.kind, s.status, s.note ?? ""])).toEqual([["tool", "interrupted", ""], ["turn_end", "interrupted", "interrupted"]]);
    p.push(ev({ type: "task_started", turn_id: "t2" }));
    expect(p.push(ev({ type: "task_complete", turn_id: "t2", last_agent_message: null }))[0]).toMatchObject({ kind: "turn_end", status: "failed", turn: "t2" });
  });

  it("a long output line completes its call from the head of its text", () => {
    const p = new CodexStepParser();
    p.push(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "cx", name: "exec_command", arguments: '{"cmd":"cat big"}' } }));
    const head = '{"timestamp":"2026-10-13T08:00:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"cx","output":"Chunk ID: 1\\nOutput:\\nfirst lines of a big file';
    expect(p.push({ at: 0, head, bytes: 5_000_000, complete: true, offset: 0 })).toMatchObject([{ id: "cx", status: "done", bodyBytes: 5_000_000, body: "Chunk ID: 1\nOutput:\nfirst lines of a big file" }]);
  });
});

describe("readTailRecords: an on-demand backfill reads only the end of a transcript", () => {
  it("the last records in file order; a record still being written is left out", async () => {
    const r = await readTailRecords(CLAUDE);
    expect(r.truncated).toBe(false);
    expect(r.records.length).toBe(readFileSync(CLAUDE, "utf8").split("\n").length - 1);
    expect(stepsOf(new ClaudeStepParser(), r.records).map(s => s.kind).at(-1)).toBe("user");
    expect(r.records[0]!.at).toBe(0);
    expect(JSON.stringify(r.records)).not.toContain("still being wri");
  });

  it("maxLines and maxBytes bound it; older records are reported as not read", async () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
    const a = await readTailRecords(f, { maxLines: 100 });
    expect([a.records.length, a.truncated, a.records[0]!.record, a.records[99]!.record]).toEqual([100, true, '{"i":4900}', '{"i":4999}']);
    const b = await readTailRecords(f, { maxBytes: 300 });
    expect(b.truncated).toBe(true);
    expect(b.records.every(x => /^\{"i":\d+\}$/.test(x.record as string))).toBe(true);
    expect(b.records.at(-1)!.record).toBe('{"i":4999}');
  });

  it("a record longer than LINE_MAX_BYTES (across chunks): its head and exact size, in its place", async () => {
    const f = join(temp(), "t.jsonl");
    const big = JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "b", type: "tool_result", content: "q".repeat(3 * LINE_MAX_BYTES) }] } });
    writeFileSync(f, '{"a":1}\n' + big + '\n{"b":2}\n');
    const r = await readTailRecords(f);
    expect(r.records.map(({ record: x }) => (typeof x === "string" ? x : `long:${x.bytes}:${x.head.slice(0, 15)}`))).toEqual(['{"a":1}', `long:${Buffer.byteLength(big)}:{"type":"user",`, '{"b":2}']);
    expect(r.records.map(x => x.at)).toEqual([0, 8, 8 + Buffer.byteLength(big) + 1]);
  });

  it("the default reads at most 8 MiB from the end of a bigger file", async () => {
    const f = join(temp(), "t.jsonl");
    const lineText = JSON.stringify({ pad: "z".repeat(1000) });
    writeFileSync(f, (lineText + "\n").repeat(Math.ceil((BACKFILL_MAX_BYTES + 2 * 1024 * 1024) / 1000)));
    const r = await readTailRecords(f, { maxLines: 1e9 });
    expect(r.truncated).toBe(true);
    expect(r.records.length * (lineText.length + 1)).toBeLessThanOrEqual(BACKFILL_MAX_BYTES);
    appendFileSync(f, '{"last":1}\n');
    expect((await readTailRecords(f, { maxLines: 1 })).records.map(x => x.record)).toEqual(['{"last":1}']);
  });
});

describe("ids do not depend on where parsing began (an on-demand Log parses a range at a time)", () => {
  it("the steps of the whole transcript and of its tail have the same ids and turns where they overlap", async () => {
    const all = stepsOf(new ClaudeStepParser(), (await readTailRecords(CLAUDE)).records, 1000);
    const tail = stepsOf(new ClaudeStepParser(), (await readTailRecords(CLAUDE, { maxLines: 8 })).records, 1000);
    const byId = new Map(all.map(s => [s.id, s]));
    expect(tail.length).toBeGreaterThan(0);
    // A range that begins mid-turn does not know that turn's key: its first steps say "" ("continues an earlier turn").
    for (const s of tail) expect(byId.get(s.id), s.id).toMatchObject(s.turn ? { kind: s.kind, turn: s.turn } : { kind: s.kind });
    expect(tail.findIndex(s => s.turn !== "")).toBeGreaterThan(0);
  });
  it("a result parsed in a later range carries its call's id: the page merges it into the call it already shows", () => {
    const first = new ClaudeStepParser(), later = new ClaudeStepParser();
    const call = first.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "make" } }] } }), 100);
    const done = later.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_x", type: "tool_result", content: "ok" }] } }), 400);
    expect([call[0]!.id, done[0]!.id, done[0]!.status]).toEqual(["toolu_x", "toolu_x", "done"]);
  });
});
