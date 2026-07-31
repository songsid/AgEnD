import { describe, expect, it } from "vitest";
import { renderHandoffMetadata } from "../src/daemon.js";

// The sender (outbound-handlers) has always built correlation_id, request_kind,
// requires_reply, task_summary, working_directory, branch and message_id into
// ipcMeta and delivered them over IPC — but the pane render dropped every one, so
// the receiving agent could not see them. That broke report_result correlation,
// cancel-button retirement, react/edit_message/reply_to, and download_attachment,
// and made a delegated task indistinguishable from an FYI.

describe("renderHandoffMetadata", () => {
  it("renders the fields a recipient needs to act on the message", () => {
    const out = renderHandoffMetadata({
      message_id: "xmsg-1",
      correlation_id: "cid-abc",
      request_kind: "task",
      task_summary: "port the provider",
      working_directory: "/repo",
      branch: "feat/x",
      attachment_file_id: "file-9",
    });
    expect(out).toContain("message_id: xmsg-1");
    expect(out).toContain("correlation_id: cid-abc");
    expect(out).toContain("request_kind: task");
    expect(out).toContain("task_summary: port the provider");
    expect(out).toContain("working_directory: /repo");
    expect(out).toContain("branch: feat/x");
    expect(out).toContain("attachment_file_id: file-9");
  });

  it("emits nothing when there is no metadata", () => {
    expect(renderHandoffMetadata({})).toBe("");
  });

  it("skips empty and whitespace-only values", () => {
    const out = renderHandoffMetadata({ message_id: "m1", correlation_id: "", branch: "   " });
    expect(out).toContain("message_id: m1");
    expect(out).not.toContain("correlation_id");
    expect(out).not.toContain("branch");
  });

  it("stays on one parenthesised line so it does not bloat the pasted block", () => {
    const out = renderHandoffMetadata({ message_id: "m1", correlation_id: "c1" });
    expect(out.startsWith("\n(")).toBe(true);
    expect(out.endsWith(")")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("does not render requires_reply — that drives the instruction line instead", () => {
    // requires_reply changes which closing instruction the agent sees; repeating it
    // as a raw field would be noise.
    expect(renderHandoffMetadata({ requires_reply: "true" })).toBe("");
  });
});
