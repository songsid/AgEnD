/** Claude Code (Anthropic). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { notYetBuilt, yes, type CliSpec } from "./cli-capability.js";

export const CLAUDE_CODE_SPEC = {
  id: "claude-code",
  host: {
    install: yes({ binary: "claude", command: "curl -fsSL https://claude.ai/install.sh | bash" }),
    update: yes({ binary: "claude", command: "curl -fsSL https://claude.ai/install.sh | bash -s {version}" }),
    chatLogin: yes({ aliases: ["claude"], mode: "paste-code" }),
    dashboardSignIn: yes({ named: true }),
    structuredSignIn: yes({ argv: ["claude", "auth", "login"], rank: 1, named: true }),
    firstRunSignIn: yes({ mode: "browser", rank: 1 }),
    authCheck: yes({ argv: ["claude", "auth", "status"] }),
    identity: yes({ source: "status-command" }),
    namedAccounts: yes({ env: "CLAUDE_CONFIG_DIR", home: "relocate-home", carry: "carries" }),
    signOut: yes({ binary: "claude", args: ["auth", "logout"] }),
    keepAlive: yes(),
    accountCard: yes({ rank: 0 }),
    usage: yes({ providerId: "claude", name: "Claude", rank: 0, profileRows: true }),
  },
  runtime: {
    provider: yes({
      name: "Claude Code", company: "Anthropic", binaryNames: ["claude.exe"],
      supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true,
      permission: "read-tools", permissionNote: "Read-only exposes Read, Glob and Grep only, with MCP disabled; it is a tool restriction, not an OS sandbox. Workspace accepts file edits inside the working directory only. Every other permission request (shell, network, other folders) is denied in headless mode unless Claude Code's own settings already allow it.",
      promptTransport: "stdin-text", modelProbe: null, rank: 1,
    }),
    install: yes({ kind: "npm" }),
    update: yes({ kind: "pinned" }),
    signIn: yes({ argv: ["claude", "auth", "login"], profile: "named" }),
    namedAccounts: yes({ env: "CLAUDE_CONFIG_DIR" }),
    accountRows: yes(),
    authStatus: yes({ argv: ["auth", "status"] }),
    identity: yes(),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet; its accounts rows carry a sign-in state and an identity only."),
  },
} satisfies CliSpec;
