import {
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ThreadQueueSnapshot,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import {
  ActiveTurnMessageBehavior,
  type ActiveTurnMessageBehavior as ActiveTurnMessageBehaviorType,
} from "@t3tools/contracts/settings";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";

export const WEB_THREAD_OUTBOX_STORAGE_KEY = "t3code:thread-outbox:v1";
export const WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX = "t3code:thread-outbox:v2:";
export const WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX = "t3code:thread-outbox:hold:v1:";
const WEB_THREAD_OUTBOX_STORAGE_VERSION = 2;

interface EnumerableStorage {
  readonly length: number;
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
  key(index: number): string | null;
}

function createEnumerableMemoryStorage(): EnumerableStorage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    getItem: (name) => entries.get(name) ?? null,
    setItem: (name, value) => entries.set(name, value),
    removeItem: (name) => entries.delete(name),
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

const QueuedWebImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

const QueuedWebThreadMessageSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  composerText: Schema.optional(Schema.String),
  attachments: Schema.Array(QueuedWebImageAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  activeTurnMessageBehavior: Schema.optional(ActiveTurnMessageBehavior),
  steerRequestedAt: Schema.optional(Schema.String),
  queueOrder: Schema.optional(Schema.Number),
  createdAt: Schema.String,
});

export interface QueuedWebThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly composerText?: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
  readonly steerRequestedAt?: string;
  readonly queueOrder?: number;
  readonly createdAt: string;
}

const PersistedWebThreadOutboxState = Schema.Struct({
  queuesByThreadKey: Schema.Record(Schema.String, Schema.Array(QueuedWebThreadMessageSchema)),
});
const PersistedWebThreadOutboxEntry = Schema.Struct({
  message: QueuedWebThreadMessageSchema,
  paused: Schema.Boolean,
});
const decodePersistedState = Schema.decodeUnknownSync(PersistedWebThreadOutboxState);
const decodePersistedEntry = Schema.decodeUnknownSync(PersistedWebThreadOutboxEntry);

function normalizeMessage(
  message: typeof QueuedWebThreadMessageSchema.Type,
): QueuedWebThreadMessage {
  const { composerText, queueOrder, steerRequestedAt, ...rest } = message;
  return {
    ...rest,
    activeTurnMessageBehavior: message.activeTurnMessageBehavior ?? "queue",
    ...(composerText === undefined ? {} : { composerText }),
    ...(steerRequestedAt === undefined ? {} : { steerRequestedAt }),
    ...(queueOrder === undefined ? {} : { queueOrder }),
  };
}

export function webThreadOutboxKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function storageKey(messageId: MessageId): string {
  return `${WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX}${encodeURIComponent(String(messageId))}`;
}

function holdStorageKey(threadKey: string): string {
  return `${WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX}${encodeURIComponent(threadKey)}`;
}

function groupMessages(
  messages: Iterable<QueuedWebThreadMessage>,
): Record<string, ReadonlyArray<QueuedWebThreadMessage>> {
  const byId = new Map<MessageId, QueuedWebThreadMessage>();
  for (const message of messages) {
    byId.set(message.messageId, message);
  }
  const grouped: Record<string, Array<QueuedWebThreadMessage>> = {};
  for (const message of byId.values()) {
    const threadKey = webThreadOutboxKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => {
      const leftSteerAt =
        left.activeTurnMessageBehavior === "steer"
          ? (left.steerRequestedAt ?? left.createdAt)
          : null;
      const rightSteerAt =
        right.activeTurnMessageBehavior === "steer"
          ? (right.steerRequestedAt ?? right.createdAt)
          : null;
      if (leftSteerAt !== null && rightSteerAt === null) return -1;
      if (leftSteerAt === null && rightSteerAt !== null) return 1;
      if (leftSteerAt === null && rightSteerAt === null) {
        const leftQueueOrder = left.queueOrder ?? Number.POSITIVE_INFINITY;
        const rightQueueOrder = right.queueOrder ?? Number.POSITIVE_INFINITY;
        if (leftQueueOrder !== rightQueueOrder) return leftQueueOrder - rightQueueOrder;
      }
      return (
        (leftSteerAt ?? left.createdAt).localeCompare(rightSteerAt ?? right.createdAt) ||
        String(left.messageId).localeCompare(String(right.messageId))
      );
    });
  }
  return grouped;
}

function flattenQueues(
  queues: Record<string, ReadonlyArray<QueuedWebThreadMessage>>,
): ReadonlyArray<QueuedWebThreadMessage> {
  return Object.values(queues).flat();
}

