import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, MessageId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  UploadChatAttachment,
} from "./orchestration.ts";
import { ActiveTurnMessageBehavior } from "./settings.ts";

export const THREAD_QUEUE_WS_METHODS = {
  upsert: "threadQueue.upsert",
  remove: "threadQueue.remove",
  reorder: "threadQueue.reorder",
  promote: "threadQueue.promote",
  pause: "threadQueue.pause",
  hold: "threadQueue.hold",
  subscribe: "threadQueue.subscribe",
} as const;

export const SharedQueuedThreadMessage = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  composerText: Schema.optional(Schema.String),
  attachments: Schema.Array(UploadChatAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  activeTurnMessageBehavior: ActiveTurnMessageBehavior,
  steerRequestedAt: Schema.optional(IsoDateTime),
  queueOrder: Schema.optional(NonNegativeInt),
  paused: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type SharedQueuedThreadMessage = typeof SharedQueuedThreadMessage.Type;

export const ThreadQueueSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  messages: Schema.Array(SharedQueuedThreadMessage),
  heldThreadIds: Schema.Array(ThreadId),
});
export type ThreadQueueSnapshot = typeof ThreadQueueSnapshot.Type;

export const ThreadQueueUpsertInput = Schema.Struct({ message: SharedQueuedThreadMessage });
export const ThreadQueueRemoveInput = Schema.Struct({ messageId: MessageId });
export const ThreadQueueReorderInput = Schema.Struct({
  threadId: ThreadId,
  orderedMessageIds: Schema.Array(MessageId),
});
export const ThreadQueuePromoteInput = Schema.Struct({
  messageId: MessageId,
  requestedAt: IsoDateTime,
});
export const ThreadQueuePauseInput = Schema.Struct({
  messageId: MessageId,
  paused: Schema.Boolean,
});
export const ThreadQueueHoldInput = Schema.Struct({
  threadId: ThreadId,
  held: Schema.Boolean,
});

export class ThreadQueueError extends Schema.TaggedErrorClass<ThreadQueueError>()(
  "ThreadQueueError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
