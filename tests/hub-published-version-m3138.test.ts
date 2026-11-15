import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), env: vi.fn() }));
vi.mock("../src/child-process.js", async () => {
  const { promisify } = await import("node:util"); const execFile = () => {};
  Object.assign(execFile, { [promisify.custom]: mocks.run }); return { execFile };
});
vi.mock("../src/update-dispatch.js", () => ({ npmEnvForUpdate: mocks.env }));
import { createPublishedVersionLookup } from "../src/hub/published-version.js";
afterEach(() => vi.resetAllMocks());
it("uses only the installed npm environment and exact AgEnD package/version, with fixed argv and bounds", async () => {
  const env = { PATH: "/owned/npm" }; mocks.env.mockResolvedValue({ ok: true, env }); mocks.run.mockResolvedValue({ stdout: '"2.4.0-beta.4"' });
  const lookup = createPublishedVersionLookup(); expect(await lookup("2.4.0-beta.4")).toBe("found");
  expect(mocks.run).toHaveBeenCalledWith("npm", ["view", "@songsid/agend@2.4.0-beta.4", "version", "--json"], { env, timeout: 15_000, maxBuffer: 16384 });
  for (const input of ["latest", "--help", "$(anything)", "1.0.0\n"]) expect(await lookup(input)).toBe("not-found");
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
it("distinguishes missing releases from npm/provenance outages and rejects a mismatched response", async () => {
  mocks.env.mockResolvedValue({ ok: true, env: {} }); const lookup = createPublishedVersionLookup();
  mocks.run.mockRejectedValueOnce({ stderr: "npm error E404" }); expect(await lookup("2.4.0")).toBe("not-found");
  mocks.run.mockRejectedValueOnce({ stderr: "ENOTFOUND" }); expect(await lookup("2.4.0")).toBe("unavailable");
  mocks.run.mockResolvedValueOnce({ stdout: '"9.0.0"' }); expect(await lookup("2.4.0")).toBe("not-found");
  mocks.env.mockResolvedValueOnce({ ok: false }); expect(await lookup("2.4.0")).toBe("unavailable"); expect(mocks.run).toHaveBeenCalledTimes(3);
});
it("coalesces same-version checks and bounds concurrent work without caching a stale result", async () => {
  mocks.env.mockResolvedValue({ ok: true, env: {} }); let release!: (v: { stdout: string }) => void;
  mocks.run.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const lookup = createPublishedVersionLookup(), first = lookup("2.4.0"); expect(lookup("2.4.0")).toBe(first);
  const others = [lookup("2.4.1"), lookup("2.4.2"), lookup("2.4.3")]; expect(await lookup("2.4.4")).toBe("unavailable");
  await Promise.resolve(); expect(mocks.run).toHaveBeenCalledTimes(4);
  // Resolve only the last check; the other pending inert promises have no handles.
  release({ stdout: '"2.4.3"' }); await others[2]; mocks.run.mockResolvedValue({ stdout: '"2.4.3"' });
  expect(await lookup("2.4.3")).toBe("found"); expect(mocks.run).toHaveBeenCalledTimes(5);
});
