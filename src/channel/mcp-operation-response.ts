/** Keep durable tool outcomes identifiable even when the daemon response is lost. */
export function encodeOperationSuccess(result: unknown, operationId: string): string {
  const response = result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), operation_id: operationId }
    : { result, operation_id: operationId };
  return typeof response === "string" ? response : JSON.stringify(response);
}

export function encodeOperationError(message: string, operationId: string): string {
  const isUnknownOutcome = /timed out|IPC disconnected|IPC send failed|Not connected to daemon IPC/i.test(message);
  const detail = isUnknownOutcome
    ? `Outcome unknown; do not resend this operation. operation_id=${operationId}. Ask the operator to inspect its delivery status. Error: ${message}`
    : `${message} (operation_id=${operationId})`;
  return `Error: ${detail}`;
}
