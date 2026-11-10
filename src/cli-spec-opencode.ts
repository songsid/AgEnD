/** OpenCode (Anomaly). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { none, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const OPENCODE_SPEC = {
  id: "opencode",
  host: {
    install: yes({ binary: "opencode", command: "curl -fsSL https://opencode.ai/install | bash" }),
    update: yes({ binary: "opencode", command: "curl -fsSL https://opencode.ai/install | bash -s -- --version {version}" }),
    // `/login opencode` installs it; there is no sign-in flow behind it (login-flows.ts).
    chatLogin: yes({ aliases: [], mode: "install-only" }),
    dashboardSignIn: notApplicable("There is no sign-in flow to run from the dashboard."),
    structuredSignIn: notApplicable("There is no sign-in flow to drive."),
    firstRunSignIn: notApplicable("There is no sign-in flow to offer."),
    // Its probe (`opencode auth list`) lives in BACKEND_AUTH_CHECKS, not in a login flow.
    authCheck: yes({ argv: ["opencode", "auth", "list"] }),
    identity: toVerify("`opencode auth list` names providers, not an account; whether anything can be masked has not been checked."),
    namedAccounts: toVerify("Whether `opencode` keeps its credentials where an environment variable can relocate them has not been checked."),
    signOut: toVerify("No `opencode` logout command has been checked."),
    keepAlive: toVerify("Whether OpenCode's credentials need a keep-alive run has not been checked."),
    accountCard: none("OpenCode uses whatever provider keys the person configured; Settings → Accounts has no card for it."),
    usage: none("OpenCode consumes no subscription of its own, so the usage panel has no provider row for it."),
  },
  runtime: {
    provider: yes({
      name: "OpenCode", company: "Anomaly", binaryNames: ["opencode.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy; no --auto or permission allow override is added.",
      promptTransport: "stdin-text", modelProbe: ["models"], rank: 5,
    }),
    // AGEND-133 (#3521): pinned npm package (opencode-ai + its Windows x64 packages) with the registry's sha512 of each, `npm audit signatures` and the Authenticode signer of the binary.
    install: yes({ kind: "npm", pin: "audited" }),
    // AGEND-153 (#3539, the maintainer's follow-up): the Update button, wired. It is this same pinned install over an older copy (exact version, the registry's sha512 of every package, `npm audit signatures`,
    // the Authenticode signer), and the pin is the newest AUDITED release (cli-audited.ts; tests/cli-audited-136.test.ts fails if it is not), so an update never goes to "latest".
    update: yes({ kind: "pinned" }),
    signIn: notApplicable("AgEnD has no sign-in flow for OpenCode."),
    namedAccounts: toVerify("Whether `opencode` on Windows can keep more than one set of credentials side by side has not been checked."),
    accountRows: none("OpenCode has no card on Settings → Accounts."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for OpenCode (`authProbe` is null); its state is unknown, not signed out."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: none("OpenCode consumes no subscription of its own."),
  },
} satisfies CliSpec;
