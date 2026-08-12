import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  beginWebThreadOutboxDispatch,
  finishWebThreadOutboxDispatch,
  shouldDrainWebThreadOutbox,
  shouldQueueWebThreadMessage,
  useWebThreadOutboxStore,
  webThreadOutboxKey,
  writeWebThreadOutboxEntryForTest,
  writeWebThreadOutboxStorageForTest,
  type QueuedWebThreadMessage,
} from "./webThreadOutbox";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-test");

function message(index: number): QueuedWebThreadMessage {
  return {
    environmentId,
    threadId,
    messageId: MessageId.make(`message-${index}`),
    commandId: CommandId.make(`command-${index}`),
    text: `Message ${index}`,
    composerText: `Composer message ${index}`,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeTurnMessageBehavior: "queue",
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

function resetOutbox(): void {
  writeWebThreadOutboxStorageForTest("");
}

function persistedOutbox(messages: ReadonlyArray<QueuedWebThreadMessage>): string {
  return JSON.stringify({
    version: 1,
    state: {
      queuesByThreadKey: {
        [webThreadOutboxKey(environmentId, threadId)]: messages,
      },
    },
  });
}

afterEach(resetOutbox);

describe("web thread outbox", () => {
  it("keeps an unbounded FIFO per thread", () => {
    const store = useWebThreadOutboxStore.getState();
    for (let index = 0; index < 100; index += 1) {
      store.enqueue(message(index));
    }

    const queue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queue).toHaveLength(100);
    expect(queue?.map((entry) => entry.messageId)).toEqual(
      Array.from({ length: 100 }, (_, index) => MessageId.make(`message-${index}`)),
    );
  });

  it("hydrates the legacy full-key snapshot", () => {
    const queued = message(1);
    writeWebThreadOutboxStorageForTest(persistedOutbox([queued]));

    expect(
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ],
    ).toEqual([queued]);
  });

  it("deduplicates stable message ids and removes only the delivered head", () => {
    const first = message(1);
    const second = message(2);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(first);
    store.enqueue(second);
    store.enqueue({ ...first, text: "Updated" });
    store.remove(first);

    const queue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queue?.map((entry) => entry.messageId)).toEqual([second.messageId]);
  });

  it("promotes one queued message to steer ahead of FIFO work and persists the intent", () => {
    const first = message(1);
    const second = message(2);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(first);
    store.enqueue(second);

    expect(store.promoteToSteer(second.messageId, "2026-08-12T00:00:00.000Z")).toMatchObject({
      found: true,
    });

    const queueAfterPromotion =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queueAfterPromotion?.map((entry) => entry.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
    expect(queueAfterPromotion?.[0]).toMatchObject({
      activeTurnMessageBehavior: "steer",
      steerRequestedAt: "2026-08-12T00:00:00.000Z",
    });

    writeWebThreadOutboxEntryForTest(queueAfterPromotion?.[0] as QueuedWebThreadMessage);
    const hydratedQueue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(hydratedQueue?.map((entry) => entry.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
  });

  it("persists an explicit queue reorder and appends later messages after it", () => {
    const first = message(1);
    const second = message(2);
    const third = message(3);
    const fourth = message(4);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(first);
    store.enqueue(second);
    store.enqueue(third);

    store.reorder(environmentId, threadId, [third.messageId, first.messageId, second.messageId]);
    store.enqueue(fourth);

    const queue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queue?.map((entry) => entry.messageId)).toEqual([
      third.messageId,
      first.messageId,
      second.messageId,
      fourth.messageId,
    ]);
    expect(queue?.slice(0, 3).map((entry) => entry.queueOrder)).toEqual([0, 1, 2]);

    writeWebThreadOutboxEntryForTest(queue?.[0] as QueuedWebThreadMessage);
    expect(
      useWebThreadOutboxStore
        .getState()
        .queuesByThreadKey[webThreadOutboxKey(environmentId, threadId)]?.map(
          (entry) => entry.messageId,
        ),
    ).toEqual([third.messageId, first.messageId, second.messageId, fourth.messageId]);
  });

  it("keeps another tab's independently persisted message when enqueueing", () => {
    const first = message(1);
    const second = message(2);
    const third = message(3);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(first);

    writeWebThreadOutboxEntryForTest(second, {
      syncStore: false,
    });
    store.enqueue(third);

    const queue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queue?.map((entry) => entry.messageId)).toEqual([
      first.messageId,
      second.messageId,
      third.messageId,
    ]);
  });

  it("preserves another tab's independently persisted message when removing", () => {
    const first = message(1);
    const second = message(2);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(first);

    writeWebThreadOutboxEntryForTest(second, {
      syncStore: false,
    });
    store.remove(first);

    const queue =
      useWebThreadOutboxStore.getState().queuesByThreadKey[
        webThreadOutboxKey(environmentId, threadId)
      ];
    expect(queue?.map((entry) => entry.messageId)).toEqual([second.messageId]);
  });

  it("permits only one dispatcher for a stable message id", () => {
    const queued = message(3);
    expect(beginWebThreadOutboxDispatch(queued.messageId)).toBe(true);
    expect(beginWebThreadOutboxDispatch(queued.messageId)).toBe(false);
    finishWebThreadOutboxDispatch(queued.messageId);
    expect(beginWebThreadOutboxDispatch(queued.messageId)).toBe(true);
    finishWebThreadOutboxDispatch(queued.messageId);
  });

  it("drains settled work and running steer work, but never starting work", () => {
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "ready",
        environmentConnected: true,
        paused: false,
        held: false,
        activeTurnMessageBehavior: "queue",
      }),
    ).toBe(true);
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "running",
        environmentConnected: true,
        paused: false,
        held: false,
        activeTurnMessageBehavior: "queue",
      }),
    ).toBe(false);
    for (const sessionStatus of ["error", "idle", "interrupted", "stopped"] as const) {
      expect(
        shouldDrainWebThreadOutbox({
          sessionStatus,
          environmentConnected: true,
          paused: false,
          held: false,
          activeTurnMessageBehavior: "queue",
        }),
      ).toBe(true);
    }
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "running",
        environmentConnected: true,
        paused: false,
        held: false,
        activeTurnMessageBehavior: "steer",
      }),
    ).toBe(true);
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "starting",
        environmentConnected: true,
        paused: false,
        held: false,
        activeTurnMessageBehavior: "steer",
      }),
    ).toBe(false);
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "ready",
        environmentConnected: true,
        paused: true,
        held: false,
        activeTurnMessageBehavior: "queue",
      }),
    ).toBe(false);
  });

  it("persists a paused message across store hydration", () => {
    const queued = message(4);
    useWebThreadOutboxStore.getState().enqueue(queued);
    useWebThreadOutboxStore.getState().pause(queued.messageId);

    writeWebThreadOutboxEntryForTest(queued, { paused: true });

    expect(useWebThreadOutboxStore.getState().pausedMessageIds[queued.messageId]).toBe(true);
  });

  it("holds a stopped thread queue while allowing an explicit steer", () => {
    const queued = message(5);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(queued);
    expect(store.holdThread(environmentId, threadId)).toEqual({ changed: true });

    const threadKey = webThreadOutboxKey(environmentId, threadId);
    expect(useWebThreadOutboxStore.getState().heldThreadKeys[threadKey]).toBe(true);
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "interrupted",
        environmentConnected: true,
        paused: false,
        held: true,
        activeTurnMessageBehavior: "queue",
      }),
    ).toBe(false);
    expect(
      shouldDrainWebThreadOutbox({
        sessionStatus: "interrupted",
        environmentConnected: true,
        paused: false,
        held: true,
        activeTurnMessageBehavior: "steer",
      }),
    ).toBe(true);

    writeWebThreadOutboxEntryForTest(queued);
    expect(useWebThreadOutboxStore.getState().heldThreadKeys[threadKey]).toBe(true);
  });

  it("clears a thread hold when its final queued message is removed", () => {
    const queued = message(6);
    const store = useWebThreadOutboxStore.getState();
    store.enqueue(queued);
    store.holdThread(environmentId, threadId);
    store.remove(queued);

    expect(
      useWebThreadOutboxStore.getState().heldThreadKeys[
        webThreadOutboxKey(environmentId, threadId)
      ],
    ).toBeUndefined();
  });

  it("queues active-turn messages only when queue mode or an existing FIFO requires it", () => {
    const activeThread = {
      isServerThread: true,
      phase: "running" as const,
      isSendBusy: false,
      hasQueuedMessages: false,
      queueHeld: false,
      threadStarting: false,
    };

    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        activeTurnMessageBehavior: "queue",
      }),
    ).toBe(true);
    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        phase: "ready",
        activeTurnMessageBehavior: "queue",
        hasQueuedMessages: true,
        queueHeld: true,
      }),
    ).toBe(false);
    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        activeTurnMessageBehavior: "steer",
      }),
    ).toBe(false);
    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        phase: "connecting",
        threadStarting: true,
        activeTurnMessageBehavior: "steer",
      }),
    ).toBe(true);
    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        activeTurnMessageBehavior: "steer",
        hasQueuedMessages: true,
      }),
    ).toBe(true);
    expect(
      shouldQueueWebThreadMessage({
        ...activeThread,
        activeTurnMessageBehavior: "queue",
        isServerThread: false,
      }),
    ).toBe(false);
  });
});
