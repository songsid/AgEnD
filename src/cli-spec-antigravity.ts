/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, notApplicable, notYetBuilt, toVerify, yes, type CliSpec } from "./cli-capability.js";

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    // AGEND-153 (#3521, the maintainer's decision on #3539): the NAMED EXCEPTION. Antigravity updates itself and `agy update` cannot choose a release, so the button runs it as it is and the
    // CLI goes to the newest release Google serves, which AgEnD has NOT audited (`release: "latest-unaudited"`; the page says so on the button). Same gate as any update otherwise.
    update: yes({ binary: "agy", command: "agy update", release: "latest-unaudited" }),
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
    // AGEND-135 (#3521), measured 2026-11-09: there is no npm package (`agy` / `antigravity-cli` on npm are not Google's), but the vendor script downloads a versioned, immutable file named by a
    // manifest (https://storage.googleapis.com/antigravity-public/antigravity-cli/<version>/windows-x64/cli_windows_x64.exe, manifest `sha512`), and that file IS Authenticode-signed
    // (Google LLC, status Valid; its sha512 matches the manifest). The Runtime pins the exact URL, size and sha512, downloads that one file itself (the vendor script is not run), checks all
    // of them, then the signer, and refuses on any mismatch (runtime-cli-install.ts, `kind: "download"`). Windows x64 only.
    // AGEND-148: 1.5.3 is on the maintainer-confirmed audited ledger (cli-audited.ts), so this download is pinned to an AUDITED release, not for its integrity only.
    install: yes({ kind: "download", pin: "audited" }),
    // AGEND-153: the named exception on a computer. NOT the pinned install: the Runtime downloads the newest release Google's own manifest names (from a fixed address, only from the vendor's
    // fixed file prefix), checks its sha512 against that manifest and the Authenticode signer (Google LLC), and only then switches to it (runtime-cli-install.ts, `LATEST_UNAUDITED`). The vendor's
    // own updater is never run there. The release is not one AgEnD has audited, and the page says so.
    update: yes({ kind: "latest-unaudited" }),
    signIn: notYetBuilt("undecided", "Antigravity signs in as the computer's own login, with no profile; not built on this registry yet."),
    namedAccounts: toVerify("Whether `agy` on Windows can keep more than one login side by side has not been checked."),
    accountRows: notYetBuilt("undecided", "No row per computer for Antigravity's own login yet."),
    authStatus: notYetBuilt("undecided", "The Windows adapter has no sign-in probe for Antigravity (`authProbe` is null); asking `agy models` by its exit code is not built yet."),
    identity: notApplicable("Needs a sign-in probe on the computer first."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet."),
  },
} satisfies CliSpec;