function resolveBaseStorage(): { storage: EnumerableStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Sandboxed browsers can reject access to the localStorage property itself.
  }
  return { storage: createEnumerableMemoryStorage(), durable: false };
}

const { storage: baseOutboxStorage, durable: storageIsDurable } = resolveBaseStorage();

interface PersistedSnapshot {
  readonly queuesByThreadKey: Record<string, ReadonlyArray<QueuedWebThreadMessage>>;
  readonly pausedMessageIds: Readonly<Record<MessageId, true>>;
  readonly heldThreadKeys: Readonly<Record<string, true>>;
}

function readPersistedSnapshot(): PersistedSnapshot {
  const messages: QueuedWebThreadMessage[] = [];
  const pausedMessageIds: Record<MessageId, true> = {};
  const heldThreadKeys: Record<string, true> = {};
  for (let index = 0; index < baseOutboxStorage.length; index += 1) {
    const key = baseOutboxStorage.key(index);
    if (key?.startsWith(WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX)) {
      const threadKey = decodeURIComponent(key.slice(WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX.length));
      heldThreadKeys[threadKey] = true;
      continue;
    }
    if (!key?.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX)) {
      continue;
    }
    try {
      const raw = baseOutboxStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      const state = (parsed as { state?: unknown } | null)?.state;
      if (!state) continue;
      const entry = decodePersistedEntry(state);
      const message = normalizeMessage(entry.message);
      messages.push(message);
      if (entry.paused) pausedMessageIds[message.messageId] = true;
    } catch {
      // A corrupt per-message entry must not hide the other queued messages.
    }
  }

  // Read the old full-key snapshot until startup migration removes it.
  try {
    const legacyRaw = baseOutboxStorage.getItem(WEB_THREAD_OUTBOX_STORAGE_KEY);
    if (legacyRaw) {
      const parsed: unknown = JSON.parse(legacyRaw);
      const state = (parsed as { state?: unknown } | null)?.state;
      if (state) {
        for (const queue of Object.values(decodePersistedState(state).queuesByThreadKey)) {
          for (const message of queue) messages.push(normalizeMessage(message));
        }
      }
    }
  } catch {}
  return { queuesByThreadKey: groupMessages(messages), pausedMessageIds, heldThreadKeys };
}

function holdQueuedThreadsOnHydrate(
  snapshot: Pick<PersistedSnapshot, "queuesByThreadKey" | "heldThreadKeys">,
): Record<string, true> {
  const heldThreadKeys = { ...snapshot.heldThreadKeys };
  for (const [threadKey, queue] of Object.entries(snapshot.queuesByThreadKey)) {
    if (queue.length > 0) {
      heldThreadKeys[threadKey] = true;
    }
  }
  return heldThreadKeys;
}

function persistEntry(message: QueuedWebThreadMessage, paused: boolean): boolean {
  try {
    baseOutboxStorage.setItem(
      storageKey(message.messageId),
      JSON.stringify({
        version: WEB_THREAD_OUTBOX_STORAGE_VERSION,
        state: { message, paused },
      }),
    );
    return true;
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not persist queued message.", error);
    return false;
  }
}

function removePersistedEntry(messageId: MessageId): boolean {
  try {
    baseOutboxStorage.removeItem(storageKey(messageId));
    return true;
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not remove queued message.", error);
    return false;
  }
}

function persistThreadHold(threadKey: string, held: boolean): boolean {
  try {
    if (held) {
      baseOutboxStorage.setItem(holdStorageKey(threadKey), "1");
    } else {
      baseOutboxStorage.removeItem(holdStorageKey(threadKey));
    }
    return true;
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not persist queue hold.", error);
    return false;
  }
}

function mergedSnapshot(
  state: Pick<
    WebThreadOutboxState,
    "queuesByThreadKey" | "pausedMessageIds" | "heldThreadKeys" | "serverManagedEnvironmentIds"
  >,
) {
  const persisted = readPersistedSnapshot();
  const persistedMessages = flattenQueues(persisted.queuesByThreadKey).filter(
    (message) => !state.serverManagedEnvironmentIds[message.environmentId],
  );
  const persistedMessageIds = new Set(persistedMessages.map((message) => message.messageId));
  const persistedPausedMessageIds = Object.fromEntries(
    Object.entries(persisted.pausedMessageIds).filter(([messageId]) =>
      persistedMessageIds.has(MessageId.make(messageId)),
    ),
  ) as Record<MessageId, true>;
  const persistedHeldThreadKeys = Object.fromEntries(
    Object.entries(persisted.heldThreadKeys).filter(([threadKey]) => {
      const threadRef = parseScopedThreadKey(threadKey);
      return threadRef === null || !state.serverManagedEnvironmentIds[threadRef.environmentId];
    }),
  );
  const messages = [...flattenQueues(state.queuesByThreadKey), ...persistedMessages];
  return {
    queuesByThreadKey: groupMessages(messages),
    pausedMessageIds: { ...state.pausedMessageIds, ...persistedPausedMessageIds },
    heldThreadKeys: { ...state.heldThreadKeys, ...persistedHeldThreadKeys },
    serverManagedEnvironmentIds: state.serverManagedEnvironmentIds,
  };
}

