import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { canonicalizeClientCommandTimestamps, parseUploadAttachmentPayload } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("parseUploadAttachmentPayload", () => {
  it("decodes arbitrary non-image payloads without changing their bytes", () => {
    const result = parseUploadAttachmentPayload({
      type: "file",
      name: "measurements.parquet",
      mimeType: "application/vnd.apache.parquet",
      sizeBytes: 5,
      dataUrl: "data:application/vnd.apache.parquet;base64,aGVsbG8=",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("application/vnd.apache.parquet");
      expect(result.bytes.toString("utf8")).toBe("hello");
    }
  });

  it("rejects declared mime types that do not match the data URL", () => {
    expect(
      parseUploadAttachmentPayload({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
