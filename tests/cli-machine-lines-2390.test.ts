/**
 * #2390 follow-up: the CLI chooses its language as the fleet does — an explicit defaults.locale, else the host's zone
 * (UTC+8 → zh-TW), else English — so `agend settings` and the other localized lines read like chat on a Taipei host.
 *
 * Lines another program reads stay English and byte-stable whatever the language: each is a plain literal where it is
 * printed (never a locale key), and its reader still looks for exactly it:
 * - update-launch: "Updating AgEnD v… → v…" / "Updating AgEnD to …" (the version for /update's fix hint) and
 *   "systemd does not know …";
 * - the Windows shortcuts and installer: "Fleet not running", "Setup page:", "Setup code:", "Setup complete",
 *   "Setup has already been completed";
 * - the rehearsal scripts: "Installed: v…".
 * And two English lines no other test held to the byte (Fable on #2402): bugreport.next_link and cli.service_redirect.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLocale, setLocale, t } from "../src/locale.js";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const dirs: string[] = [];
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real CLI on a scratch home, in a zone: `fleet logs` (removed) prints one localized line and changes nothing. */
function fleetLogs(tz: string, locale?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2390-locale-")); dirs.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (locale) writeFileSync(join(dir, "fleet.yaml"), `defaults:\n  locale: ${locale}\ninstances: {}\n`);
  const child = spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", "fleet", "logs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", TZ: tz, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  return child.stderr.trim();
}

