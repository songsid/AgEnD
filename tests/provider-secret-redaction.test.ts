import { describe, expect, it } from "vitest";
import { redactProviderError, verifyTelegramToken } from "../src/provider-probe.js";

describe("provider secret redaction", () => {
  it("removes Telegram bot URLs and bearer values from errors", () => {
    const token = "123456:super-secret";
    const text = redactProviderError(new Error(`request to https://api.telegram.org/bot${token}/getMe failed`), token);
    expect(text).not.toContain(token);
    expect(text).toContain("[redacted]");
  });

  it("does not leak the token when verification fetch throws", async () => {
    const token = "123456:super-secret";
    const result = await verifyTelegramToken(token, async () => {
      throw new Error(`FetchError: https://api.telegram.org/bot${token}/getMe ECONNRESET`);
    });
    expect(result.valid).toBe(false);
    expect(result.reason).not.toContain(token);
  });
});
