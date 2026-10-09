import { t } from "./locale.js";
import { classifySqliteOpenError, type SqliteOpenFailure } from "./sqlite-open-errors.js";

/** Outbox rows are delivery evidence. An open failure must never create an empty replacement queue. */
export class OutboxOpenError extends Error {
  readonly kind: SqliteOpenFailure;

  constructor(readonly dbPath: string, cause: unknown) {
    const kind = classifySqliteOpenError(cause);
    super(t("delivery.outbox_unavailable", dbPath, t(`delivery.outbox_${kind}`)), { cause });
    this.name = "OutboxOpenError";
    this.kind = kind;
  }
}
