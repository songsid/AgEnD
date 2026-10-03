/**
 * #1126: a throwaway fleet run with HOME and AGEND_HOME both pointed at a
 * scratch directory got tmux's DEFAULT socket — "default home" meant
 * AGEND_HOME === $HOME/.agend — attached to the live fleet's server, and its
 * startup cleanup killed 16 live windows as orphans (2026-10-03). "Default"
 * now means the user's REAL home (password database), not $HOME.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTmuxSessionName, getTmuxSocketName, isDefaultAgendHome } from "../src/paths.js";

const realAgendHome = join(userInfo().homedir, ".agend");
const hashed = (home: string) => "agend-" + createHash("sha256").update(home).digest("hex").slice(0, 6);
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1126-")); dirs.push(d); return d; };

describe("only the user's real AgEnD home uses tmux's default socket (#1126)", () => {
  it("AGEND_HOME = the real ~/.agend → default socket and session, as always (no migration)", () => {
    vi.stubEnv("AGEND_HOME", realAgendHome);
    expect(isDefaultAgendHome()).toBe(true);
    expect(getTmuxSocketName()).toBeNull();
    expect(getTmuxSessionName()).toBe("agend");
  });

  it("AGEND_HOME unset with the real HOME → default, as always", () => {
    vi.stubEnv("AGEND_HOME", "");
    vi.stubEnv("HOME", userInfo().homedir);
    expect(getTmuxSocketName()).toBeNull();
    expect(getTmuxSessionName()).toBe("agend");
  });

  it("the 2026-10-03 failure: HOME and AGEND_HOME both moved to a scratch dir → an isolated socket", () => {
    const home = scratch();
    vi.stubEnv("HOME", home);
    vi.stubEnv("AGEND_HOME", join(home, ".agend"));
    expect(isDefaultAgendHome()).toBe(false);
    expect(getTmuxSocketName()).toBe(hashed(join(home, ".agend")));
    expect(getTmuxSessionName()).toBe(hashed(join(home, ".agend")));
  });

  it("HOME moved, AGEND_HOME unset → isolated too (a scratch $HOME/.agend is not the user's fleet)", () => {
    const home = scratch();
    vi.stubEnv("HOME", home);
    vi.stubEnv("AGEND_HOME", "");
    expect(getTmuxSocketName()).toBe(hashed(join(home, ".agend")));
  });

  it("an existing custom AGEND_HOME keeps exactly the socket it had (same hash input, no migration)", () => {
    vi.stubEnv("AGEND_HOME", "/srv/agend-team");
    expect(getTmuxSocketName()).toBe(hashed("/srv/agend-team"));
    // A spelling that is not byte-equal to the real home stays custom, as before.
    vi.stubEnv("AGEND_HOME", `${realAgendHome}/`);
    expect(getTmuxSocketName()).toBe(hashed(`${realAgendHome}/`));
  });
});

describe("in a real child process with the incident's environment (built paths.js; no fleet is started)", () => {
  const built = join(process.cwd(), "dist", "paths.js");
  it.skipIf(!existsSync(built))("a scratch HOME + AGEND_HOME never resolves to the default tmux socket", () => {
    const home = scratch();
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { getTmuxSocketName, getTmuxSessionName } from ${JSON.stringify(built)}; console.log(JSON.stringify([getTmuxSocketName(), getTmuxSessionName()]));`],
    { encoding: "utf8", env: { ...process.env, HOME: home, AGEND_HOME: join(home, ".agend") } });
    expect(r.status, r.stderr).toBe(0);
    const [socket, session] = JSON.parse(r.stdout.trim());
    expect(socket).toBe(hashed(join(home, ".agend")));
    expect(session).not.toBe("agend");
  });

  // The password database unreadable (os.userInfo throws, e.g. no NSS entry):
  // $HOME must not stand in for the real home (#1128 review).
  function withoutPasswd(env: Record<string, string>) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      os.userInfo = () => { const e = new Error("uv_os_get_passwd returned ENOENT"); e.code = "ERR_SYSTEM_ERROR"; throw e; };
      syncBuiltinESMExports();
      const { getTmuxSocketName, getTmuxSessionName, isDefaultAgendHome } = await import(${JSON.stringify(built)});
      console.log(JSON.stringify([getTmuxSocketName(), getTmuxSessionName(), isDefaultAgendHome()]));`],
    { encoding: "utf8", env: { ...process.env, AGEND_HOME: "", ...env } });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim()) as [string | null, string, boolean];
  }

  it.skipIf(!existsSync(built))("passwd unreadable, AGEND_HOME = $HOME/.agend → isolated, not the default socket", () => {
    const home = scratch();
    const [socket, session, isDefault] = withoutPasswd({ HOME: home, AGEND_HOME: join(home, ".agend") });
    expect(isDefault).toBe(false);
    expect(socket).toBe(hashed(join(home, ".agend")));
    expect(session).toBe(hashed(join(home, ".agend")));
  });

  it.skipIf(!existsSync(built))("passwd unreadable, AGEND_HOME unset → isolated too", () => {
    const home = scratch();
    const [socket, session, isDefault] = withoutPasswd({ HOME: home });
    expect(isDefault).toBe(false);
    expect(socket).toBe(hashed(join(home, ".agend")));
    expect(session).toBe(hashed(join(home, ".agend")));
  });
});