describe("#2390 follow-up: the CLI's language is the fleet's", () => {
  it("a UTC+8 host with no locale reads zh-TW; UTC reads English; an explicit locale wins over the zone", () => {
    expect(fleetLogs("Asia/Taipei")).toBe("`agend fleet logs` 已移除，請改用 `agend logs`。");
    expect(fleetLogs("UTC")).toBe("`agend fleet logs` was removed. Use `agend logs`.");
    expect(fleetLogs("Asia/Taipei", "en")).toBe("`agend fleet logs` was removed. Use `agend logs`.");
    expect(fleetLogs("UTC", "zh-TW")).toBe("`agend fleet logs` 已移除，請改用 `agend logs`。");
  }, 60_000);

  it("the CLI decides it with the fleet's own detectLocale (one rule, not two)", () => {
    const cli = read("src/cli.ts");
    expect(cli).toContain("setLocale(detectLocale(configForLocale));");
    expect(cli).not.toMatch(/configuredLocale === "en" \|\| configuredLocale === "zh-TW"/);
    expect(read("src/fleet-manager.ts")).toMatch(/setLocale\(detectLocale\(/);
    expect([detectLocale({ defaults: { locale: "en" } }), detectLocale({ defaults: { locale: "zh-TW" } })]).toEqual(["en", "zh-TW"]);
  });
});

describe("#2390 follow-up: lines another program reads stay English", () => {
  const cli = read("src/cli.ts");
  const enValues = Object.values((() => { setLocale("en"); const keys = [...read("src/locale.ts").matchAll(/^\s+"([\w.-]+)": "/gm)].map((m) => m[1]!); return Object.fromEntries(keys.map((k) => [k, t(k)])); })());
  const MACHINE: Array<{ printed: string; where: string; reader: string; pattern: string }> = [
    { printed: "Updating AgEnD v${pkgVersion} → v${targetVersion} (its own installer)...", where: "src/cli.ts", reader: "src/update-launch.ts", pattern: "/Updating AgEnD v\\S+ → v(\\S+?)\\.\\.\\./" },
    { printed: "Updating AgEnD to ${tag}...", where: "src/cli.ts", reader: "src/update-launch.ts", pattern: "/Updating AgEnD to (\\S+?)\\.\\.\\./" },
    { printed: "systemd does not know ${name}", where: "src/service-activation.ts", reader: "src/update-launch.ts", pattern: "/systemd does not know /" },
    { printed: 'console.log("Fleet not running.")', where: "src/cli.ts", reader: "templates/windows-shortcuts.ps1", pattern: "-match 'Fleet not running'" },
    { printed: 'console.log("Fleet not running. Start with: agend start")', where: "src/cli.ts", reader: "website/public/install-agend.ps1", pattern: "-match 'Fleet not running'" },
    { printed: "Setup page: ${pageUrl}", where: "src/cli.ts", reader: "website/public/install-agend.ps1", pattern: "'Setup page:\\s*(https?://\\S+)'" },
    { printed: "Setup code: ${formatSetupCode(started.code)}", where: "src/cli.ts", reader: "website/public/install-agend.ps1", pattern: "'Setup code:\\s*([A-Z2-7]{4}-[A-Z2-7]{4})'" },
    { printed: 'this.log("Setup complete — starting AgEnD.")', where: "src/setup-host.ts", reader: "website/public/install-agend.ps1", pattern: "'Setup complete'" },
    { printed: "Setup has already been completed.", where: "src/cli.ts", reader: "website/public/install-agend.ps1", pattern: "'Setup has already been completed'" },
    { printed: "✓ Installed: v${newVersion}", where: "src/cli.ts", reader: "scripts/ci/runtime-acceptance/hop.sh", pattern: "Installed: " },
    // Fable on #2404: the Mac rehearsal leg (a UTC+8 host) reads the same line, and the restart refusal's variable name.
    { printed: "✓ Installed: v${newVersion}", where: "src/cli.ts", reader: "scripts/ci/runtime-acceptance/gui-rehearsal.sh", pattern: 'grep -q "Installed: $CAND"' },
    { printed: '"AGEND_NODE"]', where: "src/service-activation.ts", reader: "scripts/ci/runtime-acceptance/gui-rehearsal.sh", pattern: 'grep -q "AGEND_NODE"' },
    // npm's install refusals, read back by update-launch for /update's cause (plain .cjs, no locale — pinned all the same).
    { printed: "AgEnD cannot be installed here: ", where: "launcher/postinstall.cjs", reader: "src/update-launch.ts", pattern: "AgEnD cannot be installed here: .+|AgEnD 2\\.2 needs Node .+" },
    { printed: "AgEnD 2.2 needs Node >=22.14; npm is aborting this install.", where: "scripts/preinstall-guard.cjs", reader: "src/update-launch.ts", pattern: "AgEnD cannot be installed here: .+|AgEnD 2\\.2 needs Node .+" },
  ];

  it.each(MACHINE)("$where prints `$printed` as it is, and $reader still reads it", ({ printed, where, reader, pattern }) => {
    expect(read(where)).toContain(printed);
    expect(read(reader)).toContain(pattern);
  });

  it("none of them is a locale string (a key's English would turn into zh-TW on a Taipei host)", () => {
    // What each reader matches (update-launch's own regexes; the installers' -match texts), against every English value.
    for (const reader of [/Updating AgEnD v\S+ → v(\S+?)\.\.\./, /Updating AgEnD to (\S+?)\.\.\./, /systemd does not know /, /Fleet not running/, /Setup page:/,
      /Setup code:/, /Setup complete/, /Setup has already been completed/, /Installed: v/, /AgEnD cannot be installed here: /, /AgEnD 2\.2 needs Node /]) {
      expect(enValues.filter((v) => reader.test(v)), String(reader)).toEqual([]);
    }
    expect(cli).not.toMatch(/t\("[\w.]+"[^)]*\)[^;\n]*(Fleet not running|Setup page:|Setup code:)/);
  });

  it("the Windows shortcuts script is still the installer's copy (the same `Fleet not running` check in both)", () => {
    const ps1 = read("templates/windows-shortcuts.ps1"), installer = read("website/public/install-agend.ps1");
    expect(installer).toContain(ps1.split("\n").find((l) => l.includes("Fleet not running"))!.trim());
  });
});

describe("#2390 follow-up: English pinned to the byte (Fable's surviving mutants on #2402)", () => {
  it("bugreport.next_link and next_submit", () => {
    setLocale("en");
    expect(t("bugreport.next_link", "/r/out.json", "/r/out.json.md", "d1g")).toBe(
      "Local review snapshot: /r/out.json\nShareable redacted report file: /r/out.json.md\nNo report sent. Review the exact text above, then approve SHA256 d1g.\n"
      + "To generate the prefilled link: agend bug-report --draft <draft-file> --approve d1g\nIf you do not use GitHub, share the report Markdown file yourself. No upload is performed.");
    expect(t("bugreport.next_submit", "/r/out.json", "/r/out.json.md", "d1g")).toBe(
      "Local review snapshot: /r/out.json\nShareable redacted report file: /r/out.json.md\nNo report sent. Review the exact text above, then approve SHA256 d1g.\n"
      + "To submit with existing host gh login: agend bug-report --draft <draft-file> --approve d1g --submit\nIf you do not use GitHub, share the report Markdown file yourself. No upload is performed.");
  });

  it("cli.service_redirect", () => {
    setLocale("en");
    expect(t("cli.service_redirect", "systemd user unit", "stop")).toBe("ℹ An AgEnD service is installed here (systemd user unit): running `agend stop` so the service manager owns the fleet.");
  });
});
