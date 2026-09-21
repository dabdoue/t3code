import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  hydratePersistedQueueState,
  isQueuedMessageDue,
  restoredQueueAutoSendState,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({
      queuesByThreadKey: {},
      autoSendByThreadKey: {},
      drainGeneration: 0,
    });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    const queues = useQueuedMessageStore.getState().queuesByThreadKey;
    expect(queues["thread-a"]?.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queues["thread-b"]?.map((message) => message.prompt)).toEqual(["other"]);
  });

  it("take hands the message to exactly one caller", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const entry = enqueue("thread-a", makeMessage("first"));

    expect(take("thread-a", entry.id)?.prompt).toBe("first");
    expect(take("thread-a", entry.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("take leaves the remaining messages in FIFO order", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));

    take("thread-a", first.id);

    const [second] = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(second?.prompt).toBe("second");
  });

  it("remove leaves the other messages unchanged", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toEqual([first]);
  });

  it("holdAtFront returns a failed message to the head, held", () => {
    const { enqueue, take, holdAtFront } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    const taken = take("thread-a", first.id)!;

    holdAtFront("thread-a", taken);

    const queue = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(queue.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(isQueuedMessageDue({ message: queue[0]!, phase: "ready", autoSend: true })).toBe(false);
  });

  it("can return a cancelled in-flight message without forcing a manual retry", () => {
    const { enqueue, take, holdAtFront } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const taken = take("thread-a", first.id)!;

    holdAtFront("thread-a", taken, false);

    const [restored] = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(restored?.holdUntilUserAction).toBe(false);
  });

  it("drain empties one thread's queue in order", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);
    expect(drain("thread-a")).toEqual([]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-b"]).toHaveLength(1);
  });
});

describe("queued message restart recovery", () => {
  it("restores metadata-only files visibly and pauses every recovered thread", () => {
    const message = {
      ...makeMessage("with a file"),
      id: "message-1",
      files: [
        {
          type: "file" as const,
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          file: { processLocal: true },
        },
      ],
    };

    const queues = hydratePersistedQueueState({ queuesByThreadKey: { "thread-a": [message] } });

    expect(queues["thread-a"]?.[0]?.files[0]).toMatchObject({
      name: "notes.txt",
      file: null,
    });
    expect(restoredQueueAutoSendState(queues)).toEqual({ "thread-a": false });
  });

  it("preserves a completed upload id while dropping its process-local File handle", () => {
    const message = {
      ...makeMessage("uploaded file"),
      id: "message-1",
      files: [
        {
          type: "file" as const,
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          file: { processLocal: true },
          uploadedAttachmentId: "attachment-1",
          uploadEnvironmentId: "environment-1",
        },
      ],
    };

    const queues = hydratePersistedQueueState({ queuesByThreadKey: { "thread-a": [message] } });

    expect(queues["thread-a"]?.[0]?.files[0]).toMatchObject({
      file: null,
      uploadedAttachmentId: "attachment-1",
      uploadEnvironmentId: "environment-1",
    });
  });
});

describe("queued message dispatch timing", () => {
  it("waits for the turn to finish regardless of later tool activity", () => {
    const message = {};
    expect(isQueuedMessageDue({ message, phase: "running", autoSend: true })).toBe(false);
    expect(isQueuedMessageDue({ message, phase: "ready", autoSend: true })).toBe(true);
  });

  it("never auto-sends a message held for user action", () => {
    const message = { holdUntilUserAction: true };
    expect(isQueuedMessageDue({ message, phase: "ready", autoSend: true })).toBe(false);
  });

  it("requires auto-send and a ready thread", () => {
    const message = {};
    expect(isQueuedMessageDue({ message, phase: "ready", autoSend: false })).toBe(false);
    expect(isQueuedMessageDue({ message, phase: "connecting", autoSend: true })).toBe(false);
  });
});
