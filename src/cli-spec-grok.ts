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
    usage: yes({ providerId: "grok", name: "Grok", rank: 3, profileRows: false, hostRows: false, pools: "single", windows: ["weekly"] }),
  },
  runtime: {
    provider: yes({
      name: "Grok", company: "xAI", binaryNames: ["grok.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy; no blanket approval or sandbox bypass is added.",
      promptTransport: "file", modelProbe: ["models"], rank: 3,
    }),
    // AGEND-133 (#3521), measured 2026-11-09: `@xai-official/grok` (published by xai-security) is on npm, but its Windows binary (grok.exe, shipped brotli-compressed) is NOT Authenticode-signed
    // (Get-AuthenticodeSignature: NotSigned), and the package relies on its own postinstall to unpack into ~/.grok. A `--ignore-scripts` install would have a registry hash and nothing that
    // says who built the program; Part 3b's publisher check cannot be made. The vendor script (x.ai/cli/install.ps1) fetches whatever is current, so it cannot be pinned either.
    install: byDesign("Grok's Windows program is not signed by its publisher, so AgEnD could not check who built it before running it; the vendor script installs whatever version is current. The dashboard shows the official command for the computer's owner."),
    update: byDesign("Grok is not in the Runtime's pinned installer table, so there is no audited, verifiable release for the Runtime to install; its owner can run `grok update --version <audited release>` on that computer."),
    signIn: notYetBuilt("undecided", "Only Claude Code is signed in from the dashboard on a computer."),
    namedAccounts: toVerify("Whether `grok` on Windows can keep more than one login side by side has not been checked."),
    signOut: toVerify("Whether `grok` on Windows can keep its login anywhere but the Credential Manager has not been checked; nothing is signed out from the dashboard there."),
    accountRows: notYetBuilt("undecided", "Accounts shows a computer's Claude Code accounts only."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for Grok (`authProbe` is null); its state is unknown, not signed out."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
