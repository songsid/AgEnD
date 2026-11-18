export function closureOf(graph: Record<string, string[]> | null, entry: string): string[];
export function createWarmer(opts?: { doc?: Document; url?: string }): (entry: string) => number;
export const warmModules: (entry: string) => number;
