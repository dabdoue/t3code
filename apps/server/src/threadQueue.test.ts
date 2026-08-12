import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type SharedQueuedThreadMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as ThreadQueue from "./threadQueue.ts";

const threadId = ThreadId.make("thread-shared-queue-test");

function message(index: number): SharedQueuedThreadMessage {
  return {
    threadId,
    messageId: MessageId.make(`message-${index}`),
    commandId: CommandId.make(`command-${index}`),
    text: `Message ${index}`,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeTurnMessageBehavior: "queue",
    queueOrder: index,
    paused: false,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(1_700_000_000_000 + index)),
  };
}

it.layer(NodeServices.layer)("shared thread queue", (it) => {
  it.effect("publishes mutations to connected clients and preserves explicit order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* ThreadQueue.make;
        const subscription = yield* queue.subscribe;
        const nextSnapshot = yield* subscription.changes.pipe(Stream.runHead, Effect.forkChild);

        yield* queue.upsert(message(1));
        expect(yield* Fiber.join(nextSnapshot)).toEqual(
          Option.some(
            expect.objectContaining({
              revision: 1,
              messages: [expect.objectContaining({ messageId: MessageId.make("message-1") })],
            }),
          ),
        );

        yield* queue.upsert(message(2));
        yield* queue.reorder(threadId, [MessageId.make("message-2"), MessageId.make("message-1")]);
        const snapshot = yield* queue.snapshot;
        expect(snapshot.messages.map((entry) => entry.messageId)).toEqual([
          MessageId.make("message-2"),
          MessageId.make("message-1"),
        ]);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-thread-queue-test-" }),
        ),
      ),
    ),
  );

  it.effect("reloads durable queue state and clears a deleted thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstInstance = yield* ThreadQueue.make;
        yield* firstInstance.upsert(message(1));
        yield* firstInstance.hold(threadId, true);

        const reloadedInstance = yield* ThreadQueue.make;
        const reloaded = yield* reloadedInstance.snapshot;
        expect(reloaded.messages.map((entry) => entry.messageId)).toEqual([
          MessageId.make("message-1"),
        ]);
        expect(reloaded.heldThreadIds).toEqual([threadId]);

        yield* reloadedInstance.removeThread(threadId);
        const clearedInstance = yield* ThreadQueue.make;
        expect(yield* clearedInstance.snapshot).toEqual({
          revision: 3,
          messages: [],
          heldThreadIds: [],
        });
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-thread-queue-test-" }),
        ),
      ),
    ),
  );
});