interface WebThreadOutboxState {
  readonly queuesByThreadKey: Record<string, ReadonlyArray<QueuedWebThreadMessage>>;
  readonly pausedMessageIds: Readonly<Record<MessageId, true>>;
  readonly heldThreadKeys: Readonly<Record<string, true>>;
  readonly serverManagedEnvironmentIds: Readonly<Record<EnvironmentId, true>>;
  readonly enqueue: (message: QueuedWebThreadMessage) => { durable: boolean };
  readonly remove: (message: QueuedWebThreadMessage) => { durable: boolean };
  readonly promoteToSteer: (
    messageId: MessageId,
    requestedAt: string,
  ) => { found: boolean; durable: boolean };
  readonly reorder: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    orderedMessageIds: ReadonlyArray<MessageId>,
  ) => { durable: boolean };
  readonly pause: (messageId: MessageId) => void;
  readonly retry: (messageId: MessageId) => void;
  readonly holdThread: (environmentId: EnvironmentId, threadId: ThreadId) => { changed: boolean };
  readonly releaseThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly replaceEnvironmentSnapshot: (
    environmentId: EnvironmentId,
    snapshot: ThreadQueueSnapshot,
  ) => void;
}

export const useWebThreadOutboxStore = create<WebThreadOutboxState>()((set, get) => ({
  queuesByThreadKey: {},
  pausedMessageIds: {},
  heldThreadKeys: {},
  serverManagedEnvironmentIds: {},
  enqueue: (message) => {
    const snapshot = mergedSnapshot(get());
    const queuesByThreadKey = groupMessages([
      ...flattenQueues(snapshot.queuesByThreadKey).filter(
        (candidate) => candidate.messageId !== message.messageId,
      ),
      message,
    ]);
    const written = persistEntry(message, false);
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[message.messageId];
    set({ queuesByThreadKey, pausedMessageIds });
    return { durable: written && storageIsDurable };
  },
  remove: (message) => {
    const removed = removePersistedEntry(message.messageId);
    const snapshot = mergedSnapshot(get());
    const queuesByThreadKey = groupMessages(
      flattenQueues(snapshot.queuesByThreadKey).filter(
        (candidate) => candidate.messageId !== message.messageId,
      ),
    );
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[message.messageId];
    const heldThreadKeys = { ...snapshot.heldThreadKeys };
    const threadKey = webThreadOutboxKey(message.environmentId, message.threadId);
    if ((queuesByThreadKey[threadKey]?.length ?? 0) === 0) {
      delete heldThreadKeys[threadKey];
      persistThreadHold(threadKey, false);
    }
    set({ queuesByThreadKey, pausedMessageIds, heldThreadKeys });
    return { durable: removed && storageIsDurable };
  },
  promoteToSteer: (messageId, requestedAt) => {
    const snapshot = mergedSnapshot(get());
    const message = flattenQueues(snapshot.queuesByThreadKey).find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message) return { found: false, durable: false };
    const promoted = {
      ...message,
      activeTurnMessageBehavior: "steer" as const,
      steerRequestedAt: requestedAt,
    };
    const written = persistEntry(promoted, false);
    const queuesByThreadKey = groupMessages([
      ...flattenQueues(snapshot.queuesByThreadKey).filter(
        (candidate) => candidate.messageId !== messageId,
      ),
      promoted,
    ]);
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[messageId];
    set({ queuesByThreadKey, pausedMessageIds });
    return { found: true, durable: written && storageIsDurable };
  },
  reorder: (environmentId, threadId, orderedMessageIds) => {
    const snapshot = mergedSnapshot(get());
    const threadKey = webThreadOutboxKey(environmentId, threadId);
    const currentQueue = snapshot.queuesByThreadKey[threadKey] ?? [];
    const messageById = new Map(currentQueue.map((message) => [message.messageId, message]));
    const reordered = orderedMessageIds.flatMap((messageId) => {
      const message = messageById.get(messageId);
      if (!message) return [];
      messageById.delete(messageId);
      return [message];
    });
    reordered.push(...messageById.values());
    const positioned = reordered.map((message, queueOrder) => ({ ...message, queueOrder }));
    let written = true;
    for (const message of positioned) {
      written =
        persistEntry(message, Boolean(snapshot.pausedMessageIds[message.messageId])) && written;
    }
    const queuesByThreadKey = groupMessages([
      ...flattenQueues(snapshot.queuesByThreadKey).filter(
        (message) => webThreadOutboxKey(message.environmentId, message.threadId) !== threadKey,
      ),
      ...positioned,
    ]);
    set({ queuesByThreadKey, pausedMessageIds: snapshot.pausedMessageIds });
    return { durable: written && storageIsDurable };
  },
  pause: (messageId) => {
    const snapshot = mergedSnapshot(get());
    const message = flattenQueues(snapshot.queuesByThreadKey).find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message) return;
    persistEntry(message, true);
    set({
      ...snapshot,
      pausedMessageIds: { ...snapshot.pausedMessageIds, [messageId]: true },
    });
  },
  retry: (messageId) => {
    const snapshot = mergedSnapshot(get());
    const message = flattenQueues(snapshot.queuesByThreadKey).find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message || !snapshot.pausedMessageIds[messageId]) return;
    persistEntry(message, false);
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[messageId];
    set({ queuesByThreadKey: snapshot.queuesByThreadKey, pausedMessageIds });
  },
  holdThread: (environmentId, threadId) => {
    const snapshot = mergedSnapshot(get());
    const threadKey = webThreadOutboxKey(environmentId, threadId);
    if (snapshot.heldThreadKeys[threadKey] || !snapshot.queuesByThreadKey[threadKey]?.length) {
      return { changed: false };
    }
    persistThreadHold(threadKey, true);
    set({ ...snapshot, heldThreadKeys: { ...snapshot.heldThreadKeys, [threadKey]: true } });
    return { changed: true };
  },
  releaseThread: (environmentId, threadId) => {
    const snapshot = mergedSnapshot(get());
    const threadKey = webThreadOutboxKey(environmentId, threadId);
    if (!snapshot.heldThreadKeys[threadKey]) return;
    persistThreadHold(threadKey, false);
    const heldThreadKeys = { ...snapshot.heldThreadKeys };
    delete heldThreadKeys[threadKey];
    set({ ...snapshot, heldThreadKeys });
  },
  replaceEnvironmentSnapshot: (environmentId, snapshot) => {
    const current = get();
    const retainedMessages = flattenQueues(current.queuesByThreadKey).filter(
      (message) => message.environmentId !== environmentId,
    );
    const messages: QueuedWebThreadMessage[] = snapshot.messages.map(
      ({ paused: _paused, composerText, queueOrder, steerRequestedAt, ...message }) => ({
        ...message,
        environmentId,
        ...(composerText === undefined ? {} : { composerText }),
        ...(queueOrder === undefined ? {} : { queueOrder }),
        ...(steerRequestedAt === undefined ? {} : { steerRequestedAt }),
      }),
    );
    const retainedMessageIds = new Set(retainedMessages.map((message) => message.messageId));
    const pausedMessageIds = Object.fromEntries(
      Object.entries(current.pausedMessageIds).filter(([messageId]) =>
        retainedMessageIds.has(MessageId.make(messageId)),
      ),
    ) as Record<MessageId, true>;
    for (const message of snapshot.messages) {
      if (message.paused) pausedMessageIds[message.messageId] = true;
    }
    const heldThreadKeys = Object.fromEntries(
      Object.entries(current.heldThreadKeys).filter(([threadKey]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef === null || threadRef.environmentId !== environmentId;
      }),
    ) as Record<string, true>;
    for (const threadId of snapshot.heldThreadIds) {
      heldThreadKeys[webThreadOutboxKey(environmentId, threadId)] = true;
    }

    const persisted = readPersistedSnapshot();
    for (const message of flattenQueues(persisted.queuesByThreadKey)) {
      if (message.environmentId === environmentId) removePersistedEntry(message.messageId);
    }
    for (const threadKey of Object.keys(persisted.heldThreadKeys)) {
      const threadRef = parseScopedThreadKey(threadKey);
      if (threadRef?.environmentId === environmentId) persistThreadHold(threadKey, false);
    }
    set({
      queuesByThreadKey: groupMessages([...retainedMessages, ...messages]),
      pausedMessageIds,
      heldThreadKeys,
      serverManagedEnvironmentIds: {
        ...current.serverManagedEnvironmentIds,
        [environmentId]: true,
      },
    });
  },
}));

