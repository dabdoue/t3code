import {
  ThreadQueueError,
  ThreadQueueSnapshot,
  type MessageId,
  type SharedQueuedThreadMessage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";

const EMPTY_SNAPSHOT: ThreadQueueSnapshot = {
  revision: 0,
  messages: [],
  heldThreadIds: [],
};
const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadQueueSnapshot));
const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(ThreadQueueSnapshot));

function sortMessages(messages: ReadonlyArray<SharedQueuedThreadMessage>) {
  return [...messages].sort((left, right) => {
    const leftSteer = left.activeTurnMessageBehavior === "steer";
    const rightSteer = right.activeTurnMessageBehavior === "steer";
    if (leftSteer !== rightSteer) return leftSteer ? -1 : 1;
    if (!leftSteer) {
      const orderDelta =
        (left.queueOrder ?? Number.POSITIVE_INFINITY) -
        (right.queueOrder ?? Number.POSITIVE_INFINITY);
      if (orderDelta !== 0) return orderDelta;
    }
    return (
      (left.steerRequestedAt ?? left.createdAt).localeCompare(
        right.steerRequestedAt ?? right.createdAt,
      ) || String(left.messageId).localeCompare(String(right.messageId))
    );
  });
}

export interface ThreadQueueShape {
  readonly snapshot: Effect.Effect<ThreadQueueSnapshot>;
  readonly upsert: (
    message: SharedQueuedThreadMessage,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly remove: (messageId: MessageId) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly removeThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly reorder: (
    threadId: ThreadId,
    orderedMessageIds: ReadonlyArray<MessageId>,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly promote: (
    messageId: MessageId,
    requestedAt: string,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly pause: (
    messageId: MessageId,
    paused: boolean,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly hold: (
    threadId: ThreadId,
    held: boolean,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly holdThreads: (
    threadIds: ReadonlyArray<ThreadId>,
    held: boolean,
  ) => Effect.Effect<ThreadQueueSnapshot, ThreadQueueError>;
  readonly subscribe: Effect.Effect<
    {
      readonly latest: ThreadQueueSnapshot;
      readonly changes: Stream.Stream<ThreadQueueSnapshot>;
    },
    never,
    Scope.Scope
  >;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig;
  const queuePath = pathService.join(config.stateDir, "thread-queue.json");
  const initial = yield* fs.exists(queuePath).pipe(
    Effect.flatMap((exists) => (exists ? fs.readFileString(queuePath) : Effect.succeed(null))),
    Effect.flatMap((raw) =>
      raw === null ? Effect.succeed(EMPTY_SNAPSHOT) : decodeSnapshotJson(raw),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to load shared thread queue; starting empty", { cause }).pipe(
        Effect.as(EMPTY_SNAPSHOT),
      ),
    ),
  );
  const state = yield* Ref.make<ThreadQueueSnapshot>({
    ...initial,
    messages: sortMessages(initial.messages),
  });
  const changes = yield* PubSub.unbounded<ThreadQueueSnapshot>();
  const mutex = yield* Semaphore.make(1);

  const mutate = (
    update: (current: ThreadQueueSnapshot) => Omit<ThreadQueueSnapshot, "revision">,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const updated = update(current);
        const next: ThreadQueueSnapshot = {
          revision: current.revision + 1,
          messages: sortMessages(updated.messages),
          heldThreadIds: [...new Set(updated.heldThreadIds)],
        };
        const encoded = yield* encodeSnapshotJson(next).pipe(
          Effect.mapError(
            (cause) => new ThreadQueueError({ message: "Failed to encode thread queue", cause }),
          ),
        );
        yield* writeFileStringAtomically({
          filePath: queuePath,
          contents: `${encoded}\n`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError(
            (cause) => new ThreadQueueError({ message: "Failed to persist thread queue", cause }),
          ),
        );
        yield* Ref.set(state, next);
        yield* PubSub.publish(changes, next);
        return next;
      }),
    );

  const holdThreads: ThreadQueueShape["holdThreads"] = (threadIds, held) =>
    mutate((current) => {
      const targetThreadIds = new Set(threadIds);
      return {
        messages: current.messages,
        heldThreadIds: held
          ? [
              ...current.heldThreadIds.filter((threadId) => !targetThreadIds.has(threadId)),
              ...targetThreadIds,
            ]
          : current.heldThreadIds.filter((threadId) => !targetThreadIds.has(threadId)),
      };
    });

  return {
    snapshot: Ref.get(state),
    upsert: (message) =>
      mutate((current) => ({
        messages: [
          ...current.messages.filter((item) => item.messageId !== message.messageId),
          message,
        ],
        heldThreadIds: current.heldThreadIds,
      })),
    remove: (messageId) =>
      mutate((current) => {
        const removed = current.messages.find((message) => message.messageId === messageId);
        const messages = current.messages.filter((message) => message.messageId !== messageId);
        const heldThreadIds =
          removed && !messages.some((message) => message.threadId === removed.threadId)
            ? current.heldThreadIds.filter((threadId) => threadId !== removed.threadId)
            : current.heldThreadIds;
        return { messages, heldThreadIds };
      }),
    removeThread: (threadId) =>
      mutate((current) => ({
        messages: current.messages.filter((message) => message.threadId !== threadId),
        heldThreadIds: current.heldThreadIds.filter((candidate) => candidate !== threadId),
      })),
    reorder: (threadId, orderedMessageIds) =>
      mutate((current) => {
        const order = new Map(orderedMessageIds.map((messageId, index) => [messageId, index]));
        return {
          messages: current.messages.map((message) =>
            message.threadId === threadId && order.has(message.messageId)
              ? { ...message, queueOrder: order.get(message.messageId)! }
              : message,
          ),
          heldThreadIds: current.heldThreadIds,
        };
      }),
    promote: (messageId, requestedAt) =>
      mutate((current) => ({
        messages: current.messages.map((message) =>
          message.messageId === messageId
            ? {
                ...message,
                activeTurnMessageBehavior: "steer" as const,
                steerRequestedAt: requestedAt,
                paused: false,
              }
            : message,
        ),
        heldThreadIds: current.heldThreadIds,
      })),
    pause: (messageId, paused) =>
      mutate((current) => ({
        messages: current.messages.map((message) =>
          message.messageId === messageId ? { ...message, paused } : message,
        ),
        heldThreadIds: current.heldThreadIds,
      })),
    hold: (threadId, held) => holdThreads([threadId], held),
    holdThreads,
    subscribe: mutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return {
          latest: yield* Ref.get(state),
          changes: Stream.fromSubscription(subscription),
        };
      }),
    ),
  } satisfies ThreadQueueShape;
});

export class ThreadQueue extends Context.Service<ThreadQueue, ThreadQueueShape>()(
  "t3/threadQueue",
) {}

export const layer = Layer.effect(ThreadQueue, make);
