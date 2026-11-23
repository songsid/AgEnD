/**
 * M-3529: General's role block in its host instructions file. Host only: general-role.ts ships in the Windows runtime
 * bundle, so this lives beside it and leaves that module as it is.
 */
import { createHash } from "node:crypto";
import { GENERAL_ROLE_INSTRUCTIONS } from "./general-role.js";
/**
 * On the host, General's role text sits in its instructions file between these markers, and every sync
 * replaces what is between them, as the core-rules block is replaced, so a wording change reaches existing Generals.
 */
export const GENERAL_ROLE_BLOCK_BEGIN = "<!-- >>> agend:general-role — managed by AgEnD; edits inside this block are overwritten -->";
export const GENERAL_ROLE_BLOCK_END = "<!-- <<< agend:general-role -->";

/**
 * Every role text AgEnD wrote before the markers existed, as [UTF-16 length, sha256 of the text] with trailing
 * whitespace removed, longest first (from git history: the eight versions since 2026-04). A file that starts with one
 * of them is AgEnD's own copy, so that copy becomes the managed block and the rest of the file stays as it is.
 */
const UNMARKED_ROLE_TEXTS: ReadonlyArray<readonly [number, string]> = [
  [5121, "d7ac96ef2bad353372c686490e46356eb5825e94db7c66f27eb919617248482d"],
  [5097, "a10cf26a9960b3d7ce568a9a3153e66b7c0b8b16228baaa35072e14ab2a58ac6"],
  [4677, "298c236b53b87d413fe3a2d7397bc5974fc34f805a6aac1e85930bce430bc8b3"],
  [2086, "ee515f88ed1b9f3f9e659018979cb7f1ebc21041c2b6092182e1ec063f3cf4ed"],
  [1739, "aad2207ca32d17475bf3a7eaee5e1e535c7ee179002ab47363b9e5cfded639d0"],
  [1703, "8df3f9a2e0e50c0c64385fbff53a246434f147f93c8957e32c14284c52e22e49"],
  [1199, "281b29f8ac051106395b1a48633d9e2ca4d65e6aa82eb47611877c8f53af345d"],
  [920, "551868e1d888bf574bb551b5ea9ec85088957a0a491ffb89d45627bf96e89f97"],
];

export type GeneralRolePlacement = "created" | "updated" | "unchanged" | "adopted" | "added" | "customized";

/**
 * Where General's role block goes in its instructions file (`existing`: the file's text, or null when there is none).
 * - no file: the block alone ("created");
 * - the markers: the block replaces what is between them ("updated", or "unchanged" when it is the same);
 * - an unmarked role text AgEnD wrote earlier at the top: that text becomes the block ("adopted");
 * - a person's own coordinator text at the top (an edited copy): left exactly as it is ("customized");
 * - any other file (for example a project's own CLAUDE.md): the block goes first and the file follows ("added").
 */
export function placeGeneralRole(existing: string | null, role: string = GENERAL_ROLE_INSTRUCTIONS): { text: string; placement: GeneralRolePlacement } {
  const block = `${GENERAL_ROLE_BLOCK_BEGIN}\n${role.trim()}\n${GENERAL_ROLE_BLOCK_END}`;
  if (existing === null) return { text: block + "\n", placement: "created" };
  const begin = existing.indexOf(GENERAL_ROLE_BLOCK_BEGIN), end = existing.indexOf(GENERAL_ROLE_BLOCK_END);
  if (begin !== -1 && end > begin) {
    const text = existing.slice(0, begin) + block + existing.slice(end + GENERAL_ROLE_BLOCK_END.length);
    return { text, placement: text === existing ? "unchanged" : "updated" };
  }
  for (const [length, digest] of UNMARKED_ROLE_TEXTS) {
    if (existing.length < length || (existing.length > length && !/\s/.test(existing[length]))) continue;
    if (createHash("sha256").update(existing.slice(0, length)).digest("hex") === digest) {
      return { text: block + existing.slice(length), placement: "adopted" };
    }
  }
  if (/^\s*# (Fleet Coordinator|General Assistant)\b/.test(existing)) return { text: existing, placement: "customized" };
  return { text: block + "\n\n" + existing, placement: "added" };
}

