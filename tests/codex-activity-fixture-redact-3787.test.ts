/**
 * #3787: the script that redacts a real Codex rollout into a test fixture (scripts/manual/codex-activity-fixture/redact.mjs)
 * refuses to write a file that still holds a one-time or authorization code — whichever side of its label the code is on, and
 * an OAuth code of a provider's own style — and what it says when it refuses is the category and the place, never the value:
 * stderr is as public as the fixture. Every value below is invented; no real credential is used.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "manual", "codex-activity-fixture", "redact.mjs");
const FIXTURE = join(import.meta.dirname, "fixtures", "chat-activity-3787", "codex-0.160.0-web-chat.jsonl");
const real = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-redact-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A record of the real capture's shape, its text replaced: a person's message, or a tool's output. */
const shapeOf = (pick: (p: any) => boolean): any => JSON.parse(real.find((l) => pick(JSON.parse(l).payload ?? {}))!);
const userShape = () => shapeOf((p) => p.type === "message" && p.role === "user" && JSON.stringify(p).includes("user.text"));
const outputShape = () => shapeOf((p) => p.type === "custom_tool_call_output");
const withUserText = (text: string): string => { const r = userShape(); r.payload.content = [{ type: "input_text", text }]; return JSON.stringify(r); };
const withOutputText = (text: string): string => { const r = outputShape(); r.payload.output = [{ type: "input_text", text: `Script completed\nWall time 0.1 seconds\nOutput:\n${text}` }]; return JSON.stringify(r); };

function run(extra: string[]): { status: number | null; stderr: string; stdout: string; out: string; line: number } {
  const dir = temp();
  const src = join(dir, "in.jsonl"), out = join(dir, "out.jsonl");
  const lines = [...real.slice(0, 10), ...extra, ...real.slice(10)];
  writeFileSync(src, lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [SCRIPT, src, out, "/home/someone/work/project"], { encoding: "utf8", env: { ...process.env, USER: "someone" } });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, out, line: 11 };
}

const CASES: Array<[string, string, string[]]> = [
  ["a six-digit code after its label (`code: 123456`)", "482913", [withUserText("Here it is, code: 482913 — please use it.")]],
  ["a code before its label (`482913 is your code`)", "482913", [withUserText("482913 is your code for signing in")]],
  ["a verification code after its label, in a sentence", "739204", [withUserText("Your verification code is 739204.")]],
  ["a code before `verification code`", "739204", [withUserText("739204 is your verification code")]],
  ["a code on the line after its label", "661827", [withOutputText("Verification code:\n661827")]],
  ["an alphanumeric one-time code", "K7Q-4M9X", [withUserText("one-time code K7Q-4M9X")]],
  ["a provider-style OAuth authorization code", "4/0AInventedCodeForTheTest1234567890abcdefXYZ", [withUserText("paste this: 4/0AInventedCodeForTheTest1234567890abcdefXYZ")]],
  ["an authorization code in a callback URL", "ac_invented_9f8e7d6c5b4a", [withOutputText("http://localhost:1455/auth/callback?code=ac_invented_9f8e7d6c5b4a&state=st_invented_1a2b3c4d")]],
  ["a JSON field named code", "inv-9f8e7d6c5b4a3210", [withOutputText('{"code":"inv-9f8e7d6c5b4a3210","scope":"read"}')]],
  ["an API key shape", "sk-InventedKeyForTheTest0000", [withUserText("my key is sk-InventedKeyForTheTest0000")]],
  ["a bearer token", "InventedBearerValue0123456789", [withOutputText("Authorization: Bearer InventedBearerValue0123456789")]],
  ["an email address", "someone.invented@example.org", [withUserText("mail me at someone.invented@example.org")]],
];

describe("the fixture redactor refuses a code, and never prints what it refused", () => {
  it.each(CASES)("%s: exit 1, nothing written, the value is in no output", (_what, value, extra) => {
    const r = run(extra);
    expect(r.status, r.stderr).toBe(1);
    expect(existsSync(r.out)).toBe(false);
    expect(r.stderr).toMatch(/^refusing to write: .+ left in output record \d+ \(line 11 of the rollout\)\n$/);
    expect(r.stderr).not.toContain(value);
    expect(r.stdout).not.toContain(value);
    for (const part of value.split(/[-/_]/).filter((x) => x.length >= 5)) { expect(r.stderr).not.toContain(part); expect(r.stdout).not.toContain(part); }
  });
  it("a line that is not JSON is refused by its line number, without the text JSON.parse would quote", () => {
    const r = run(['{"timestamp": "inventedsecretvalue0123456789", this is not json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("refusing to write: line 11 of the rollout is not JSON\n");
    expect(r.stderr).not.toContain("inventedsecretvalue");
    expect(existsSync(r.out)).toBe(false);
  });
  it("the real capture's shapes pass, and the file is written (the scan does not refuse what a rollout normally holds)", () => {
    const r = run([withUserText("Please run `wc -l notes.txt` and tell me the exit code (usually 0, sometimes 127)."), withOutputText("Process exited with code 1\nnotes.txt: No such file or directory")]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(r.out)).toBe(true);
    expect(readFileSync(r.out, "utf8").split("\n").filter(Boolean)).toHaveLength(real.length + 2);
  });
  it("the committed fixture itself is clean under the scan (it was written by this script)", () => {
    const dir = temp();
    const out = join(dir, "out.jsonl");
    const r = spawnSync(process.execPath, [SCRIPT, FIXTURE, out, "/home/user/project"], { encoding: "utf8", env: { ...process.env, USER: "someone" } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(real.length);
  });
  it("what it keeps keeps the real record's shape: the same types, in the same order", () => {
    const r = run([withUserText("nothing secret here")]);
    expect(r.status, r.stderr).toBe(0);
    const types = (ls: string[]) => ls.map((l) => { const e = JSON.parse(l); return `${e.type}/${e.payload?.type}`; });
    const got = types(readFileSync(r.out, "utf8").split("\n").filter(Boolean));
    const want = types([...real.slice(0, 10), withUserText("x"), ...real.slice(10)]);
    expect(got).toEqual(want);
  });
});
