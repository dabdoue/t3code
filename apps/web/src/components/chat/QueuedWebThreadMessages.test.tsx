import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { QueuedWebThreadMessage } from "../../webThreadOutbox";
import { QueuedWebThreadMessages } from "./QueuedWebThreadMessages";

const queuedMessage: QueuedWebThreadMessage = {
  environmentId: EnvironmentId.make("environment-test"),
  threadId: ThreadId.make("thread-test"),
  messageId: MessageId.make("message-test"),
  commandId: CommandId.make("command-test"),
  text: "Handle future attempts the same way",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  activeTurnMessageBehavior: "queue",
  createdAt: "2026-08-12T00:00:00.000Z",
};

describe("QueuedWebThreadMessages", () => {
  it("shows queued text with explicit Steer and remove actions", () => {
    const markup = renderToStaticMarkup(
      <QueuedWebThreadMessages
        messages={[queuedMessage]}
        pausedMessageIds={{}}
        canSteer
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(markup).toContain("Handle future attempts the same way");
    expect(markup).toContain("Steer");
    expect(markup).toContain('aria-label="Steer queued message into the active turn"');
    expect(markup).toContain('aria-label="Remove queued message"');
    expect(markup).toContain('aria-label="Reorder queued message"');
    expect(markup).toContain('aria-label="Queued message actions"');
    expect(markup).not.toContain("Retry");
  });

  it("shows Retry for a paused delivery and disables Steer without an active turn", () => {
    const markup = renderToStaticMarkup(
      <QueuedWebThreadMessages
        messages={[queuedMessage]}
        pausedMessageIds={{ [queuedMessage.messageId]: true }}
        canSteer={false}
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(markup).toContain("Retry");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Steer is unavailable right now");
  });
});
