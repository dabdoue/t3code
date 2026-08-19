import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MessageId } from "@t3tools/contracts";
import {
  CornerDownRightIcon,
  EllipsisIcon,
  GripVerticalIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useId } from "react";

import type { QueuedWebThreadMessage } from "../../webThreadOutbox";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";

export const QueuedWebThreadMessages = memo(function QueuedWebThreadMessages({
  messages,
  pausedMessageIds,
  canSteer,
  autoSendNext,
  onAutoSendNextChange,
  onSteer,
  onRemove,
  onRetry,
  onEdit,
  onReorder,
}: {
  readonly messages: ReadonlyArray<QueuedWebThreadMessage>;
  readonly pausedMessageIds: Readonly<Record<MessageId, true>>;
  readonly canSteer: boolean;
  readonly autoSendNext: boolean;
  readonly onAutoSendNextChange: (enabled: boolean) => void;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onRemove: (messageId: MessageId) => void;
  readonly onRetry: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId) => void;
  readonly onReorder: (orderedMessageIds: ReadonlyArray<MessageId>) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const autoSendSwitchId = useId();

  if (messages.length === 0) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const messageIds = messages.map((message) => message.messageId);
    const fromIndex = messageIds.indexOf(event.active.id as MessageId);
    const toIndex = messageIds.indexOf(event.over.id as MessageId);
    if (fromIndex === -1 || toIndex === -1) return;
    onReorder(arrayMove(messageIds, fromIndex, toIndex));
  };

  return (
    <div className="mx-auto mb-2 max-h-[30dvh] max-w-3xl overflow-y-auto px-1">
      <div className="mb-1.5 flex items-center justify-end px-1">
        <label
          htmlFor={autoSendSwitchId}
          className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground"
          title="When on, the next queued message sends as soon as this thread finishes. Stopping the thread or restarting the app leaves this off."
        >
          Auto-send next
          <Switch
            id={autoSendSwitchId}
            checked={autoSendNext}
            className="[--thumb-size:--spacing(3.5)]"
            aria-label="Auto-send next queued message"
            onCheckedChange={(checked) => onAutoSendNextChange(checked === true)}
          />
        </label>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={messages.map((message) => message.messageId)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-1.5">
            {messages.map((message) => (
              <SortableQueuedMessageRow
                key={message.messageId}
                message={message}
                paused={Boolean(pausedMessageIds[message.messageId])}
                canSteer={canSteer}
                onEdit={onEdit}
                onSteer={onSteer}
                onRemove={onRemove}
                onRetry={onRetry}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
});

function SortableQueuedMessageRow({
  message,
  paused,
  canSteer,
  onEdit,
  onSteer,
  onRemove,
  onRetry,
}: {
  readonly message: QueuedWebThreadMessage;
  readonly paused: boolean;
  readonly canSteer: boolean;
  readonly onEdit: (messageId: MessageId) => void;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onRemove: (messageId: MessageId) => void;
  readonly onRetry: (messageId: MessageId) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: message.messageId });
  const style = { transform: CSS.Translate.toString(transform), transition };
  const displayText = message.composerText ?? message.text;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-1.5 rounded-xl border border-border/60 bg-card/95 py-1.5 pr-1.5 pl-1.5 shadow-sm backdrop-blur ${isDragging ? "z-20 opacity-80 shadow-lg" : ""}`}
      data-chat-queued-message={message.messageId}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label="Reorder queued message"
        title="Drag to reorder"
        className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/60 opacity-30 outline-none transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>

      <>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90" title={displayText}>
          {displayText.length > 0
            ? displayText
            : `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`}
        </span>
        {paused ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label="Retry queued message"
            title="Retry queued message"
            onClick={() => onRetry(message.messageId)}
          >
            <RotateCcwIcon className="size-3.5" />
            Retry
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={!canSteer}
          aria-label="Steer queued message into the active turn"
          title={canSteer ? "Send this queued message now" : "Steer is unavailable right now"}
          onClick={() => onSteer(message.messageId)}
        >
          <CornerDownRightIcon className="size-3.5" />
          Steer
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Remove queued message"
          title="Remove queued message"
          onClick={() => onRemove(message.messageId)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                aria-label="Queued message actions"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onEdit(message.messageId)}>
              <PencilIcon className="size-3.5" />
              Edit message
            </MenuItem>
          </MenuPopup>
        </Menu>
      </>
    </div>
  );
}
