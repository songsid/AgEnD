import { describe, expect, it } from "vitest";
import { ProgressAccumulator, redactSecrets, summarizeProgress } from "../src/tool-progress.js";

describe("redactSecrets", () => {
  it.each([
    ["sk-abc123def456ghi789jkl012", "OpenAI-style key"],
    ["sk-ant-api03-xxxxxxxxxxxx", "Anthropic key"],
    ["ghp_16charsminimum1234", "GitHub PAT"],
    ["xoxb-1234567890-abcdefghij", "Slack bot token"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
    ["123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "Telegram bot token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "JWT"],
  ])("redacts %s (%s)", (secret) => {
    const out = redactSecrets(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts key=value assignments and auth headers", () => {
    expect(redactSecrets("API_KEY=supersecret123")).not.toContain("supersecret123");
    expect(redactSecrets('password: "hunter2hunter2"')).not.toContain("hunter2hunter2");
    expect(redactSecrets("Authorization: Bearer abcdef123456")).not.toContain("abcdef123456");
  });

  it("redacts URL userinfo credentials", () => {
    const out = redactSecrets("https://user:p4ssw0rd@example.com/repo.git");
    expect(out).not.toContain("p4ssw0rd");
    expect(out).toContain("user:[REDACTED]@");
  });

  it("leaves ordinary text alone", () => {
    const text = "npm test -- --run tests/foo.test.ts";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("summarizeProgress — claude-code shapes", () => {
  it("labels file reads with the path", () => {
    expect(summarizeProgress("Read", { file_path: "/repo/src/daemon.ts" })).toBe("📄 讀取檔案：/repo/src/daemon.ts");
  });

  it("shortens long paths", () => {
    const label = summarizeProgress("Read", { file_path: "/very/long/path/that/goes/on/forever/and/ever/src/daemon.ts" });
    expect(label).toContain("…/");
    expect(label).toContain("daemon.ts");
  });

  it("labels edits and writes as editing", () => {
    expect(summarizeProgress("Edit", { file_path: "/a/b.ts" })).toContain("✏️ 編輯檔案");
    expect(summarizeProgress("Write", { file_path: "/a/b.ts" })).toContain("✏️ 編輯檔案");
  });

  it("maps test commands to a semantic label without arguments", () => {
    const label = summarizeProgress("Bash", { command: "npm test -- --run tests/secret-SK-abc.test.ts" });
    expect(label).toBe("🧪 執行測試");
  });

  it("maps git operations", () => {
    expect(summarizeProgress("Bash", { command: "git push origin main" })).toBe("⬆️ git push");
    expect(summarizeProgress("Bash", { command: "git commit -m 'x'" })).toBe("💾 git commit");
  });

  it("keeps only the program name for unclassified commands at standard", () => {
    const label = summarizeProgress("Bash", { command: "curl -H 'Authorization: Bearer tok123' https://x" });
    expect(label).toBe("⚙️ 執行指令：curl");
    expect(label).not.toContain("tok123");
  });

  it("hides low-signal inspection commands at standard", () => {
    expect(summarizeProgress("Bash", { command: "ls -la" })).toBe("");
    expect(summarizeProgress("Bash", { command: "cat foo.txt" })).toBe("");
  });

  it("verbose adds a redacted truncated preview", () => {
    const label = summarizeProgress("Bash", { command: "npm test -- --grep foo" }, "verbose");
    expect(label).toContain("🧪 執行測試：");
    expect(label).toContain("npm test");
  });

  it("verbose redacts secrets in previews", () => {
    const label = summarizeProgress("Bash", { command: "deploy --token ghp_abcdefghijklmnop1234" }, "verbose");
    expect(label).not.toContain("ghp_abcdefghijklmnop1234");
  });

  it("suppresses channel-plumbing MCP tools on every backend naming scheme", () => {
    expect(summarizeProgress("mcp__agend__reply", {})).toBe("");                       // claude-code
    expect(summarizeProgress("agend-opencode-glm5-2-t123_report_result", {})).toBe(""); // opencode
    expect(summarizeProgress("mcp__agend_codex_t152__send_to_instance", {})).toBe("");  // codex per-instance naming
  });

  it("suppresses agend tools but keeps others inside a codex exec batch", () => {
    const js = "await tools.mcp__agend_codex_t152__list_instances({}); await tools.web__run({q:1});";
    expect(summarizeProgress("exec", js)).toBe("🔌 web__run");
  });

  it("labels other MCP tools by server:tool", () => {
    expect(summarizeProgress("mcp__github__create_pr", {})).toBe("🔌 github:create_pr");
  });

  it("labels subagent work", () => {
    expect(summarizeProgress("Agent", { prompt: "do things" })).toBe("🤝 派工作給子 Agent");
  });

  it("suppresses TodoWrite bookkeeping", () => {
    expect(summarizeProgress("TodoWrite", {})).toBe("");
  });

  it("falls back to the bare tool name for unknown tools, never their input", () => {
    const label = summarizeProgress("SomeNewTool", { arg: "sk-abc123def456ghi789jkl000" });
    expect(label).toBe("🔧 SomeNewTool");
  });
});

describe("summarizeProgress — codex shapes", () => {
  it("parses function_call shell with command array", () => {
    expect(summarizeProgress("shell", { command: ["bash", "-lc", "npm test"] })).toBe("🧪 執行測試");
  });

  it("surfaces tools.* calls from custom_tool_call exec input", () => {
    const js = 'const r = await tools.view_image({path:"/x.png"}); image(r.image_url);\n';
    expect(summarizeProgress("exec", js)).toBe("🔌 view_image");
  });
});

describe("summarizeProgress — kiro shapes", () => {
  it("labels kiro shell tool uses", () => {
    expect(summarizeProgress("shell", { command: "git status", __tool_use_purpose: "check" })).toBe("🔎 檢視 git 狀態");
  });

  it("labels kiro fs_read operations with the path", () => {
    const label = summarizeProgress("fs_read", { operations: [{ mode: "Line", path: "/home/x/config.json" }] });
    expect(label).toBe("📄 讀取檔案：/home/x/config.json");
  });
});

describe("summarizeProgress — opencode shapes", () => {
  it("labels opencode bash tool", () => {
    expect(summarizeProgress("bash", { command: "npm run build" })).toBe("🔨 建置／型別檢查");
  });

  it("labels opencode read tool via filePath", () => {
    expect(summarizeProgress("read", { filePath: "/w/a.ts" })).toBe("📄 讀取檔案：/w/a.ts");
  });
});

describe("ProgressAccumulator", () => {
  it("ignores empty labels and dedupes consecutive repeats", () => {
    const acc = new ProgressAccumulator();
    expect(acc.add("")).toBe(false);
    expect(acc.add("🧪 執行測試")).toBe(true);
    expect(acc.add("🧪 執行測試")).toBe(false);
    expect(acc.render()).toBe("🧪 執行測試");
  });

  it("keeps a rolling window of the newest lines", () => {
    const acc = new ProgressAccumulator(3);
    for (const l of ["a", "b", "c", "d"]) acc.add(l);
    expect(acc.render()).toBe("b\nc\nd");
  });

  it("allows a repeated label after an interleaving one", () => {
    const acc = new ProgressAccumulator();
    acc.add("a");
    acc.add("b");
    expect(acc.add("a")).toBe(true);
    expect(acc.render()).toBe("a\nb\na");
  });

  it("reset clears everything", () => {
    const acc = new ProgressAccumulator();
    acc.add("a");
    acc.reset();
    expect(acc.isEmpty()).toBe(true);
    expect(acc.render()).toBe("");
  });
});
