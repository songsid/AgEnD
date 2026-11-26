/** Opaque, non-authority originating-call stamp. Safe in the standalone pane host. */
export const REQUEST_CONTEXT_CALL_CAPABILITY = "request-context-call-v1" as const;
export type RequestContextCallStamp = Readonly<
  | { version: 1; coverage: "covered"; proof: string }
  | { version: 1; coverage: "not-covered"; reason: "interrupted-launch" | "unbound-input" }
>;
export function validateRequestContextCallStamp(raw: unknown): RequestContextCallStamp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid originating-call stamp");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || (value.coverage === "covered"
    ? Object.keys(value).some(key => !["version", "coverage", "proof"].includes(key)) || typeof value.proof !== "string" || !/^[a-f0-9]{64}$/.test(value.proof)
    : value.coverage !== "not-covered" || Object.keys(value).some(key => !["version", "coverage", "reason"].includes(key))
      || !["interrupted-launch", "unbound-input"].includes(String(value.reason)))) throw Error("Invalid originating-call stamp");
  return Object.freeze({ ...value }) as RequestContextCallStamp;
}
