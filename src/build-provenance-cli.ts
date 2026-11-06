import type { Command } from "commander";
import { readInstalledBuild } from "./build-provenance.js";

/** Read-only diagnostics; --version remains the package SemVer used by installers and update checks. */
export function registerBuildInfoCommand(program: Command): void {
  program.command("build-info").description("Show the installed package version and source-build identity")
    .option("--json", "Print structured build information")
    .action((options: { json?: boolean }) => {
      const build = readInstalledBuild();
      console.log(options.json ? JSON.stringify(build) : `${build.label}\nPackage: ${build.version}${build.source?.commit ? `\nSource: ${build.source.ref ?? "detached"} @ ${build.source.commit}` : "\nSource: unavailable"}`);
    });
}
