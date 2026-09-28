/** Keep durable tool outcomes identifiable even when the daemon response is lost. */
export function encodeOperationSuccess(result: unknown, operationId: string): string {
  const response = result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), operation_id: operationId }
    : { result, operation_id: operationId };
  return typeof response === "string" ? response : JSON.stringify(response);
}

export function encodeOperationError(message: string, operationId: string): string {
  // A timeout/disconnect can happen after the daemon committed admission, so
  // retrying could duplicate work. These two preflight failures happen before
  // the request was put on the socket and are therefore safe to retry.
  const isUnknownOutcome = /timed out|IPC disconnected/i.test(message);
  const isKnownNotSent = /Not connected to daemon IPC|IPC send failed/i.test(message);
  const detail = isUnknownOutcome
    ? `Outcome unknown; do not resend this operation. operation_id=${operationId}. Ask the operator to inspect its delivery status. Error: ${message}`
    : isKnownNotSent
      ? `Operation was not sent to the daemon and was not admitted. It is safe to retry. operation_id=${operationId}. Error: ${message}`
    : `${message} (operation_id=${operationId})`;
  return `Error: ${detail}`;
}
