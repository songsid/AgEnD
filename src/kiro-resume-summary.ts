/**
 * kiro-cli-chat injects a synthetic first turn when AgEnD resumes a non-empty
 * conversation. AgEnD never consumes that summary: the model then `reply()`s it
 * onto the channel, so idle ClassicBot rooms keep spending tokens on it.
 *
 * Upstream (kiro-cli-chat `crates/chat-cli/src/cli/chat/mod.rs`, ~1940 on the
 * 2.35 binary; amazon-q-developer-cli ~810): on `--resume` / `--resume-id` with
 * non-empty history,
 *   input = Some(input.unwrap_or("In a few words, summarize our conversation so far.".to_owned()));
 * There is no AgEnD scheduler, heartbeat, or keep-warm job with this text.
 * Target selection is kiro's: any resumed conversation whose history is not
 * empty. Idle classic rooms qualify because `src/backend/kiro.ts` always
 * launches them with `--resume` / `--resume-id` unless `skipResume`, and the
 * previous probes themselves keep history non-empty.
 *
 * The probe is unused on classic/legacy UI. AgEnD's override INPUT is only
 * appended when `kiroUi === "legacy"` (boolean `--resume` and `--resume-id`).
 * TUI and V3 launches are unchanged. kiro's handle_input treats a leading `!`
 * as `bash -c <rest>`; `:` is a POSIX no-op.
 */
export const KIRO_RESUME_SUMMARY_PROMPT = "In a few words, summarize our conversation so far.";

/** Positional INPUT that overrides kiro's resume default without calling the model. */
export const KIRO_RESUME_SUMMARY_OVERRIDE = "!:";

/** Flags on `kiro-cli chat` that consume the next argv word. */
const VALUE_FLAGS = new Set([
  "--resume-id", "--agent", "--model", "--effort", "--trust-tools",
  "--wrap", "-w", "--format", "-f", "--output-format", "--delete-session", "-d",
  "--session-source", "--agent-engine", "--mode",
]);

/**
 * Whether kiro-cli-chat would inject {@link KIRO_RESUME_SUMMARY_PROMPT} for this
 * `chat` argv (the words after the binary, with or without a leading `chat`).
 * A supplied positional INPUT replaces the default, including our override.
 */
export function kiroChatWouldInjectResumeSummary(argv: readonly string[]): boolean {
  const a = argv[0] === "chat" ? argv.slice(1) : argv;
  let resume = false;
  let input: string | undefined;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--resume" || x === "-r") { resume = true; continue; }
    if (x === "--resume-id") { resume = true; i++; continue; }
    if (x.startsWith("--resume-id=")) { resume = true; continue; }
    if (VALUE_FLAGS.has(x)) { i++; continue; }
    if (x.startsWith("-")) continue;
    input = x;
  }
  return resume && input === undefined;
}

/**
 * `chat` argv from an AgEnD kiro launch command (env assignments, then the
 * binary, then `chat` and its flags). AgEnD quotes values with shellQuote
 * (single quotes); that is all this splits.
 */
export function kiroChatArgvFromLaunchCommand(cmd: string): string[] {
  const at = cmd.search(/(?:^|\s)chat(?:\s|$)/);
  if (at < 0) return [];
  const rest = cmd.slice(cmd.indexOf("chat", at) + "chat".length);
  const out: string[] = ["chat"];
  const re = /'([^']*)'|\S+/g;
  for (let m = re.exec(rest); m; m = re.exec(rest)) out.push(m[1] !== undefined ? m[1] : m[0]!);
  return out;
}

/** True when this launch resumed a conversation (boolean `--resume` or `--resume-id`). */
export function kiroLaunchResumesConversation(argv: readonly string[]): boolean {
  const a = argv[0] === "chat" ? argv.slice(1) : argv;
  return a.some(x => x === "--resume" || x === "-r" || x === "--resume-id" || x.startsWith("--resume-id="));
}
