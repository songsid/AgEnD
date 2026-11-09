/** Kiro (AWS). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const KIRO_CLI_SPEC = {
  id: "kiro-cli",
  host: {
    install: yes({ binary: "kiro-cli", command: "curl -fsSL https://cli.kiro.dev/install | bash" }),
    chatLogin: yes({ aliases: ["kiro"], mode: "menu" }),
    dashboardSignIn: yes({ named: false }),
    structuredSignIn: yes({ argv: ["kiro-cli", "login"], rank: 0 }),
    firstRunSignIn: yes({ mode: "browser", rank: 0 }),
    authCheck: yes({ argv: ["kiro-cli", "whoami", "--format", "json"] }),
    identity: toVerify("`kiro-cli whoami --format json` is already run as the sign-in probe; whether its JSON names the account in a form that can be masked has not been checked."),
    namedAccounts: yes({ env: "XDG_DATA_HOME", home: "relocate-home", carry: "handover" }),
    signOut: yes({ binary: "kiro-cli", args: ["logout"] }),
    keepAlive: toVerify("Whether Kiro's token needs a keep-alive run (Claude Code and Codex have one) has not been checked."),
    accountCard: yes({ rank: 2 }),
    usage: yes({ providerId: "kiro", name: "Kiro", rank: 4, profileRows: true }),
  },
  runtime: {
    provider: yes({
      name: "Kiro", company: "AWS", binaryNames: ["kiro-cli.exe"],
      supports: { execution: false, resume: false, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Native Windows Kiro CLI is separate from Kiro IDE. Headless authentication requires KIRO_API_KEY.",
      promptTransport: "stdin-text", modelProbe: ["chat", "--list-models", "--format", "json"],
      reason: "Windows headless execution exists, but this adapter has not verified its terminal JSON event schema yet.", rank: 4,
    }),
    install: byDesign("Kiro installs from an MSI into Program Files, which the Runtime does not run (runtime-cli-install.ts); the dashboard shows the official command for the computer's owner."),
    signIn: notYetBuilt("undecided", "Only Claude Code is signed in from the dashboard on a computer."),
    namedAccounts: notYetBuilt("undecided", "The Runtime's profile folders are Claude Code's only."),
    accountRows: notYetBuilt("undecided", "Accounts shows a computer's Claude Code accounts only."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no verified sign-in probe for Kiro (`authProbe` is null); its state is unknown, not signed out."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
