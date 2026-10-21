/** Deliberately synthetic credentials; never store an encoded token literal in fixtures. */
export function syntheticTunnelFields() {
  return { a: "0".repeat(32), t: ["0".repeat(8), "0000", "4000", "8000", "0".repeat(11) + "1"].join("-"), s: Buffer.alloc(32, 1).toString("base64") };
}
export function syntheticTunnelToken(fields: unknown = syntheticTunnelFields(), encoding: "base64" | "base64url" = "base64") {
  return Buffer.from(JSON.stringify(fields)).toString(encoding);
}
