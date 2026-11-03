import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeClientStore, runtimeJobDigest, validateRuntimeServer } from "../src/runtime-client-store.js";
import type { WindowsCliTask } from "../src/windows-cli.js";

const directories: string[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "agend-runtime-store-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
function task(id = randomUUID()): WindowsCliTask { return { id, cli: "codex", cwd: "C:\\work", sandbox: "read-only", status: "starting", startedAt: 100, output: "" }; }
const digest = runtimeJobDigest({ prompt: "private prompt" });

describe("runtime durable execution identity", () => {
  it("persists acceptance before launch without storing the prompt or machine credential", () => {
    const directory = home(), store = new RuntimeClientStore(directory), value = task();
    expect(store.accept(value, digest).duplicate).toBe(false);
    const saved = readFileSync(join(directory, "jobs.json"), "utf8");
    expect(saved).toContain(value.id); expect(saved).not.toContain("private prompt"); expect(saved).not.toContain("credential");
    expect(new RuntimeClientStore(directory).get(value.id)?.seq).toBe(1);
  });
  it("deduplicates the same ID and refuses changed arguments, including after restart", () => {
    const directory = home(), store = new RuntimeClientStore(directory), value = task(); store.accept(value, digest);
    expect(store.accept(value, digest).duplicate).toBe(true);
    expect(() => store.accept(value, runtimeJobDigest({ prompt: "changed" }))).toThrow(/different arguments/);
    expect(new RuntimeClientStore(directory).accept(value, digest).duplicate).toBe(true);
  });
  it("marks an interrupted launch as unknown only after exclusive runtime startup", () => {
    const directory = home(), value = task(); new RuntimeClientStore(directory).accept(value, digest);
    const statusReader = new RuntimeClientStore(directory); expect(statusReader.get(value.id)?.uncertain).toBe(false);
    const runtime = new RuntimeClientStore(directory, () => 999); runtime.recoverInterrupted();
    expect(runtime.get(value.id)).toMatchObject({ seq: 2, uncertain: true, task: { outcomeConfirmed: false, finishedAt: 999 } });
    expect(() => runtime.accept(task(), digest)).toThrow(/unconfirmed/);
    expect(runtime.accept(value, digest).duplicate).toBe(true);
  });
  it("requires confirmation to recover and preserves the used execution ID forever", () => {
    const directory = home(), store = new RuntimeClientStore(directory), value = task(); store.accept(value, digest); store.recoverInterrupted();
    expect(() => store.recover(value.id, false)).toThrow(/Confirm/);
    expect(store.recover(value.id, true)).toMatchObject({ uncertain: false, task: { outcomeConfirmed: true, status: "failed" } });
    expect(store.accept(value, digest).duplicate).toBe(true);
    expect(store.accept(task(), digest).duplicate).toBe(false);
  });
  it("snapshots have a monotonic persisted per-job sequence and bounded output", () => {
    const directory = home(), store = new RuntimeClientStore(directory), value = task(); store.accept(value, digest);
    const result = store.update({ ...value, status: "completed", output: "a".repeat(100_000), finishedAt: 200, outcomeConfirmed: true });
    expect(result.seq).toBe(2); expect(result.task.output).toHaveLength(65_536);
    const restarted = new RuntimeClientStore(directory); restarted.recoverInterrupted(); expect(restarted.get(value.id)?.seq).toBe(2);
  });
  it("rejects immutable snapshot identity changes", () => {
    const store = new RuntimeClientStore(home()), value = task(); store.accept(value, digest);
    expect(() => store.update({ ...value, cwd: "D:\\other" })).toThrow(/identity changed/);
  });
  it("fails closed on a corrupt or unrecognized ledger", () => {
    const directory = home(); writeFileSync(join(directory, "jobs.json"), JSON.stringify({ version: 99, jobs: {}, used: {} }));
    expect(() => new RuntimeClientStore(directory)).toThrow(/Invalid/);
  });
  it("uses canonical argument hashing", () => { expect(runtimeJobDigest({ a: 1, b: [2] })).toBe(runtimeJobDigest({ b: [2], a: 1 })); });
});

describe("runtime profile boundary", () => {
  it("accepts HTTPS and exact loopback HTTP, refusing credential URLs, remote HTTP and URL path/query", () => {
    for (const value of ["https://agend.example", "http://localhost:19280", "http://127.0.0.1:19280", "http://[::1]:19280"]) expect(validateRuntimeServer(value)).toBeInstanceOf(URL);
    for (const value of ["http://192.168.1.3:19280", "https://user:password@agend.example", "https://agend.example/path", "https://agend.example/?token=secret", "https://agend.example/#secret", "ws://localhost:19280"]) expect(() => validateRuntimeServer(value)).toThrow();
  });
  it("keeps connection secrets outside the execution journal", () => {
    const directory = home(), store = new RuntimeClientStore(directory), credentials = { server: "https://agend.example", machineId: randomUUID(), name: "Desk", credential: "b".repeat(64) };
    store.saveCredentials(credentials); expect(store.credentials()).toEqual(credentials);
    store.accept(task(), digest); expect(readFileSync(join(directory, "jobs.json"), "utf8")).not.toContain(credentials.credential);
    store.forgetCredentials(); expect(store.credentials()).toBeNull();
  });
  it("prevents two foreground runtimes using the same profile and releases only its own lock", () => {
    const store = new RuntimeClientStore(home()), unlock = store.lock("boot-one");
    expect(() => store.lock("boot-two")).toThrow(/Another runtime/); unlock();
    const unlockTwo = store.lock("boot-two"); unlock(); expect(() => store.lock("boot-three")).toThrow(/Another runtime/); unlockTwo();
  });
});

it("only a positive different Windows boot can supersede a reused live PID in a private lock",()=>{
 const directory=home(),store=new RuntimeClientStore(directory),first=store.lock("old-host","a".repeat(64));
 expect(()=>store.lock("same-boot","a".repeat(64))).toThrow("Another runtime");
 expect(()=>store.lock("unknown-boot")).toThrow("Another runtime");
 const second=store.lock("new-host","b".repeat(64));first();
 expect(JSON.parse(readFileSync(join(directory,"runtime.lock"),"utf8"))).toMatchObject({pid:process.pid,bootId:"new-host",systemBootId:"b".repeat(64)});
 expect(()=>store.lock("same-new-boot","b".repeat(64))).toThrow("Another runtime");second();
 const legacy=store.lock("legacy");expect(()=>store.lock("new-boot","c".repeat(64))).toThrow("Another runtime");legacy();
});
it("malformed boot proof cannot clear a held runtime lock",()=>{
 const directory=home(),store=new RuntimeClientStore(directory);const file=join(directory,"runtime.lock");
 writeFileSync(file,JSON.stringify({pid:process.pid,bootId:"old",systemBootId:"bad"}),{mode:0o600});
 expect(()=>store.lock("new","a".repeat(64))).toThrow("Invalid runtime boot proof");
 expect(()=>store.lock("new","bad")).toThrow("Invalid Windows boot proof");
 expect(JSON.parse(readFileSync(file,"utf8")).bootId).toBe("old");
});
