/**
 * Per-backend remote login flows for `/login`.
 *
 * Every command, menu label, prompt, and success string here was verified
 * against the installed CLI (`--help` output or strings extracted from the
 * release binary) rather than written from memory:
 *   - codex:  `codex login --device-auth`, success "Successfully logged in"
 *   - grok:   `grok login --device-auth`, success "Login successful!"
 *   - kiro:   `kiro-cli login --use-device-flow`; free/pro selector is the
 *             arrow-key menu "Select login method" with exactly the four
 *             options below; Identity Center then asks "Enter Start URL" /
 *             "Enter Region"; success "Logged in successfully"/"Logged in with"
 *   - claude: `claude auth login`, paste-back prompt "Paste code here if
 *             prompted", success "Login successful"/"Logged in as"
 *   - agy:    no login subcommand — starting the TUI shows the device URL and
 *             code, and the main screen (ready markers) means auth completed.
 *
 * The login session runs in a dedicated tmux window, never in an instance
 * pane, so instance delivery, pane-state detection, and progress monitors are
 * untouched by design.
 */

export interface AuthCheck {
  /** argv of a cheap, LLM-token-free status probe (5s timeout). */
  argv: string[];
  /**
   * Exit 0 alone is not proof for every CLI: `claude auth status` exits 0
   * either way and reports {"loggedIn": true|false} — verified live.
   */
  validPattern?: RegExp;
}

