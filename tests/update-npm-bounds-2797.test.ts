/**
 * M-2797: with the network gone, `agend update` (chat /update, the web Update button, the shell) sat at "downloading" for
 * minutes, because npm waits up to 5 minutes for a silent connection and tries 3 times. The update now bounds npm with
 * npm's own settings, only where npm's default is still in force, and a failure that is the network says so plainly.
 * Never spawns npm or the real `agend update`.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUpdateNpmBounds, npmBoundsQuery, parseNpmConfigGet, registryUnreachable, UPDATE_NPM_BOUNDS } from "../src/update-npm-env.js";
import { openUpdateLog, updateLogPath, watchUpdateLaunch } from "../src/update-launch.js";
import { failureCause } from "../src/web-update.js";

const NPM_DEFAULTS = "fetch-timeout=300000\nfetch-retries=2\nfetch-retry-mintimeout=10000\nfetch-retry-maxtimeout=60000\n";

describe("M-2797: npm is bounded for the update, where npm's default is still in force", () => {
  it("asks npm for the four settings in one local call", () => {
    expect(npmBoundsQuery()).toEqual(["config", "get", "fetch-timeout", "fetch-retries", "fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
  });

  it("npm's defaults → a silent connection is given up after 30 s, tried twice, 2–10 s apart", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyUpdateNpmBounds(env, parseNpmConfigGet(NPM_DEFAULTS))).toEqual(["fetch-timeout", "fetch-retries", "fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
    expect(env).toEqual({ npm_config_fetch_timeout: "30000", npm_config_fetch_retries: "1", npm_config_fetch_retry_mintimeout: "2000", npm_config_fetch_retry_maxtimeout: "10000" });
  });

  it("worst case for one request stays far below npm's own (minutes, not a quarter of an hour)", () => {
    const v = Object.fromEntries(UPDATE_NPM_BOUNDS.map(([k, , b]) => [k, Number(b)]));
    const worst = (v["fetch-retries"]! + 1) * v["fetch-timeout"]! + v["fetch-retries"]! * v["fetch-retry-maxtimeout"]!;
    expect(worst).toBeLessThanOrEqual(70_000);
    // ... while the timeout is an idle one: npm's agent maps fetch-timeout to "no byte for this long", never a cap on a download.
    expect(v["fetch-timeout"]).toBeGreaterThanOrEqual(30_000);
  });

  it("a person's own .npmrc value is kept (a slow proxy's longer timeout); the rest still bounded", () => {
    const env: NodeJS.ProcessEnv = {};
    applyUpdateNpmBounds(env, parseNpmConfigGet(NPM_DEFAULTS.replace("fetch-timeout=300000", "fetch-timeout=600000")));
    expect(env.npm_config_fetch_timeout).toBeUndefined();
    expect(env.npm_config_fetch_retries).toBe("1");
  });

  it("a person's own npm_config_* variable is kept, in either case", () => {
    const env: NodeJS.ProcessEnv = { npm_config_fetch_retries: "5", NPM_CONFIG_FETCH_TIMEOUT: "900000" };
    const set = applyUpdateNpmBounds(env, parseNpmConfigGet(NPM_DEFAULTS));
    expect(set).toEqual(["fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
    expect(env.npm_config_fetch_retries).toBe("5");
    expect(env.npm_config_fetch_timeout).toBeUndefined();
  });

  it("npm could not be asked → bounded anyway (an unknown setting is read as npm's default)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyUpdateNpmBounds(env, null)).toHaveLength(4);
    expect(env.npm_config_fetch_timeout).toBe("30000");
  });

  it("parses npm's `key=value` lines and leaves out what does not parse", () => {
    expect([...parseNpmConfigGet("fetch-timeout=300000\nnoise\n  fetch-retries = 2 \n").entries()]).toEqual([["fetch-timeout", "300000"]]);
  });

  it("agend update sets the bounds before its first npm (the version lookup)", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const action = cli.slice(cli.indexOf('.command("update")'));
    const bounds = action.indexOf("applyUpdateNpmBounds(process.env");
    expect(bounds).toBeGreaterThan(0);
    for (const npmCall of ["lookupTargetVersion(tag)", 'execSync("npm config get prefix"', "preflightUpdate(", 'spawnSync("npm", ["view", pkg', 'spawnSync("npm", ["exec"', "runUpdateInstall("]) {
      const at = action.indexOf(npmCall);
      expect(at, npmCall).toBeGreaterThan(bounds);
    }
  });
});

describe("M-2797 (rig): the registry is asked before anything, never a stale cache", () => {
  const ping = (stderr: string, status: number | null = 1) => registryUnreachable({ status, stderr });
  it("no network (the rig's cut: EAI_AGAIN), refused, a silent registry → unreachable, with npm's code", () => {
    expect(ping("npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\n")).toBe("npm error code EAI_AGAIN");
    expect(ping("npm ERR! code ECONNREFUSED\n")).toBe("npm error code ECONNREFUSED");
    expect(ping("npm error code FETCH_ERROR\nnpm error network timeout at: http://registry/-/ping?write=true\n")).toBe("npm error code FETCH_ERROR");
    expect(ping("npm error code EIDLETIMEOUT\n")).toBe("npm error code EIDLETIMEOUT");
  });
  it("a registry that does not implement ping, an answer, or npm that did not run → the update goes on", () => {
    expect(ping("npm error code E404\nnpm error 404 Not Found - GET https://nexus.example/-/ping\n")).toBeNull();
    expect(ping("", 0)).toBeNull();
    expect(ping("npm error code E500\n")).toBeNull();
    expect(registryUnreachable({ status: null, stderr: "", error: new Error("spawnSync npm ENOENT") })).toBeNull();
    expect(ping("something went wrong\n")).toBeNull();
  });
  it("agend update pings after the bounds and before the version lookup, and an unreachable registry stops it as failed", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const action = cli.slice(cli.indexOf('.command("update")'));
    const bounds = action.indexOf("applyUpdateNpmBounds(process.env"), pinged = action.indexOf('spawnSync("npm", ["ping"]');
    expect(pinged).toBeGreaterThan(bounds);
    expect(action.indexOf("lookupTargetVersion(tag)")).toBeGreaterThan(pinged);
    const stop = action.slice(pinged, action.indexOf("lookupTargetVersion(tag)"));
    expect(stop).toContain('setUpdateProgressStage(DATA_DIR, "failed"');
    expect(stop).toContain("return;");
  });
  it("its message is the network to the page and to chat", () => {
    expect(failureCause("✗ Could not reach the update source (npm error code EAI_AGAIN). Nothing was changed; the current version keeps running.")).toBe("network");
  });
});

describe("M-2797: a failure that is the network is said plainly", () => {
  it("npm's own timeout codes are the network too", () => {
    for (const e of ["npm error code EIDLETIMEOUT — npm error Idle timeout reached for host `registry.npmjs.org:443`",
      "npm error code ECONNECTIONTIMEOUT", "npm error code ERESPONSETIMEOUT", "npm error code ETRANSFERTIMEOUT",
      "npm error network timeout at: https://registry.npmjs.org/@songsid%2fagend",
      // the rig's registry that never answers: what the marker keeps is the code line and the next one
      "Cause: npm error code FETCH_ERROR — npm error errno FETCH_ERROR."]) expect(failureCause(e), e).toBe("network");
  });

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-2797-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (output: string): string => {
    const logPath = updateLogPath(dir);
    const opened = openUpdateLog(logPath, "--- run ---");
    if (!opened) throw new Error("no log");
    writeSync(opened.fd, output); closeSync(opened.fd);
    const child = new EventEmitter() as any;
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, opened.offset);
    child.emit("exit", 1, null);
    return messages[0]!;
  };

  it("chat /update: an unreachable registry leads with 'could not reach the update source; the current version keeps running'", () => {
    const m = run("npm error code EIDLETIMEOUT\nnpm error Idle timeout reached for host `registry:4873`\n  Failed to update; the current install was not touched.\n");
    expect(m).toMatch(/^Could not reach the update source, so nothing was changed and the current version keeps running/);
    expect(m).not.toContain("could not finish the update automatically");
    expect(m).toContain("Cause: npm error code EIDLETIMEOUT");             // the detail stays, after the plain words
  });

  it("a registry that never answers (npm FETCH_ERROR, the rig's 16-minute baseline) is the network too", () => {
    const m = run("npm error code FETCH_ERROR\nnpm error errno FETCH_ERROR\nnpm error network timeout at: http://127.0.0.1:4875/@songsid%2fagend\n");
    expect(m).toMatch(/^Could not reach the update source/);
  });

  it("anything else keeps its own words", () => {
    const m = run("npm error code EACCES\nnpm error permission denied\n");
    expect(m).toMatch(/^AgEnD could not finish the update automatically/);
  });
});
