import { computeKiroClassicLinks, type KiroClassicLinks } from "../../src/backend/kiro-classic-links.js";
import { kiroDirectoryKeys } from "../../src/backend/kiro-identity.js";

/** #2738: a classic store's compaction links worked out here, in-process — what the worker lane does for a launch. */
export function classicLinks(workingDirectory: string, dbPath: string): KiroClassicLinks {
  return computeKiroClassicLinks({ dbPath, keys: kiroDirectoryKeys(workingDirectory) }, () => false);
}

/** For a listing that never asks about compaction. */
export const NO_CLASSIC_LINKS: KiroClassicLinks = { kind: "ok", successors: {}, summarized: {} };
