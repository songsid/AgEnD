/**
 * M-2797: with the network gone, `agend update` (chat /update, the web Update button, the shell) sat at "downloading" for
 * minutes, because npm waits up to 5 minutes for a silent connection and tries 3 times. The update now bounds npm with
 * npm's own settings, for every key nobody set, and a failure that is the network says so plainly.
 * Never spawns npm or the real `agend update`.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUpdateNpmBounds, dropUpdateNpmBounds, npmConfigQuery, parseNpmConfigLs, registryStop, registryUnreachable, updateRegistry, UPDATE_NPM_BOUNDS, UPDATE_NPM_MARKER, withoutUpdateNpmBounds } from "../src/update-npm-env.js";
import { createRequire } from "node:module";
import { openUpdateLog, updateLogPath, watchUpdateLaunch } from "../src/update-launch.js";
import { failureCause } from "../src/web-update.js";

/** `npm config ls` as npm 10.9 prints it (the rig's): only keys someone set, by source; overridden ones commented. */
const LS = (user: string, env = ""): string => `; "user" config from /home/rh/.npmrc\n\n${user}\n\n; "env" config from environment\n\n${env}\n\n; node bin location = /usr/local/bin/node\n; cwd = /tmp\n; Run \`npm config ls -l\` to show all defaults.\n`;
const NOTHING_SET = LS('prefix = "/home/rh/.npm-global"');

