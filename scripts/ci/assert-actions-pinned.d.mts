/** Types for `assert-actions-pinned.mjs`. Node16 resolves a `.mjs` import to `.d.mts`. */
export type UsesHit = {
  value: string;
  unsupported?: boolean;
  raw?: string;
  line?: number;
};

export function extractUses(text: string): UsesHit[];