export const EMPTY_WEB_THREAD_OUTBOX_QUEUE: ReadonlyArray<QueuedWebThreadMessage> = [];

{
  const initial = readPersistedSnapshot();
  useWebThreadOutboxStore.setState({
    ...initial,
    heldThreadKeys: holdQueuedThreadsOnHydrate(initial),
  });
  try {
    const legacyMessages = flattenQueues(initial.queuesByThreadKey).filter(
      (message) => baseOutboxStorage.getItem(storageKey(message.messageId)) === null,
    );
    if (legacyMessages.every((message) => persistEntry(message, false))) {
      baseOutboxStorage.removeItem(WEB_THREAD_OUTBOX_STORAGE_KEY);
    }
  } catch {
    // Sandboxed browsers can expose localStorage while rejecting method calls.
  }
}

if (storageIsDurable && typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key !== null &&
      event.key !== WEB_THREAD_OUTBOX_STORAGE_KEY &&
      !event.key.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX) &&
      !event.key.startsWith(WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX)
    ) {
      return;
    }
    useWebThreadOutboxStore.setState((state) => mergedSnapshot(state));
  });
}

const dispatchingMessageIds = new Set<MessageId>();

export function beginWebThreadOutboxDispatch(messageId: MessageId): boolean {
  if (dispatchingMessageIds.has(messageId)) return false;
  dispatchingMessageIds.add(messageId);
  return true;
}

