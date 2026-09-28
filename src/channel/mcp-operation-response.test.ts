import { describe, expect, it } from "vitest";
import { encodeOperationError, encodeOperationSuccess } from "./mcp-operation-response.js";

describe("durable MCP operation response", () => {
  it("returns the same operation ID on a timeout with explicit no-resend guidance", () => {
    const text = encodeOperationError("IPC request timed out after 30000ms", "op-timeout");
    expect(text).toContain("operation_id=op-timeout");
    expect(text).toContain("Outcome unknown; do not resend");
  });

  it("returns the same operation ID on success and ordinary errors", () => {
    expect(JSON.parse(encodeOperationSuccess({ queued: true }, "op-ok"))).toMatchObject({
      queued: true,
      operation_id: "op-ok",
    });
    expect(encodeOperationError("target not found", "op-error")).toContain("operation_id=op-error");
  });
});
