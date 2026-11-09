/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    update: byDesign("Antigravity updates itself in the background and its `agy update` has no way to choose a release, so the dashboard only shows the installed and the audited versions."),
    chatLogin: yes({ aliases: ["agy"], mode: "declined" }),
    dashboardSignIn: byDesign("Bare `agy` is the whole agent CLI, not a login command, so it never gets the browser terminal (login-flows.ts: `remoteLogin: \"unsupported\"`)."),
    structuredSignIn: notYetBuilt("undecided", "`agy acp --login` (agy 1.5.0 and later) can be driven by the structured sign-in; not built on this registry yet."),
    firstRunSignIn: yes({ mode: "console", rank: 3 }),
    authCheck: yes({ argv: ["agy", "models"] }),
    identity: notYetBuilt("undecided", "Showing which account is signed in is not built yet."),
    namedAccounts: toVerify("Whether `agy` keeps its login where an environment variable can relocate it has not been checked."),
    signOut: toVerify("No `agy` logout command has been checked."),
    keepAlive: toVerify("Whether Antigravity's sign-in needs a keep-alive run has not been checked."),
    accountCard: yes({ rank: 3 }),
    usage: yes({ providerId: "antigravity", name: "Antigravity", rank: 5, profileRows: false }),
  },
  runtime: {
    provider: yes({
      name: "Antigravity", company: "Google", binaryNames: ["agy.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy. Plan mode and terminal sandboxing do not guarantee read-only workspace access.",
      promptTransport: "stdin-json", modelProbe: ["models"], rank: 2,
    }),
    install: byDesign("Antigravity installs with a vendor PowerShell script, not an npm package (runtime-cli-install.ts); the dashboard shows the official command for the computer's owner."),
    update: byDesign("Antigravity updates itself in the background and has no pinned install here; the dashboard only shows the installed and the audited versions."),
    signIn: notYetBuilt("undecided", "Antigravity signs in as the computer's own login, with no profile; not built on this registry yet."),
    namedAccounts: toVerify("Whether `agy` on Windows can keep more than one login side by side has not been checked."),
    accountRows: notYetBuilt("undecided", "No row per computer for Antigravity's own login yet."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for Antigravity (`authProbe` is null); asking `agy models` by its exit code is not built yet."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