export function finishWebThreadOutboxDispatch(messageId: MessageId): void {
  dispatchingMessageIds.delete(messageId);
}

export function shouldDrainWebThreadOutbox(input: {
  readonly sessionStatus:
    | "error"
    | "idle"
    | "interrupted"
    | "ready"
    | "running"
    | "starting"
    | "stopped"
    | null;
  readonly environmentConnected: boolean;
  readonly paused: boolean;
  readonly held: boolean;
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
}): boolean {
  if (
    !input.environmentConnected ||
    input.paused ||
    (input.held && input.activeTurnMessageBehavior !== "steer") ||
    input.sessionStatus === "starting"
  ) {
    return false;
  }
  return input.sessionStatus !== "running" || input.activeTurnMessageBehavior === "steer";
}

export function shouldQueueWebThreadMessage(input: {
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
  readonly hasQueuedMessages: boolean;
  readonly queueHeld: boolean;
  readonly isSendBusy: boolean;
  readonly isServerThread: boolean;
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly threadStarting: boolean;
}): boolean {
  return (
    input.isServerThread &&
    ((input.hasQueuedMessages && !input.queueHeld) ||
      input.threadStarting ||
      (input.activeTurnMessageBehavior === "queue" &&
        (input.phase === "running" || input.isSendBusy)))
  );
}

function clearStorageForTest(): void {
  const keys: string[] = [];
  for (let index = 0; index < baseOutboxStorage.length; index += 1) {
    const key = baseOutboxStorage.key(index);
    if (
      key === WEB_THREAD_OUTBOX_STORAGE_KEY ||
      key?.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX) ||
      key?.startsWith(WEB_THREAD_OUTBOX_HOLD_STORAGE_PREFIX)
    ) {
      keys.push(key);
    }
  }
  for (const key of keys) baseOutboxStorage.removeItem(key);
}

export function writeWebThreadOutboxStorageForTest(raw: string): void {
  clearStorageForTest();
  if (raw) baseOutboxStorage.setItem(WEB_THREAD_OUTBOX_STORAGE_KEY, raw);
  const persisted = readPersistedSnapshot();
  useWebThreadOutboxStore.setState({
    ...persisted,
    heldThreadKeys: holdQueuedThreadsOnHydrate(persisted),
    serverManagedEnvironmentIds: {},
  });
  dispatchingMessageIds.clear();
}

export function writeWebThreadOutboxEntryForTest(
  message: QueuedWebThreadMessage,
  options?: { readonly paused?: boolean; readonly syncStore?: boolean },
): void {
  persistEntry(message, options?.paused ?? false);
  if (options?.syncStore !== false) {
    useWebThreadOutboxStore.setState({
      ...readPersistedSnapshot(),
      serverManagedEnvironmentIds: {},
    });
  }
}
