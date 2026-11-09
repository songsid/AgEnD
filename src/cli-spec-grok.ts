/** Grok (xAI). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const GROK_SPEC = {
  id: "grok",
  host: {
    install: yes({ binary: "grok", command: "curl -fsSL https://x.ai/cli/install.sh | bash" }),
    update: yes({ binary: "grok", command: "curl -fsSL https://x.ai/cli/install.sh | bash -s {version}" }),
    chatLogin: yes({ aliases: [], mode: "device-code" }),
    dashboardSignIn: yes({ named: false }),
    structuredSignIn: notYetBuilt("undecided", "Grok signs in through the device-code page of the older dashboard flow; it has not been moved to the structured sign-in."),
    firstRunSignIn: notYetBuilt("undecided", "The first-run page offers Kiro, Claude Code, Codex and (as a console command) Antigravity; Grok is not on it."),
    authCheck: yes({ argv: ["grok", "models"] }),
    identity: toVerify("Whether `grok models` (the sign-in probe) or another read-only command names the account has not been checked."),
    namedAccounts: toVerify("Whether `grok` keeps its login where an environment variable can relocate it has not been checked."),
    signOut: toVerify("No `grok` logout command has been checked."),
    keepAlive: toVerify("Whether Grok's sign-in needs a keep-alive run has not been checked."),
    accountCard: yes({ rank: 4 }),
    usage: yes({ providerId: "grok", name: "Grok", rank: 3, profileRows: false }),
  },
  runtime: {
    provider: yes({
      name: "Grok", company: "xAI", binaryNames: ["grok.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy; no blanket approval or sandbox bypass is added.",
      promptTransport: "file", modelProbe: ["models"], rank: 3,
    }),
    install: byDesign("Grok installs with a vendor script, not an npm package (runtime-cli-install.ts); the dashboard shows the official command for the computer's owner."),
    update: byDesign("Grok is not in the Runtime's pinned installer table, so there is no audited, verifiable release for the Runtime to install; its owner can run `grok update --version <audited release>` on that computer."),
    signIn: notYetBuilt("undecided", "Only Claude Code is signed in from the dashboard on a computer."),
    namedAccounts: toVerify("Whether `grok` on Windows can keep more than one login side by side has not been checked."),
    accountRows: notYetBuilt("undecided", "Accounts shows a computer's Claude Code accounts only."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for Grok (`authProbe` is null); its state is unknown, not signed out."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
