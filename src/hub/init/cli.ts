/**
 * Composition for `agend hub init` and quickstart's "team Hub" choice. Real terminal, real files, the existing
 * service installer. Hub key material comes from S1 (src/hub/tls.ts, hub-s48-init); until that ships, the command
 * stops before asking anything and changes nothing.
 */
import { installedBuildLabel, readInstalledBuild } from "../../build-provenance.js";
import { ht } from "./text.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAgendHome } from "../../agend-home.js";
import { canonicalCliEntry } from "../../cli-entry.js";
import { getAgendHome } from "../../paths.js";
import { createHubDirectory } from "../directory/index.js";
import { realFleetProbe } from "./existing-fleet.js";
import { hubIdentityProvider } from "./identity.js";
import { inspectDirectoryCertificate, fetchDirectoryCa } from "./directory-certificate.js";
import { readHubSecretFile } from "./secret-file.js";
import { createBrowserCertificate, recoverBrowserCertificate } from "./browser-certificate.js";
import { createHubInitializer } from "./initializer.js";
import { terminalIO } from "./prompt.js";
import type { HubIdentityProvider } from "./types.js";
import { runHubInitWizard, type HubServiceControl, type HubWizardOutcome } from "./wizard.js";

const SERVICE_LABEL = "com.agend.fleet";

async function realService(home: string): Promise<HubServiceControl> {
  const installer = await import("../../service-installer.js");
  return {
    installed: () => installer.inspectService(SERVICE_LABEL).installed,
    async install(): Promise<string> {
      const path = installer.installService({
        label: SERVICE_LABEL,
        execPath: canonicalCliEntry(),
        path: process.env.PATH ?? "",
        workingDirectory: home,
        logPath: join(home, "fleet.log"),
      });
      installer.activateService(path, join(home, "fleet.pid"));
      return path;
    },
  };
}

export async function runHubInitCommand(identity: HubIdentityProvider = hubIdentityProvider()): Promise<HubWizardOutcome> {
  if (!process.stdin.isTTY) {
    console.error("Error: agend hub init needs an interactive terminal (it asks for passwords without echoing them).");
    process.exitCode = 1;
    return "refused";
  }
  if (!identity.available) {
    console.error("agend hub init: Hub key generation is not available in this build yet (it ships with the Hub transport). Nothing was changed.");
    process.exitCode = 1;
    return "refused";
  }
  const home = getAgendHome();
  ensureAgendHome(home, { create: true, label: "AgEnD home" });
  const service = await realService(home);
  const initializer = createHubInitializer({ home, identity, probe: realFleetProbe() });
  const io = terminalIO();
  const build = readInstalledBuild();
  io.say(ht("build_info", installedBuildLabel(build.version, build.source,
    { source: ht("build_source"), modified: ht("build_modified"), unknown: ht("build_unknown") }), build.version));
  const outcome = await runHubInitWizard({
    io,
    home,
    initializer,
    createDirectory: createHubDirectory,
    readFile: (path) => readFileSync(path, "utf8"),
    createBrowserCertificate: origin => createBrowserCertificate(home, origin),
    recoverBrowserCertificate: plan => recoverBrowserCertificate(home, plan.webOrigin, plan.webTls),
    directoryCertificates: { inspect: inspectDirectoryCertificate, fetch: fetchDirectoryCa },
    readSecretFile: readHubSecretFile,
    service,
  });
  if (outcome === "refused") process.exitCode = 1;
  return outcome;
}
