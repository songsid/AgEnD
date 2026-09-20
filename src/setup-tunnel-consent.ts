/**
 * The question asked before a setup page is put on the public internet.
 *
 * It is asked every single time. There is no configuration that turns it off
 * and no flag that answers it in advance: `allow_public` defaults to true
 * because opening from a phone is the product, not because the consequences
 * stop mattering after the first time. And a pre-fleet host has no chat channel
 * to put a confirmation button in, so the only place this can be asked is the
 * terminal that ran the command.
 *
 * Which means a run with no terminal cannot be consented to, and is refused.
 * Not "defaults to allow because nobody is there to object" — nobody being
 * there is the reason to refuse.
 *
 * The wording is deliberately not sol's Web Terminal text. That one covers a
 * terminal session that ends; this one carries a long-lived bot token and an
 * admin id through somebody else's edge, which is a different thing to consent
 * to and has to say so.
 */

export interface ConsentIo {
  readonly isTTY: boolean;
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export type ConsentResult =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: "declined" | "no-tty" };

/**
 * Everything a person needs to decide, in the order they need it.
 *
 * Each line is here because leaving it out would make the answer uninformed:
 * the token really does cross Cloudflare, the page really can be closed by a
 * stranger, and the link really does work for anyone who sees it.
 */
export function publicTunnelWarning(ttlMinutes: number): string[] {
  return [
    "",
    "  This opens a Cloudflare quick tunnel: the setup page becomes reachable",
    `  from the public internet for up to ${ttlMinutes} minutes.`,
    "",
    "  • The bot token you type into the page travels through Cloudflare.",
    "    TLS ends at their edge, so Cloudflare can see it, along with the admin",
    "    user id you set. If that is not acceptable, set up from this machine",
    "    instead and skip --tunnel.",
    "  • The link is not a password — the setup code is — but anyone who sees",
    "    the link can get it wrong five times and close your setup page. You",
    "    would then have to come back to this machine and run `agend setup`",
    "    again. Do not paste it into a group chat.",
    "  • The link stops working when you finish, when the time runs out, or if",
    "    the tunnel drops.",
    "",
  ];
}

const AFFIRMATIVE = /^(y|yes)$/i;

/**
 * Ask, and treat anything that is not a clear yes as a no.
 *
 * Including the empty answer: a person who presses enter to get past a prompt
 * has not read it, and this is not a prompt to get past.
 */
export async function confirmPublicTunnel(io: ConsentIo, ttlMinutes: number): Promise<ConsentResult> {
  for (const line of publicTunnelWarning(ttlMinutes)) io.say(line);
  if (!io.isTTY) {
    io.say("  Refusing to open a public tunnel without a terminal to confirm it.");
    io.say("  Run this from an interactive shell, or drop --tunnel to stay on this machine.");
    return { granted: false, reason: "no-tty" };
  }
  const answer = await io.ask("  Open the public tunnel? [y/N] ");
  if (!AFFIRMATIVE.test(answer.trim())) {
    io.say("  Cancelled. Nothing was started.");
    return { granted: false, reason: "declined" };
  }
  return { granted: true };
}

/**
 * What the CLI adds when a tunnel was asked for and there is none.
 *
 * The host already says the link is local-only and a phone cannot open it —
 * that is true wherever SetupHost is used. What only the CLI can usefully add
 * is what to do about it, so it does not repeat the rest.
 */
export function noTunnelBinaryMessage(): string[] {
  return [
    "  A phone will not be able to open the link below.",
    "  Install cloudflared from Cloudflare's documentation and run this again,",
    "  or finish the setup in a browser on this machine.",
  ];
}
