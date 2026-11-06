/** Real rendering/private files only. Service managers, PIDs and the pilot are untouched. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchdServiceDomain, launchdSessionType } from "../src/launchd-service-domain.js";
import { renderLaunchdPlist, renderSystemdUnit, serviceHomeFor } from "../src/service-installer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const vars = { label: "com.agend.fleet", execPath: "/opt/agend/dist/cli.js", nodePath: "/opt/node/bin/node", path: "/usr/bin:/bin",
  workingDirectory: "/home/example/hub home", logPath: "/home/example/hub home/fleet.log", agendHome: "/home/example/hub home" };

describe("Hub service definition keeps its home and background session", () => {
  it("renders the Hub home explicitly on both managers, adding Background only for the Hub plist", () => {
    const plist = renderLaunchdPlist({ ...vars, launchdSessionType: "Background" });
    expect(plist).toContain("<key>LimitLoadToSessionType</key>\n    <string>Background</string>");
    expect(plist).toContain("<key>AGEND_HOME</key>\n        <string>/home/example/hub home</string>");
    expect(plist).toContain("<string>/opt/node/bin/node</string>"); expect(plist).toContain("<string>fleet</string>");
    expect(renderLaunchdPlist(vars)).not.toContain("LimitLoadToSessionType");
    const unit = renderSystemdUnit({ ...vars, launchdSessionType: "Background" });
    expect(unit).toContain('Environment="AGEND_HOME=/home/example/hub home"');
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/agend/dist/cli.js" fleet start');
    expect(unit).not.toContain("LimitLoadToSessionType");
  });
  it.each([true, false])("preserves Background through ordinary service refresh/install (refresh=%s)", refresh => {
    const old = renderLaunchdPlist({ ...vars, launchdSessionType: "Background" });
    const where = serviceHomeFor(vars.agendHome, { refresh, existingDefinition: old, isDefault: () => false });
    expect(where).toEqual({ workingDirectory: vars.agendHome, logPath: vars.logPath, agendHome: vars.agendHome, launchdSessionType: "Background" });
    expect(launchdSessionType(renderLaunchdPlist({ ...vars, ...where }))).toBe("Background");
  });
  it.each([null, "Background", "<key>Other</key><string>Background</string>", "<key>LimitLoadToSessionType</key><string>Aqua</string>"])("retains the existing GUI choice for %j", definition => {
    expect(launchdSessionType(definition)).toBeUndefined();
  });
  it("selects user/<uid> for the installed background definition and gui/<uid> for an ordinary one", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-hub-service-")); roots.push(home);
    const folder = join(home, "Library", "LaunchAgents"), file = join(folder, "com.agend.fleet.plist"); mkdirSync(folder, { recursive: true });
    expect(launchdServiceDomain(undefined, { home, uid: 501 })).toBe("gui/501");
    writeFileSync(file, renderLaunchdPlist({ ...vars, launchdSessionType: "Background" }));
    expect(launchdServiceDomain(undefined, { home, uid: 501 })).toBe("user/501");
    writeFileSync(file, renderLaunchdPlist(vars)); expect(launchdServiceDomain(undefined, { home, uid: 501 })).toBe("gui/501");
  });
  it("does not guess a domain when an installed definition cannot be read", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-hub-service-")); roots.push(home);
    mkdirSync(join(home, "Library", "LaunchAgents", "com.agend.fleet.plist"), { recursive: true });
    expect(() => launchdServiceDomain(undefined, { home, uid: 501 })).toThrow("no launchd domain was selected");
  });
  it("ignores comments and nested environment fields, and refuses duplicate root choices", () => {
    const key = "<key>LimitLoadToSessionType</key><string>Background</string>";
    expect(launchdSessionType(`<plist><dict><!--${key}--></dict></plist>`)).toBeUndefined();
    expect(launchdSessionType(`<plist><dict><key>EnvironmentVariables</key><dict>${key}</dict></dict></plist>`)).toBeUndefined();
    expect(() => launchdSessionType(`<plist><dict>${key}${key}</dict></plist>`)).toThrow("Ambiguous");
  });
});
