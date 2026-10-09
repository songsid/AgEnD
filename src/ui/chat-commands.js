// #1269 (4): the composer's slash commands — the instance's own chat commands, the ones its Discord/Telegram topic
// accepts (the server runs them through the same handlers and command table: POST /ui/command). Pure: what the
// palette offers for a draft, and whether a draft is a command to run. Anything else starting with "/" is an
// ordinary message, as before.

/** The commands, in the palette's order. `arg`: the argument hint ("" = none; [..] optional, <..> required). */
export const CHAT_COMMANDS = [
  { name: "ctx", arg: "" },
  { name: "compact", arg: "[instructions]" },
  { name: "clear", arg: "" },
  { name: "model", arg: "[name]" },
  { name: "effort", arg: "[level]" },
  { name: "cancel", arg: "" },
  { name: "btw", arg: "<question>" },
  { name: "steer", arg: "<text>" },
  { name: "pause", arg: "" },
  { name: "wake", arg: "" },
  { name: "save", arg: "<file>" },
];
const BY_NAME = new Map(CHAT_COMMANDS.map((c) => [c.name, c]));

/**
 * The palette for a draft: null when it is not one (no leading "/", or past the command's name), else the commands
 * whose name starts with what was typed (possibly none: then it goes as a message).
 */
export function paletteFor(draft) {
  const m = /^\/([a-z]*)$/.exec(draft || "");
  if (!m) return null;
  return CHAT_COMMANDS.filter((c) => c.name.startsWith(m[1]));
}

/** `/name args` for a known command → { command, args }; anything else (unknown, not a command) → null. */
export function parseCommandLine(draft) {
  const m = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/.exec((draft || "").trim());
  if (!m || !BY_NAME.has(m[1])) return null;
  return { command: m[1], args: (m[2] || "").trim() };
}

/** Commands that act without an argument but need one to be useful: Enter on `/btw` alone completes, it does not run. */
export function needsArgument(command) {
  const c = BY_NAME.get(command);
  return !!c && c.arg.startsWith("<");
}