describe("M-2797: npm is bounded for the update, for every key nobody set", () => {
  it("asks npm what is set in one local call", () => {
    expect(npmConfigQuery()).toEqual(["config", "ls"]);
  });

  it("nothing set → a silent connection is given up after 30 s, tried twice, 2–10 s apart", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyUpdateNpmBounds(env, parseNpmConfigLs(NOTHING_SET))).toEqual(["fetch-timeout", "fetch-retries", "fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
    expect(env).toEqual({ npm_config_fetch_timeout: "30000", npm_config_fetch_retries: "1", npm_config_fetch_retry_mintimeout: "2000", npm_config_fetch_retry_maxtimeout: "10000",
      [UPDATE_NPM_MARKER]: "fetch-timeout,fetch-retries,fetch-retry-mintimeout,fetch-retry-maxtimeout" });
  });

  it("worst case for one request stays far below npm's own (about a minute, not a quarter of an hour)", () => {
    const v = Object.fromEntries(UPDATE_NPM_BOUNDS.map(([k, b]) => [k, Number(b)]));
    const worst = (v["fetch-retries"]! + 1) * v["fetch-timeout"]! + v["fetch-retries"]! * v["fetch-retry-maxtimeout"]!;
    expect(worst).toBeLessThanOrEqual(70_000);
    // ... while the timeout is an idle one: npm's agent maps fetch-timeout to "no byte for this long", never a cap on a download.
    expect(v["fetch-timeout"]).toBeGreaterThanOrEqual(30_000);
  });

  it("a person's own .npmrc value is kept (a slow proxy's longer timeout); the rest still bounded", () => {
    const env: NodeJS.ProcessEnv = {};
    applyUpdateNpmBounds(env, parseNpmConfigLs(LS("fetch-timeout = 600000")));
    expect(env.npm_config_fetch_timeout).toBeUndefined();
    expect(env.npm_config_fetch_retries).toBe("1");
  });

  it("Prism #3543: a value set explicitly to npm's own default (fetch-timeout=300000) is the person's choice and kept", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyUpdateNpmBounds(env, parseNpmConfigLs(LS("fetch-timeout = 300000\nfetch-retries = 2")))).toEqual(["fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
    expect(env.npm_config_fetch_timeout).toBeUndefined();
    expect(env.npm_config_fetch_retries).toBeUndefined();
  });

  it("a person's own npm_config_* variable is kept, in either case (and npm lists it under env too)", () => {
    const env: NodeJS.ProcessEnv = { npm_config_fetch_retries: "5", NPM_CONFIG_FETCH_TIMEOUT: "900000" };
    const set = applyUpdateNpmBounds(env, parseNpmConfigLs(LS('prefix = "/x"', "fetch-retries = 5\nfetch-timeout = 900000")));
    expect(set).toEqual(["fetch-retry-mintimeout", "fetch-retry-maxtimeout"]);
    expect(env.npm_config_fetch_retries).toBe("5");
    expect(env.npm_config_fetch_timeout).toBeUndefined();
  });

  it("npm could not be asked → bounded anyway (nothing is known to be set)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyUpdateNpmBounds(env, null)).toHaveLength(4);
    expect(env.npm_config_fetch_timeout).toBe("30000");
  });

  it("parses what is set, unquoted; comment lines (sources, facts, an overridden value) are not set", () => {
    const out = parseNpmConfigLs(LS('@songsid:registry = "http://registry:4873/"\n; fetch-timeout = 5 ; overridden by env\nregistry = "https://r.example/"'));
    expect([...out.entries()]).toEqual([["@songsid:registry", "http://registry:4873/"], ["registry", "https://r.example/"]]);
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
  it("the stop: an unreachable ping is a message to stop on; a ping that answered, or one that is not the network, is not", () => {
    expect(registryStop({ status: 1, stderr: "npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\n" }))
      .toBe("  ✗ Could not reach the update source (npm error code EAI_AGAIN). Nothing was changed; the current version keeps running.");
    expect(registryStop({ status: 0, stderr: "" })).toBeNull();
    expect(registryStop({ status: 1, stderr: "npm error code E404\n" })).toBeNull();
  });
  it("agend update pings after the bounds and before the version lookup, and stops on registryStop's answer (Fable #3544 F2)", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const action = cli.slice(cli.indexOf('.command("update")'));
    const bounds = action.indexOf("applyUpdateNpmBounds(process.env"), pinged = action.indexOf('registryStop(spawnSync("npm", ["ping", "--registry", registry]');
    expect(pinged).toBeGreaterThan(bounds);
    expect(action.indexOf("lookupTargetVersion(tag)")).toBeGreaterThan(pinged);
    // The exact stop, as one statement right after the ping: a dead branch (`if (false)`), a missing return or a stop that
    // is not recorded as the update's failure turns this red.
    const block = action.slice(pinged, action.indexOf("lookupTargetVersion(tag)"));
    expect(block).toMatch(/\n\s*if \(stop\) \{ console\.error\(`\\n\$\{stop\}\\n`\); setUpdateProgressStage\(DATA_DIR, "failed", \{ error: stop\.trim\(\) \}\); process\.exitCode = 1; return; \}\n/);
  });
  it("Prism #3543: the ping asks the registry AgEnD comes from — the @songsid scope's, else the registry, else npm's default; unknown config → no ping", () => {
    expect(updateRegistry(parseNpmConfigLs(LS('registry = "https://down.example/"\n@songsid:registry = "https://up.example/"')))).toBe("https://up.example/");
    expect(updateRegistry(parseNpmConfigLs(LS('registry = "https://mirror.example/"')))).toBe("https://mirror.example/");
    expect(updateRegistry(parseNpmConfigLs(NOTHING_SET))).toBe("https://registry.npmjs.org/");
    expect(updateRegistry(null)).toBeNull();
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    expect(cli).toContain('const stop = registry ? registryStop(spawnSync("npm", ["ping", "--registry", registry], ');
    expect(cli).toContain("const registry = updateRegistry(explicit);");
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

describe("M-2797 (Fable #3544 F1): the update's npm bounds end with the update", () => {
  const bounded = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { HOME: "/h", PATH: "/bin", npm_config_fetch_retries: "5" };        // the person's own retries
    applyUpdateNpmBounds(env, parseNpmConfigLs(NOTHING_SET));
    return env;
  };
  it("only what the update set is taken out; the person's own setting and everything else stay", () => {
    const env = bounded();
    expect(env.npm_config_fetch_timeout).toBe("30000");
    const after = withoutUpdateNpmBounds(env);
    expect(Object.keys(after).filter(k => /^npm_config_fetch/i.test(k) || k === UPDATE_NPM_MARKER)).toEqual(["npm_config_fetch_retries"]);
    expect(after).toMatchObject({ HOME: "/h", PATH: "/bin", npm_config_fetch_retries: "5" });
    expect(env.npm_config_fetch_timeout, "a copy: the update's own npm still has them").toBe("30000");
    dropUpdateNpmBounds(env);
    expect(env).toEqual(after);
  });
  it("an environment the update never touched is left as it is (no marker: nothing is ours)", () => {
    const env: NodeJS.ProcessEnv = { npm_config_fetch_timeout: "90000", HOME: "/h" };
    expect(withoutUpdateNpmBounds(env)).toEqual(env);
  });
  it("agend update: the restart's environment is without them, the compatibility install drops them before activation, and `fleet start` drops them on entry", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const action = cli.slice(cli.indexOf('.command("update")'));
    const restart = action.slice(action.indexOf('spawnSync(command, [...args, "restart"]'));
    expect(restart.slice(0, restart.indexOf("});"))).toContain('env: withOrigin("agend-update", withoutUpdateNpmBounds(process.env)),');
    const installed = action.indexOf("const installed = runUpdateInstall("), dropped = action.indexOf("dropUpdateNpmBounds(process.env);", installed);
    expect(dropped).toBeGreaterThan(installed);
    expect(action.indexOf("await activateVerified(installed, needsSudo);")).toBeGreaterThan(dropped);
    const start = cli.slice(cli.indexOf("const marked = process.env[DIRECT_FLEET_START_ENV]"));   // the top of `fleet start`
    expect(start.indexOf("dropUpdateNpmBounds(process.env);")).toBeGreaterThan(0);
    expect(start.indexOf("dropUpdateNpmBounds(process.env);")).toBeLessThan(400);
  });
  it("the release's own installer: npm install -g gets the bounds, the fleet's restart does not", () => {
    const req = createRequire(import.meta.url);
    const installer = req("../launcher/agend-install.cjs") as { withoutUpdateNpmBounds(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv };
    const env = bounded();
    expect(installer.withoutUpdateNpmBounds(env)).toEqual(withoutUpdateNpmBounds(env));    // the same rule in both places
    const src = readFileSync(join(__dirname, "..", "launcher", "agend-install.cjs"), "utf8");
    expect(src).toContain('var env = Object.assign({}, withoutUpdateNpmBounds(deps.env), { AGEND_RESTART_ORIGIN:');
    expect(src).toContain('deps.run(bin, ["install", "--no-activate"], { inherit: true, env: withoutUpdateNpmBounds(deps.env) })');
    expect(src).toContain("var npmEnv = Object.assign({}, deps.env);");                     // npm keeps them
  });
});
