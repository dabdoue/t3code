import type { ThreadMessageEditResolution } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranchIcon, MessageCircleIcon, Undo2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

/** Which conversation-fork capability the thread's provider advertised. */
export type ProviderForkMode = "turn-granular" | "full-copy" | "none";

type ResolutionKind = ThreadMessageEditResolution["kind"];
type ContinueContextMode = "reset" | "correction";

interface EditMessageDialogProps {
  open: boolean;
  originalText: string;
  /** The provider's sessionFork capability; gates the Fork option. */
  providerForkMode: ProviderForkMode;
  /** True while the thread's turn is in progress: only Fork stays available. */
  turnInProgress: boolean;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { text: string; resolution: ThreadMessageEditResolution }) => void;
}

interface ResolutionOption {
  kind: ResolutionKind;
  label: string;
  description: string;
  confirmLabel: string;
  icon: typeof GitBranchIcon;
}

const RESOLUTION_OPTIONS: ReadonlyArray<ResolutionOption> = [
  {
    kind: "fork",
    label: "Fork as new thread",
    description:
      "Creates a duplicate thread at this message with its own worktree. The edited message is sent there; this thread keeps everything.",
    confirmLabel: "Fork and send",
    icon: GitBranchIcon,
  },
  {
    kind: "rewind",
    label: "Rewind this thread",
    description:
      "Restores files to this message's checkpoint and discards newer turns here first — the discarded tail is preserved as a settled archive thread. Then sends the edited message.",
    confirmLabel: "Rewind and send",
    icon: Undo2Icon,
  },
  {
    kind: "continue",
    label: "Edit and continue",
    description: "Keeps all work on disk exactly as it is and tells the agent about the edit.",
    confirmLabel: "Send edit",
    icon: MessageCircleIcon,
  },
];

const CONTINUE_MODE_DESCRIPTIONS: Record<ContinueContextMode, string> = {
  reset: "Reset the agent's context back to this message, then send the edit there.",
  correction:
    "Keep the agent's full context and send the edit as a correction for it to apply on top of the work already done.",
};

export function EditMessageDialog({
  open,
  originalText,
  providerForkMode,
  turnInProgress,
  isSubmitting,
  onOpenChange,
  onSubmit,
}: EditMessageDialogProps) {
  const [text, setText] = useState(originalText);
  const [resolutionKind, setResolutionKind] = useState<ResolutionKind>("fork");
  const [continueContextMode, setContinueContextMode] = useState<ContinueContextMode>("correction");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed the draft each time the dialog opens for a (possibly different)
  // message; keep the last resolution choice across opens — it's usually the
  // same workflow being repeated.
  useEffect(() => {
    if (open) {
      setText(originalText);
    }
  }, [open, originalText]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const forkDisabled = providerForkMode === "none";
  const optionDisabled = useCallback(
    (kind: ResolutionKind) => {
      if (kind === "fork") {
        return forkDisabled;
      }
      if (kind === "rewind" && providerForkMode !== "turn-granular") {
        return true;
      }
      // Rewind and continue both mutate this thread's live state; the agent
      // must finish (or be interrupted) first. Forking is read-only on the
      // source thread, so it stays available mid-turn.
      return turnInProgress;
    },
    [forkDisabled, providerForkMode, turnInProgress],
  );

  // A disabled selection can only come from state changing underneath the
  // dialog (turn completing, provider status loading); fall back to fork when
  // possible, otherwise clear the selection.
  useEffect(() => {
    if (open && optionDisabled(resolutionKind)) {
      setResolutionKind(optionDisabled("fork") ? "continue" : "fork");
    }
  }, [open, optionDisabled, resolutionKind]);

  useEffect(() => {
    if (providerForkMode !== "turn-granular" && continueContextMode === "reset") {
      setContinueContextMode("correction");
    }
  }, [continueContextMode, providerForkMode]);

  const trimmedText = text.trim();
  const canSubmit = !isSubmitting && trimmedText.length > 0 && !optionDisabled(resolutionKind);

  const handleConfirm = useCallback(() => {
    if (!canSubmit) return;
    const resolution: ThreadMessageEditResolution =
      resolutionKind === "continue"
        ? { kind: "continue", contextMode: continueContextMode }
        : { kind: resolutionKind };
    onSubmit({ text: trimmedText, resolution });
  }, [canSubmit, continueContextMode, onSubmit, resolutionKind, trimmedText]);

  const confirmLabel = RESOLUTION_OPTIONS.find(
    (option) => option.kind === resolutionKind,
  )?.confirmLabel;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit message</DialogTitle>
          <DialogDescription>
            Choose what happens to the work the agent already did after this message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Edited message</span>
            <Textarea
              ref={textareaRef}
              value={text}
              rows={5}
              className="min-h-24 font-mono text-[13px]"
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  handleConfirm();
                }
              }}
            />
          </label>

          <div className="grid gap-2" role="radiogroup" aria-label="Edit resolution">
            {RESOLUTION_OPTIONS.map((option) => {
              const disabled = optionDisabled(option.kind);
              const selected = resolutionKind === option.kind;
              const Icon = option.icon;
              return (
                <div key={option.kind} className="grid gap-1.5">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => {
                      setResolutionKind(option.kind);
                    }}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none ring-1 transition-colors",
                      "ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring dark:ring-white/5 dark:hover:bg-white/5",
                      selected &&
                        "bg-primary/8 ring-2 ring-primary hover:bg-primary/8 dark:bg-primary/15 dark:ring-primary dark:hover:bg-primary/15",
                      disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                      {option.kind === "fork" && providerForkMode === "full-copy" ? (
                        <span className="mt-1 block text-[11px] text-muted-foreground/80">
                          This provider copies the full conversation into the fork and receives the
                          edit as a correction.
                        </span>
                      ) : null}
                      {disabled ? (
                        <span className="mt-1 block text-[11px] text-muted-foreground/80">
                          {option.kind === "fork"
                            ? "This provider does not support forking conversations."
                            : option.kind === "rewind" && providerForkMode !== "turn-granular"
                              ? "This provider cannot reset its conversation at an earlier turn."
                              : "Available when the current turn completes."}
                        </span>
                      ) : null}
                    </span>
                  </button>

                  {option.kind === "continue" && selected && !turnInProgress ? (
                    <div className="ms-7 grid gap-1.5">
                      {(["reset", "correction"] as const).map((mode) => (
                        <label
                          key={mode}
                          className={cn(
                            "flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                            mode === "reset" && providerForkMode !== "turn-granular"
                              ? "cursor-not-allowed opacity-55"
                              : "cursor-pointer hover:bg-accent/40",
                          )}
                        >
                          <input
                            type="radio"
                            name="edit-continue-context-mode"
                            checked={continueContextMode === mode}
                            disabled={mode === "reset" && providerForkMode !== "turn-granular"}
                            onChange={() => {
                              setContinueContextMode(mode);
                            }}
                            className="mt-0.5 accent-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium text-foreground">
                              {mode === "reset" ? "Reset context" : "Send as correction"}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                              {CONTINUE_MODE_DESCRIPTIONS[mode]}
                            </span>
                            {mode === "reset" && providerForkMode !== "turn-granular" ? (
                              <span className="mt-1 block text-[11px] text-muted-foreground/80">
                                This provider cannot resume from an earlier turn; send a correction
                                instead.
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={handleConfirm}>
            {isSubmitting ? <Spinner className="size-3.5" /> : null}
            {confirmLabel ?? "Send edit"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
