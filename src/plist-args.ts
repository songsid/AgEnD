/**
 * A launchd plist's `ProgramArguments`, read from its XML — node built-ins only, so the update recovery kit's bundle
 * (recover.cjs) can wrap and unwrap the job's arguments (M-3770 §6.2) without loading the service installer.
 * service-activation.ts's `parsePlist` reads the same arguments through these.
 */

/** XML character data → text: the five named entities and numeric references (EJS writes `"` as `&#34;`), in one pass. */
export const xmlUnescape = (text: string): string => text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g, (whole, dec?: string, hex?: string, name?: string) => {
  if (dec !== undefined || hex !== undefined) {
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ({ lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" } as Record<string, string>)[name!]!;
});

/** The job's `ProgramArguments` (argv, unescaped), or null when there is no such array or it is empty. */
export function plistProgramArguments(xml: string): string[] | null {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!args) return null;
  const argv = [...args[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => xmlUnescape(m[1]!));
  return argv.length ? argv : null;
}
