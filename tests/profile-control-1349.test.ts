import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, lstat, chmod, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No native inspector"); } } }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("No fleet/process"); }, execFile: () => { throw Error("No CLI"); } }));
import { ProfileControlServer, profileSocketPath, requestCpuProfile } from "../src/profile-control.js";
import { ProfileBusyError, type RuntimeCpuProfiler, type ProfileResult } from "../src/runtime-cpu-profile.js";
// Real standalone private Unix transport; no TCP, real fleet, inspector, tmux or service.
const dirs: string[] = [], servers: ProfileControlServer[] = [];
async function rig() {
  const directory = await mkdtemp(join(tmpdir(), "agend-profile-control-")); dirs.push(directory);
  await chmod(directory, 0o700);
  const start = vi.fn<(seconds: number) => Promise<{ seconds: number; done: Promise<ProfileResult> }>>(async (seconds: number) => ({ seconds, done: Promise.resolve({ path: join(directory, "capture.cpuprofile"), bytes: 55 }) }));
  const server = new ProfileControlServer(directory, { start } as unknown as RuntimeCpuProfiler); servers.push(server);
  return { directory, start, server };
}
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("same-user local-only operator transport", () => {
  it("creates 0700/0600 ownership boundaries, returns the saved path, and removes only its socket", async () => {
    const h = await rig(); await h.server.listen();
    const directory = await lstat(join(h.directory, "operator")), socket = await lstat(profileSocketPath(h.directory));
    expect(directory.mode & 0o777).toBe(0o700); expect(directory.uid).toBe(process.getuid!());
    expect(socket.isSocket()).toBe(true); expect(socket.mode & 0o777).toBe(0o600);
    expect(await requestCpuProfile(h.directory, undefined, {})).toEqual({ path: join(h.directory, "capture.cpuprofile"), bytes: 55 });
    expect(h.start).toHaveBeenCalledExactlyOnceWith(60); await h.server.close();
    await expect(lstat(profileSocketPath(h.directory))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses an agent environment and invalid durations before connection or recording", async () => {
    const h = await rig(); await h.server.listen();
    await expect(requestCpuProfile(h.directory, 1, { AGEND_INSTANCE_NAME: "agent" })).rejects.toThrow("operator");
    await expect(requestCpuProfile(h.directory, 1801, {})).rejects.toThrow();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("reports an absent fleet without starting one", async () => {
    const h = await rig(); await expect(requestCpuProfile(h.directory, 1, {})).rejects.toThrow("Running fleet");
    expect(h.start).not.toHaveBeenCalled();
  });
  it("propagates busy seconds without another capture", async () => {
    const h = await rig(); h.start.mockRejectedValueOnce(new ProfileBusyError(43)); await h.server.listen();
    await expect(requestCpuProfile(h.directory, 1, {})).rejects.toMatchObject({ remainingSeconds: 43 });
    expect(h.start).toHaveBeenCalledTimes(1);
  });
  it("refuses writable roots, symlink directories and non-socket paths without deleting them", async () => {
    const h = await rig(); await chmod(h.directory, 0o777); await expect(h.server.listen()).rejects.toThrow("without group/other write");
    const b = await rig(); await mkdir(join(b.directory, "target")); await symlink(join(b.directory, "target"), join(b.directory, "operator"));
    await expect(b.server.listen()).rejects.toThrow(); expect((await lstat(join(b.directory, "operator"))).isSymbolicLink()).toBe(true);
    const c = await rig(); await mkdir(join(c.directory, "operator")); await writeFile(profileSocketPath(c.directory), "keep");
    await expect(c.server.listen()).rejects.toThrow("non-owned/non-socket"); expect((await lstat(profileSocketPath(c.directory))).isFile()).toBe(true);
    expect(h.start).not.toHaveBeenCalled(); expect(b.start).not.toHaveBeenCalled(); expect(c.start).not.toHaveBeenCalled();
  });
  it("client fails closed if socket permissions lose their private boundary", async () => {
    const h = await rig(); await h.server.listen(); await chmod(profileSocketPath(h.directory), 0o666);
    await expect(requestCpuProfile(h.directory, 1, {})).rejects.toThrow("private socket"); expect(h.start).not.toHaveBeenCalled();
  });
  it("oversized/invalid protocol input does not start profiling", async () => {
    const h = await rig(); await h.server.listen();
    async function raw(data: string): Promise<string> {
      return new Promise((yes, no) => { let reply = ""; const socket = createConnection(profileSocketPath(h.directory));
        socket.once("connect", () => socket.write(data)); socket.on("data", b => { reply += b.toString(); }); socket.on("error", no); socket.on("close", () => yes(reply)); });
    }
    expect(await raw("x".repeat(257) + "\n")).toBe("");
    expect(await raw('{"seconds":1,"extra":true}\n')).toContain('"status":"error"');
    expect(await raw('{"seconds":1801}\n')).toContain('"status":"error"'); expect(h.start).not.toHaveBeenCalled();
  });
  it("closing drops waiting clients without starting another recording", async () => {
    const h = await rig(); let begin!: () => void; const started = new Promise<void>(r => { begin = r; });
    let done!: (value: ProfileResult) => void;
    h.start.mockImplementation(async seconds => { begin(); return { seconds, done: new Promise(r => { done = r; }) }; });
    await h.server.listen(); const client = requestCpuProfile(h.directory, 60, {}); const assertion = expect(client).rejects.toThrow("disconnected");
    await started; await h.server.close(); await assertion;
    done({ path: "/private/result", bytes: 1 }); await Promise.resolve(); expect(h.start).toHaveBeenCalledTimes(1);
  });
});
