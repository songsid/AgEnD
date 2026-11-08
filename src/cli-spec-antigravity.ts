/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    chatLogin: yes({ aliases: ["agy"], mode: "declined" }),
    dashboardSignIn: byDesign("Bare `agy` is the whole agent CLI, not a login command, so it never gets the browser terminal (login-flows.ts: `remoteLogin: \"unsupported\"`)."),
    structuredSignIn: notYetBuilt("AGEND-113", "`agy acp --login` (agy 1.5.0 and later) can be driven by the structured sign-in; AGEND-113 adds it on this registry."),
    firstRunSignIn: yes({ mode: "console", rank: 3 }),
    authCheck: yes({ argv: ["agy", "models"] }),
    identity: notYetBuilt("AGEND-113", "Showing which account is signed in is part of AGEND-113's Accounts work."),
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
    signIn: notYetBuilt("AGEND-113", "Antigravity signs in as the computer's own login, with no profile; AGEND-113 adds it on this registry."),
    namedAccounts: toVerify("Whether `agy` on Windows can keep more than one login side by side has not been checked."),
    accountRows: notYetBuilt("AGEND-113", "AGEND-113 adds a row per computer for Antigravity's own login."),
    authStatus: notYetBuilt("AGEND-113", "The Windows adapter has no sign-in probe for Antigravity (`authProbe` is null); AGEND-113 asks `agy models` by its exit code."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
