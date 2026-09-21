import { ArrowUpIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo, useId } from "react";

import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const QueuedComposerMessages = memo(function QueuedComposerMessages({
  messages,
  autoSendNext,
  canSendNow,
  sendNowShortcutLabel,
  onAutoSendNextChange,
  onSendNow,
  onEdit,
  onRemove,
}: {
  readonly messages: ReadonlyArray<QueuedComposerMessage>;
  readonly autoSendNext: boolean;
  readonly canSendNow: boolean;
  readonly sendNowShortcutLabel: string | null;
  readonly onAutoSendNextChange: (enabled: boolean) => void;
  readonly onSendNow: (id: string) => void;
  readonly onEdit: (id: string) => void;
  readonly onRemove: (id: string) => void;
}) {
  const switchId = useId();
  if (messages.length === 0) return null;

  return (
    <div className="mx-auto mb-2 max-h-[30dvh] w-full max-w-3xl overflow-y-auto px-1">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-secondary-label text-xs">{messages.length} queued</span>
        <label
          htmlFor={switchId}
          className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground"
        >
          Auto-send next
          <Switch
            id={switchId}
            checked={autoSendNext}
            className="[--thumb-size:--spacing(3.5)]"
            aria-label="Auto-send next queued message"
            onCheckedChange={(checked) => onAutoSendNextChange(checked === true)}
          />
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        {messages.map((message, index) => {
          const text = message.prompt.trim();
          const attachmentCount = message.images.length + message.files.length;
          const contextCount =
            message.terminalContexts.length +
            message.previewAnnotations.length +
            message.reviewComments.length;
          const needsReattach = message.files.some(
            (file) => file.file === null && file.uploadedAttachmentId === undefined,
          );
          const detail = [
            attachmentCount > 0
              ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
              : null,
            contextCount > 0
              ? `${contextCount} context item${contextCount === 1 ? "" : "s"}`
              : null,
            needsReattach ? "file needs reattach" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <div
              key={message.id}
              className="group flex min-h-10 items-center gap-2 rounded-xl border border-border/60 bg-card/95 py-1.5 pr-1.5 pl-3 shadow-sm backdrop-blur"
              data-chat-queued-message={message.id}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground/90">
                  {text || detail || "Queued message"}
                </div>
                {text && detail ? (
                  <div className="truncate text-secondary-label text-xs">{detail}</div>
                ) : null}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={!canSendNow}
                      aria-label="Send queued message now"
                      onClick={() => onSendNow(message.id)}
                    />
                  }
                >
                  <ArrowUpIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  Send now{index === 0 && sendNowShortcutLabel ? ` (${sendNowShortcutLabel})` : ""}
                </TooltipPopup>
              </Tooltip>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Edit queued message"
                title="Edit queued message"
                onClick={() => onEdit(message.id)}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove queued message"
                title="Remove queued message"
                onClick={() => onRemove(message.id)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
