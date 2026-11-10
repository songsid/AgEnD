/** Codex (OpenAI). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const CODEX_SPEC = {
  id: "codex",
  host: {
    install: yes({
      binary: "codex", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      unattended: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
    }),
    chatLogin: yes({ aliases: [], mode: "device-code" }),
    dashboardSignIn: yes({ named: true }),
    structuredSignIn: yes({ argv: ["codex", "login", "--device-auth"], rank: 2, named: false }),
    firstRunSignIn: yes({ mode: "browser", rank: 2 }),
    authCheck: yes({ argv: ["codex", "login", "status"] }),
    identity: toVerify("Only the sign-in state is read from `codex login status`; whether its output names the account (and could be masked like Claude Code's) has not been checked. Reading the credential file for it is not an option."),
    namedAccounts: yes({ env: "CODEX_HOME", home: "redirect-files", carry: "keeps" }),
    signOut: yes({ binary: "codex", args: ["logout"] }),
    keepAlive: yes(),
    accountCard: yes({ rank: 1 }),
    usage: yes({ providerId: "codex", name: "Codex", rank: 1, profileRows: true }),
  },
  runtime: {
    provider: yes({
      name: "Codex", company: "OpenAI", binaryNames: ["codex.exe"],
      supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true,
      permission: "os-sandbox", permissionNote: "Uses Codex's native read-only or workspace-write sandbox. Approval policy is unchanged.",
      promptTransport: "stdin-text", modelProbe: null, rank: 0,
    }),
    install: yes({ kind: "npm", pin: "audited" }),
    signIn: notYetBuilt("#3212", "Named accounts on a computer wait for the Codex part of #3212 (its PR 4); only Claude Code is signed in from the dashboard there."),
    namedAccounts: notYetBuilt("#3212", "The Runtime's profile folders are Claude Code's only (CLAUDE_CONFIG_DIR); Codex waits for #3212 PR 4."),
    accountRows: notYetBuilt("#3212", "Accounts shows a computer's Claude Code accounts only; Codex waits for #3212 PR 4."),
    authStatus: yes({ argv: ["login", "status"] }),
    identity: toVerify("The Runtime reports an identity for Claude Code only; whether `codex login status` has an account to mask has not been checked."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
