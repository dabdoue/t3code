import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  /** Kept while reading queue entries written by the short-lived tool-boundary implementation. */
  queuedAfterToolActivityId?: string | null;
  /**
   * Set when a failed send is returned to the queue. It waits for Send now
   * instead of retrying on every ready-state projection.
   */
  holdUntilUserAction?: boolean;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /** A restored queue is deliberately held until the user opts back in. */
  autoSendByThreadKey: Record<string, boolean>;
  /**
   * Bumped by `drain`. A send that took a message before a drain and finishes
   * its upload after it compares this to the value it captured and gives up,
   * so Stop cannot be followed by a queued message starting a new turn.
   */
  drainGeneration: number;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /** Removes one message and returns it, or null when another caller already took it. */
  take: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /** Removes one message without touching the others' anchors. Null when already gone. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (
    threadKey: string,
    message: QueuedComposerMessage,
    holdUntilUserAction?: boolean,
  ) => void;
  setAutoSend: (threadKey: string, enabled: boolean) => void;
  reorder: (threadKey: string, orderedIds: ReadonlyArray<string>) => void;
  /** Removes and returns every queued message for the thread, oldest first. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

export const QUEUED_MESSAGE_STORAGE_KEY = "t3code:queued-composer-messages:v1";

interface PersistedQueueState {
  readonly queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function hydrateImage(image: ComposerImageAttachment): ComposerImageAttachment | null {
  if (typeof File !== "undefined" && image.file instanceof File) return image;
  const dataUrl = image.previewUrl;
  if (!dataUrl?.startsWith("data:")) return null;
  try {
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const bytes = header.includes(";base64")
      ? Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return { ...image, file: new File([bytes], image.name, { type: image.mimeType }) };
  } catch {
    return null;
  }
}

export function hydratePersistedQueueState(
  value: unknown,
): Record<string, QueuedComposerMessage[]> {
  try {
    const parsed = value as Partial<PersistedQueueState>;
    if (!parsed?.queuesByThreadKey || typeof parsed.queuesByThreadKey !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed.queuesByThreadKey).flatMap(([threadKey, messages]) => {
        if (!Array.isArray(messages)) return [];
        const hydrated = messages.flatMap((message) => {
          if (!message || typeof message !== "object" || typeof message.id !== "string") return [];
          return [
            {
              ...message,
              images: (message.images ?? []).flatMap((image) => {
                const hydratedImage = hydrateImage(image);
                return hydratedImage ? [hydratedImage] : [];
              }),
              // Browser File handles cannot cross a process restart. Finished
              // uploads retain their attachment id; unfinished files remain as
              // visible needs-reattach rows instead of disappearing.
              files: (message.files ?? []).map((file) => ({ ...file, file: null })),
            },
          ];
        });
        return hydrated.length > 0 ? [[threadKey, hydrated] as const] : [];
      }),
    );
  } catch {
    return {};
  }
}

function readPersistedQueues(): Record<string, QueuedComposerMessage[]> {
  try {
    const raw = storage()?.getItem(QUEUED_MESSAGE_STORAGE_KEY);
    return raw ? hydratePersistedQueueState(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function restoredQueueAutoSendState(
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>,
): Record<string, boolean> {
  return Object.fromEntries(Object.keys(queuesByThreadKey).map((threadKey) => [threadKey, false]));
}

function persistQueues(queuesByThreadKey: Record<string, QueuedComposerMessage[]>): void {
  try {
    storage()?.setItem(
      QUEUED_MESSAGE_STORAGE_KEY,
      JSON.stringify({ queuesByThreadKey }, (key, value: unknown) =>
        key === "file" ? undefined : value,
      ),
    );
  } catch (error) {
    console.error("[QUEUED-MESSAGES] Could not persist queued messages.", error);
  }
}

const persistedQueues = readPersistedQueues();
const restoredAutoSend = restoredQueueAutoSendState(persistedQueues);

export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: persistedQueues,
  autoSendByThreadKey: restoredAutoSend,
  drainGeneration: 0,
  enqueue: (threadKey, message) => {
    const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
    set((state) => {
      const queuesByThreadKey = {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
      };
      persistQueues(queuesByThreadKey);
      return {
        queuesByThreadKey,
        autoSendByThreadKey: {
          ...state.autoSendByThreadKey,
          [threadKey]: state.autoSendByThreadKey[threadKey] ?? true,
        },
      };
    });
    return entry;
  },
  take: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (message) => message.id !== id,
      );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      const autoSendByThreadKey = { ...state.autoSendByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
        delete autoSendByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      persistQueues(queuesByThreadKey);
      return { queuesByThreadKey, autoSendByThreadKey };
    });
    return entry;
  },
  remove: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (message) => message.id !== id,
      );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      const autoSendByThreadKey = { ...state.autoSendByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
        delete autoSendByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      persistQueues(queuesByThreadKey);
      return { queuesByThreadKey, autoSendByThreadKey };
    });
    return entry;
  },
  holdAtFront: (threadKey, message, holdUntilUserAction = true) => {
    set((state) => {
      const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (entry) => entry.id !== message.id,
      );
      const queuesByThreadKey = {
        ...state.queuesByThreadKey,
        [threadKey]: [{ ...message, holdUntilUserAction }, ...rest],
      };
      persistQueues(queuesByThreadKey);
      return { queuesByThreadKey };
    });
  },
  setAutoSend: (threadKey, enabled) => {
    set((state) => ({
      autoSendByThreadKey: { ...state.autoSendByThreadKey, [threadKey]: enabled },
      // Turning auto-send off also cancels an upload/send which took the head
      // but has not dispatched yet. The send path compares this generation.
      drainGeneration: state.drainGeneration + (enabled ? 0 : 1),
    }));
  },
  reorder: (threadKey, orderedIds) => {
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
      const byId = new Map(queue.map((message) => [message.id, message]));
      const reordered = [
        ...orderedIds.flatMap((id) => {
          const message = byId.get(id);
          if (!message) return [];
          byId.delete(id);
          return [message];
        }),
        ...byId.values(),
      ];
      const queuesByThreadKey = { ...state.queuesByThreadKey, [threadKey]: reordered };
      persistQueues(queuesByThreadKey);
      return { queuesByThreadKey };
    });
  },
  drain: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || queue.length === 0) {
      return EMPTY_QUEUE;
    }
    set((state) => {
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      delete queuesByThreadKey[threadKey];
      const autoSendByThreadKey = { ...state.autoSendByThreadKey };
      delete autoSendByThreadKey[threadKey];
      persistQueues(queuesByThreadKey);
      return { queuesByThreadKey, autoSendByThreadKey, drainGeneration: state.drainGeneration + 1 };
    });
    return queue;
  },
}));

/**
 * Queue means a subsequent turn: only a ready thread with Auto-send enabled
 * can drain. Explicit Send now/Steer bypasses this predicate.
 */
export function isQueuedMessageDue(input: {
  message: Pick<QueuedComposerMessage, "holdUntilUserAction">;
  phase: "connecting" | "running" | "ready" | "disconnected";
  autoSend: boolean;
}): boolean {
  return input.autoSend && !input.message.holdUntilUserAction && input.phase === "ready";
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}

export function useQueuedMessageAutoSend(threadKey: string): boolean {
  return useQueuedMessageStore((state) => state.autoSendByThreadKey[threadKey] ?? false);
}

// Other windows attached to the same T3 origin see the durable queue too.
// Pause after an external update so two clients cannot race to drain it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== QUEUED_MESSAGE_STORAGE_KEY) return;
    const queuesByThreadKey = readPersistedQueues();
    useQueuedMessageStore.setState({
      queuesByThreadKey,
      autoSendByThreadKey: restoredQueueAutoSendState(queuesByThreadKey),
    });
  });
}