export interface LoginFlow {
  /** AgEnD backend id this flow signs in. */
  backend: string;
  /** Shell command started inside the dedicated login window. */
  command: string;
  /** Pre-check run before starting a session; valid auth asks for confirmation. */
  authCheck?: AuthCheck;
  /**
   * The CLI's own logged-out startup screen (binary-verified strings). Matched
   * only during the spawn/startup dialog phase — a CLI sitting here is an auth
   * incident, not a crash and not an MCP failure.
   */
  loginScreenPattern?: RegExp;
  /** Arrow-key selector shown by the CLI (kiro). Option N = Down×N then Enter. */
  menu?: {
    promptPattern: RegExp;
    /** Labels in on-screen order — the order defines the Down-key count. */
    options: string[];
  };
  /** Pane prompt that requires admin-supplied text (`/login code <text>`). */
  inputPrompt?: RegExp;
  /** Overrides the generic first-URL capture when the CLI prints several URLs. */
  urlPattern?: RegExp;
  /** One-time user code displayed next to the URL, when the CLI prints one. */
  codePattern?: RegExp;
  /** Pane content that proves the CLI finished signing in. */
  successPattern: RegExp;
  /** Hard cap for the whole login session. */
  timeoutMs: number;
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Generic https matcher. Login panes are captured with wrapped lines joined
 * (`capture-pane -J`), so a long OAuth URL arrives as one logical line.
 */
const GENERIC_URL = /https:\/\/[^\s"'<>\])]+/;

/**
 * A device code standing on its own line (live-verified codex 0.149 output:
 * "Enter this one-time code (expires in 15 minutes)\n   677A-4BGJ6").
 */
const STANDALONE_DEVICE_CODE = /^\s*([A-Z0-9]{4,10}-[A-Z0-9]{4,10})\s*$/m;

export const LOGIN_FLOWS: Record<string, LoginFlow> = {
  "codex": {
    backend: "codex",
    command: "codex login --device-auth",
    authCheck: { argv: ["codex", "login", "status"] },
    loginScreenPattern: /Sign in with ChatGPT/,
    codePattern: STANDALONE_DEVICE_CODE,
    successPattern: /Successfully logged in/,
    timeoutMs: LOGIN_TIMEOUT_MS,
  },
  "grok": {
    backend: "grok",
    command: "grok login --device-auth",
    authCheck: { argv: ["grok", "models"] },
    loginScreenPattern: /Run `grok login`/,
    // Binary template is "enter code: $CODE"; the standalone form is a fallback.
    codePattern: /\bcode[:\s]+([A-Z0-9][A-Z0-9-]{3,})|^\s*([A-Z0-9]{4,10}-[A-Z0-9]{4,10})\s*$/im,
    successPattern: /Login successful!/,
    timeoutMs: LOGIN_TIMEOUT_MS,
  },
  "kiro-cli": {
    backend: "kiro-cli",
    command: "kiro-cli login --use-device-flow",
    authCheck: { argv: ["kiro-cli", "whoami", "--format", "json"] },
    loginScreenPattern: /Select login method/,
    menu: {
      promptPattern: /Select login method/,
      // Binary-verified on-screen order; "Your Organization" = Identity Center
      // and is followed by the Start URL / Region text prompts below.
      options: ["Builder ID", "Google", "GitHub", "Your Organization"],
    },
    inputPrompt: /Enter Start URL|Enter Region/,
    codePattern: /Code:\s*([A-Z0-9][A-Z0-9-]{3,})/,
    successPattern: /Logged in successfully|Logged in with /,
    timeoutMs: LOGIN_TIMEOUT_MS,
  },
  "claude-code": {
    backend: "claude-code",
    command: "claude auth login",
    authCheck: { argv: ["claude", "auth", "status"], validPattern: /"loggedIn":\s*true/ },
    loginScreenPattern: /Select login method:|Sign in (?:to|with) your Anthropic account/,
    inputPrompt: /Paste code here if prompted/,
    successPattern: /Login successful|Logged in as/,
    timeoutMs: LOGIN_TIMEOUT_MS,
  },
  "antigravity": {
    backend: "antigravity",
    command: "agy",
    authCheck: { argv: ["agy", "models"] },
    loginScreenPattern: /not logged into Antigravity|https:\/\/\S*google\.com\/device/i,
    codePattern: STANDALONE_DEVICE_CODE,
    // agy has no terminal success line — reaching the normal TUI ready screen
    // (same markers as the backend's ready pattern) means auth completed.
    successPattern: /\? for shortcuts|^>\s*$/m,
    timeoutMs: LOGIN_TIMEOUT_MS,
  },
};

/** Chat-command aliases accepted by `/login <backend>`. */
export const LOGIN_BACKEND_ALIASES: Record<string, string> = {
  "claude": "claude-code",
  "claude-code": "claude-code",
  "codex": "codex",
  "grok": "grok",
  "kiro": "kiro-cli",
  "kiro-cli": "kiro-cli",
  "agy": "antigravity",
  "antigravity": "antigravity",
};

/**
 * Extract the authorization URL and one-time code from joined pane text.
 * Returns nulls until the CLI has printed them.
 */
export function extractLoginHint(
  pane: string,
  flow: Pick<LoginFlow, "urlPattern" | "codePattern">,
): { url: string | null; code: string | null } {
  const urlMatch = pane.match(flow.urlPattern ?? GENERIC_URL);
  // A trailing period/comma is prose punctuation, not part of the URL.
  const url = urlMatch ? urlMatch[0].replace(/[.,]+$/, "") : null;
  const codeMatch = flow.codePattern ? pane.match(flow.codePattern) : null;
  // Alternation patterns carry several capture groups — take the one that hit.
  const code = codeMatch ? codeMatch.slice(1).find(group => group !== undefined) ?? null : null;
  return { url, code };
}

export type AuthCheckResult = "valid" | "invalid" | "unknown";

export type AuthCheckRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; output: string }>;

const AUTH_CHECK_TIMEOUT_MS = 5_000;

let authCheckRunnerOverride: AuthCheckRunner | null = null;
/** Test seam — replaces the real process runner (pass null to restore). */
export function setAuthCheckRunnerForTests(run: AuthCheckRunner | null): void {
  authCheckRunnerOverride = run;
}

async function runAuthCheckProcess(argv: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const anyErr = err as (Error & { code?: number | string; killed?: boolean }) | null;
      // A timeout kill or a spawn failure (CLI missing) has no meaningful exit
      // code — that is "unknown", not "logged out".
      if (anyErr && (anyErr.killed || typeof anyErr.code !== "number")) {
        resolve({ code: null, output: `${stdout ?? ""}${stderr ?? ""}` });
        return;
      }
      resolve({ code: anyErr ? (anyErr.code as number) : 0, output: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Probe whether a backend's credentials still work, without spending LLM
 * tokens. "valid" gates the /login confirmation prompt; "invalid" and
 * "unknown" (timeout, missing binary) both proceed straight to login — an
 * uncertain check must never block a re-login the admin asked for.
 */
export async function checkAuthStatus(check: AuthCheck): Promise<AuthCheckResult> {
  const run = authCheckRunnerOverride ?? runAuthCheckProcess;
  try {
    const { code, output } = await run(check.argv, AUTH_CHECK_TIMEOUT_MS);
    if (code === null) return "unknown";
    if (code !== 0) return "invalid";
    if (check.validPattern && !check.validPattern.test(output)) return "invalid";
    return "valid";
  } catch {
    return "unknown";
  }
}
