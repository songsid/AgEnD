/** Muse (Meta). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, none, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const MUSE_SPEC = {
  id: "muse",
  host: {
    install: yes({
      binary: "muse",
      command: 'mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"',
    }),
    update: none("Muse's launcher checks for a new release itself every hour and has no update command, so the dashboard only shows the installed and the audited versions."),
    chatLogin: none("AgEnD has no sign-in flow for Muse, and `/login muse` is not a name chat recognises."),
    dashboardSignIn: notApplicable("There is no sign-in flow to run from the dashboard."),
    structuredSignIn: notApplicable("There is no sign-in flow to drive."),
    firstRunSignIn: notApplicable("There is no sign-in flow to offer."),
    authCheck: toVerify("No token-free sign-in probe for Muse has been checked."),
    identity: toVerify("Without a sign-in probe nothing has been read to find an account."),
    namedAccounts: toVerify("Whether `muse` keeps its login where an environment variable can relocate it has not been checked."),
    signOut: toVerify("No `muse` logout command has been checked."),
    keepAlive: toVerify("Whether Muse's sign-in needs a keep-alive run has not been checked."),
    accountCard: yes({ rank: 5 }),
    usage: yes({ providerId: "muse", name: "Muse", rank: 2, profileRows: false, hostRows: false, pools: "single", windows: ["session", "weekly"] }),
  },
  runtime: {
    provider: yes({
      name: "Muse", company: "Meta", binaryNames: ["muse.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI approval and sandbox policy; no --disable-approval, --yolo or workspace-switch override is added.",
      promptTransport: "file", modelProbe: null, rank: 6,
    }),
    install: byDesign("Muse has no package or file with a fixed version AgEnD could check: its launcher (`muse-launcher.ps1`, not versioned) installs itself, and updates itself, from the vendor's server, so there is nothing to pin. The page shows the official command and says why."),
    update: none("Muse's launcher updates itself in the background and has no update command."),
    signIn: notApplicable("AgEnD has no sign-in flow for Muse."),
    namedAccounts: toVerify("Whether `muse` on Windows can keep more than one login side by side has not been checked."),
    signOut: notApplicable("AgEnD has no sign-in flow for Muse, so nothing to sign out."),
    accountRows: notYetBuilt("undecided", "Accounts shows a computer's Claude Code accounts only."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for Muse (`authProbe` is null); its state is unknown, not signed out."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
