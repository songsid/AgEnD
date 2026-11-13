/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, yes, notYetBuilt, type CliSpec } from "./cli-capability.js";

/** The launch-argument facts of an Antigravity account, host and Runtime alike (cli-registry-check.ts holds them to be the same): one table, so they cannot drift. */
const NAMED = { arg: "--app_data_dir", store: "antigravity-oauth-token", pin: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" } } as const;

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    // AGEND-153 (#3521, the maintainer's decision on #3539): the NAMED EXCEPTION. Antigravity updates itself and `agy update` cannot choose a release, so the button runs it as it is and the
    // CLI goes to the newest release Google serves, which AgEnD has NOT audited (`release: "latest-unaudited"`; the page says so on the button). Same gate as any update otherwise.
    update: yes({ binary: "agy", command: "agy update", release: "latest-unaudited" }),
    chatLogin: yes({ aliases: ["agy"], mode: "declined" }),
    dashboardSignIn: byDesign("Bare `agy` is the whole agent CLI, not a login command, so it never gets the browser terminal (login-flows.ts: `remoteLogin: \"unsupported\"`)."),
    // `agy acp --login` ("Log in with Google interactively, then exit", agy 1.5.0 and later). It prints no success line that has been seen, so the sign-in is over only when the command ended
    // with exit 0 AND `authCheck` passes; its screen has a closed table of its own (runtime-signin.ts `reduceAgyLoginScreen`). A Google-account (subscription) sign-in only.
    structuredSignIn: yes({ argv: ["agy", "acp", "--login"], rank: 3, ends: "exit-code", screen: "own", answer: "code-or-address", minVersion: "1.5.0", named: true }),
    // The first-run page still only names the console command for it (a browser sign-in needs a version check and the person's own confirmation, which the Accounts page has).
    firstRunSignIn: yes({ mode: "console", rank: 3 }),
    authCheck: yes({ argv: ["agy", "models"] }),
    // The `id_token_email` of agy's own token file (the whole address) (`~/.gemini/antigravity-cli/antigravity-oauth-token`), read locally: that one field only, no process, no network request.
    identity: yes({ source: "token-file", field: "id_token_email" }),
    // AGEND-119: several accounts on this host. agy takes the account's folder as `--app_data_dir <path relative to ~/.gemini>` (a `..` path reaches AgEnD's own credential-profiles folder), and keeps the
    // sign-in in `<folder>/antigravity-oauth-token`. Its keyring is shared by every folder (the folder is ignored there), so each launch also carries `pin`: `SSH_CONNECTION` makes agy 1.5.3 log
    // "Using file-based token storage because SSH session detected" and keep the sign-in in the file (checked on Linux and on Windows; a sign-in first proves it, see structured-signin.ts). A Move starts
    // a new conversation: agy keeps them in the same folder as the sign-in.
    // Side effect to know: there is no agy-only switch for this (agy 1.5.3's strings on Linux and Windows hold no AGY_*/flag for the token store: AGY_ACCOUNT, AGY_ADC_AUTH, AGY_BROWSER_WS_URL, AGY_CLI_*, AGY_LLM_GATEWAY_*,
    // AGY_PROXY_STRICT_SSL … none of them), so `pin` is a variable that means "an SSH session" to every program the agent starts: an agent on a named account sees SSH_CONNECTION in its shell, tools and MCP servers.
    namedAccounts: yes({ home: "launch-argument", ...NAMED, carry: "handover" }),
    // agy has no logout command (the TUI's `/logout` is interactive only): AgEnD removes the account's token file and then asks `agy models`, so a sign-out that did not take effect (a sign-in kept in the system
    // keyring) is reported as that. The default sign-in is `~/.gemini/antigravity-cli/antigravity-oauth-token`; a named account's is the same file in its own folder.
    signOut: yes({ remove: ["antigravity-oauth-token"] }),
    // `agy models` refreshes the access token (an hour) when it is past it, and the refresh token behind it outlives idle days (measured on Windows: 66 starts after the access token had lapsed, up to 4 days 20 hours
    // past it, none refused), so a scheduled run keeps the usage row current and tells a login that was revoked.
    keepAlive: yes(),
    accountCard: yes({ rank: 3 }),
    // Pools the CLI names (Gemini; Claude & others; Gemini 4 Argon), each with its own 5h and weekly limit, or one number when only per-model data exists: an Accounts row shows every pool and every window.
    usage: yes({ providerId: "antigravity", name: "Antigravity", rank: 5, profileRows: true, hostRows: true, pools: "several", windows: ["session", "weekly", "unwindowed"] }),
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
    // `both` (AGEND-124): the computer's OWN login (Windows keeps it in the Credential Manager under one fixed name, `gemini:antigravity`, so signing in REPLACES that Windows user's Antigravity login) AND named
    // accounts (below). The two have separate rules in runtime-remote-accounts.ts: the own login has no profile and no owner, and the named account is a folder this Runtime created.
    signIn: yes({ argv: ["agy", "acp", "--login"], profile: "both" }),
    // AGEND-119 re-check of AGEND-112 (whose "one login per Windows user" was only true of agy.exe's default store): agy.exe keeps its login in the Credential Manager (`gemini:antigravity`, one for every folder) unless it detects
    // WSL (a \\wsl.localhost working directory) or an SSH session (SSH_CONNECTION / SSH_TTY / SSH_CLIENT set), when it keeps `<--app_data_dir>/antigravity-oauth-token` instead ("Using file-based token storage because SSH
    // session detected" in its log). Measured on agy.exe 1.5.3 with a planted token in a test folder: the folder's login is read, deleting the file signs it out, the Credential Manager login is untouched, and a `..`
    // relative --app_data_dir into the Runtime's own folder works (not across drives, where there is no relative path: such an account is refused, never started). AGEND-124 builds the Runtime side: the account's folder is
    // `credential-profiles\\antigravity\\<name>`, every launch (sign-in, status, an agent's) carries `--app_data_dir` and `pin`, and a sign-in first asks an EMPTY scratch folder (it must answer "signed out", else `not_isolated`).
    // The same side effect as on the host: `pin` is `SSH_CONNECTION`, so an agent on a named account sees it in its shell, tools and MCP servers.
    namedAccounts: yes({ ...NAMED }),
    // agy has no logout command (the TUI's `/logout` is interactive only; it deletes the same entry `cmdkey /delete:gemini:antigravity` does, measured on a decoy entry). A named account's sign-out is removing its token file;
    // the computer's own login is its Credential Manager entry. Either is then checked with `agy models`.
    signOut: yes({ remove: [NAMED.store], credential: "gemini:antigravity" }),
    accountRows: yes({ defaultRow: "sign-in" }),
    // agy has no status command: the model listing the Runtime asks for anyway says whether it is signed in (exit code and words), so no extra process is started.
    authStatus: yes({ argv: ["models"], source: "model-listing" }),
    // AGEND-124: a NAMED account's only. Its login is the file `<folder>/antigravity-oauth-token` (the pin), so the Runtime reads that one file's `id_token_email` (host.identity's field) in the account's verified folder and
    // reports it (the whole address, as for any other account), never anything else of the file. The computer's OWN login is in the Credential Manager entry `gemini:antigravity`, which holds the login's tokens: the Runtime does not read credentials there, so it names nobody.
    identity: yes(),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet; and the usage read needs the account's token, which on Windows is in the Credential Manager."),
  },
} satisfies CliSpec;
