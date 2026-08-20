/**
 * MessageEditReactor - executes message-edit resolutions.
 *
 * Reacts to `thread.message-edit-requested` domain events and carries out the
 * chosen resolution:
 *
 * - fork: create a fork thread from the edit point (transcript prefix, provider
 *   conversation sliced at the last completed turn, git worktree at the
 *   edit-point checkpoint) and auto-send the edited message there.
 * - rewind: archive the about-to-be-discarded tail as a settled fork thread,
 *   then reuse the existing checkpoint-revert pipeline; the edited message is
 *   auto-sent once the revert lands (`thread.reverted`).
 * - continue: keep everything on disk and either reset the provider context to
 *   the edit point (rollback only) or deliver the edit as a correction.
 *
 * File state comes exclusively from the checkpoint system; provider context
 * comes exclusively from provider-native fork/rollback primitives — this
 * reactor orchestrates, it never rewrites context itself.
 *
 * @module MessageEditReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type IsoDateTime,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  VcsDriverKind,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";

import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  MessageEditReactor,
  type MessageEditReactorShape,
} from "../Services/MessageEditReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * The auto-send that follows a rewind, held between dispatching the
 * checkpoint revert and observing its `thread.reverted` completion. Keyed by
 * thread; one pending edit per thread (a second edit while one is rewinding
 * is impossible — the decider blocks edits while a revert is in flight and
 * the session is busy).
 */
interface PendingRewindSend {
  readonly requestEventId: EventId;
  readonly text: string;
  readonly attachments: NonNullable<OrchestrationThread["messages"][number]["attachments"]>;
  readonly turnCount: number;
}

/**
 * Prefix that frames an auto-sent edited message when the provider's context
 * still contains the original version of the message — either because the
 * provider can only full-copy (ACP `session/fork`) or because the user chose
 * "send as correction" and nothing was rolled back.
 */
function frameEditedMessage(text: string): string {
  return [
    "[Edited message] The user edited an earlier message in this conversation.",
    "The message below replaces that earlier version — treat it as the operative instruction.",
    "",
    text,
  ].join("\n");
}

/**
 * The turn a sent user message kicked off. Providers stamp turn ids onto
 * assistant messages only — every user message carries `turnId: null` — so the
 * turn is the one the next assistant message in the transcript belongs to.
 * Null when the message has no assistant reply yet (its turn is still running,
 * or was interrupted before producing one), which leaves the edit with no
 * checkpoint to work from.
 */
function resolveTurnIdForUserMessage(
  messages: OrchestrationThread["messages"],
  messageIndex: number,
): TurnId | null {
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    // A later user message means this one's turn never produced a reply.
    if (message.role === "user") {
      return null;
    }
    if (message.turnId !== null && message.turnId !== undefined) {
      return message.turnId;
    }
  }
  return null;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const editCommandId = (requestEventId: EventId, step: string) =>
    CommandId.make(`server:message-edit:${requestEventId}:${step}`);
  const editEventId = (requestEventId: EventId, step: string) =>
    EventId.make(`message-edit:${requestEventId}:${step}`);
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pendingRewindSends = yield* Ref.make(new Map<ThreadId, PendingRewindSend>());
  const completedEditRequests = yield* Ref.make(new Set<EventId>());
  const seenDomainEvents = yield* Ref.make(new Set<EventId>());

  const appendEditFailureActivity = (input: {
    readonly requestEventId: EventId;
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: IsoDateTime;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: editCommandId(input.requestEventId, "failure-activity"),
        threadId: input.threadId,
        activity: {
          id: editEventId(input.requestEventId, "failure-activity"),
          tone: "error",
          kind: "thread.edit.failed",
          summary: "Message edit failed",
          payload: {
            detail: input.detail,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("failed to append message-edit failure activity", {
            threadId: input.threadId,
            detail: input.detail,
            cause: Cause.pretty(cause),
          });
        }),
        Effect.asVoid,
      );

  const completeEditRequest = (input: {
    readonly requestEventId: EventId;
    readonly threadId: ThreadId;
    readonly outcome: "succeeded" | "failed";
    readonly createdAt: IsoDateTime;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.message.edit.complete",
      commandId: editCommandId(input.requestEventId, "complete"),
      threadId: input.threadId,
      requestEventId: input.requestEventId,
      outcome: input.outcome,
      createdAt: input.createdAt,
    });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace cwd the edit operates on, preferring the active
  // provider session's cwd (the agent's actual working directory) over the
  // thread/project config. Unlike the checkpoint reactor's resolver this does
  // NOT require a git repository — non-git projects still fork conversations.
  const resolveWorkspaceCwd = Effect.fn("resolveWorkspaceCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  }): Effect.fn.Return<string | undefined> {
    const sessions = yield* providerService.listSessions();
    const sessionCwd = sessions.find((entry) => entry.threadId === input.threadId)?.cwd;
    return (
      sessionCwd ?? resolveThreadWorkspaceCwd({ thread: input.thread, projects: input.projects })
    );
  });

  // The provider fork granularity of the thread's bound provider. "none" when
  // no session is bound or the capability cannot be resolved — the fork flow
  // treats that as "no correction framing needed" since no provider-side copy
  // of the original turn exists.
  const resolveProviderForkMode = Effect.fn("resolveProviderForkMode")(function* (
    thread: OrchestrationThread,
  ): Effect.fn.Return<"turn-granular" | "full-copy" | "none"> {
    const instanceId = thread.session?.providerInstanceId;
    if (!instanceId) {
      return "none";
    }
    return yield* providerService.getCapabilities(instanceId).pipe(
      Effect.map((capabilities) => capabilities.sessionFork),
      Effect.orElseSucceed(() => "none" as const),
    );
  });

  const removePreparedWorktree = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly refName: string;
  }) =>
    gitWorkflow.removeWorktree({ cwd: input.cwd, path: input.path, force: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to remove partially prepared message-edit worktree", {
          cwd: input.cwd,
          worktreePath: input.path,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.andThen(
        gitWorkflow.deleteRef({ cwd: input.cwd, refName: input.refName }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to delete partially prepared message-edit branch", {
              cwd: input.cwd,
              refName: input.refName,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.asVoid,
    );

  /**
   * Create a normal ancestry-preserving branch and materialize a checkpoint's
   * tree into it. Checkpoint commits are storage objects, not branch points:
   * branching directly from one would expose a synthetic checkpoint commit
   * (or, for legacy checkpoints, an unrelated root history).
   */
  const prepareCheckpointWorktree = Effect.fn("prepareCheckpointWorktree")(function* (input: {
    readonly sourceCwd: string;
    readonly checkpointRef: ReturnType<typeof checkpointRefForThreadTurn>;
    readonly threadId: ThreadId;
  }) {
    const branch = `${WORKTREE_BRANCH_PREFIX}/${input.threadId}`;
    const recordedBaseCommit = yield* checkpointStore.resolveCheckpointBaseCommit({
      cwd: input.sourceCwd,
      checkpointRef: input.checkpointRef,
    });
    // Pre-feature checkpoints were parentless. HEAD is the only safe
    // ancestry-preserving fallback; the checkpoint tree is still restored
    // exactly, but its files appear as a working-tree delta from today's HEAD.
    const existingRefs = yield* gitWorkflow.listRefs({
      cwd: input.sourceCwd,
      query: branch,
      refKind: "local",
      refresh: true,
      limit: 10,
    });
    const existingBranch = existingRefs.refs.find((ref) => ref.name === branch);
    if (existingBranch && existingBranch.worktreePath === null) {
      // A crash can land after `git branch` succeeds but before the worktree
      // path is recorded. This branch name is request-derived and therefore
      // owned by this edit, so remove the incomplete ref before retrying.
      yield* gitWorkflow.deleteRef({ cwd: input.sourceCwd, refName: branch });
    }
    const worktreePath =
      existingBranch?.worktreePath ??
      (yield* gitWorkflow.createWorktree({
        cwd: input.sourceCwd,
        refName: recordedBaseCommit ?? "HEAD",
        newRefName: branch,
        path: null,
      })).worktree.path;
    const restored = yield* checkpointStore
      .restoreCheckpoint({
        cwd: worktreePath,
        checkpointRef: input.checkpointRef,
      })
      .pipe(
        Effect.onError(() =>
          removePreparedWorktree({
            cwd: input.sourceCwd,
            path: worktreePath,
            refName: branch,
          }),
        ),
      );
    if (!restored) {
      yield* removePreparedWorktree({
        cwd: input.sourceCwd,
        path: worktreePath,
        refName: branch,
      });
      return yield* new VcsUnsupportedOperationError({
        operation: "MessageEditReactor.prepareCheckpointWorktree",
        kind: VcsDriverKind.make("git"),
        detail: `Checkpoint '${input.checkpointRef}' disappeared while preparing the worktree.`,
      });
    }
    return {
      branch,
      worktreePath,
      usedLegacyBaseFallback: recordedBaseCommit === null,
    };
  });

  const compensateCreatedThread = (input: {
    readonly requestEventId: EventId;
    readonly step: string;
    readonly threadId: ThreadId;
    readonly sourceCwd: string | undefined;
    readonly worktreePath: string | null;
    readonly createdAt: IsoDateTime;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.delete",
        commandId: editCommandId(input.requestEventId, `${input.step}-compensate-delete`),
        threadId: input.threadId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to delete partially created message-edit thread", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(
          input.sourceCwd !== undefined && input.worktreePath !== null
            ? removePreparedWorktree({
                cwd: input.sourceCwd,
                path: input.worktreePath,
                refName: `${WORKTREE_BRANCH_PREFIX}/${input.threadId}`,
              })
            : Effect.void,
        ),
        Effect.asVoid,
      );

  const copyThreadCheckpoints = Effect.fn("copyThreadCheckpoints")(function* (input: {
    readonly requestEventId: EventId;
    readonly step: string;
    readonly sourceThread: OrchestrationThread;
    readonly targetThreadId: ThreadId;
    readonly cwd: string;
    readonly throughTurnCount: number;
    readonly createdAt: IsoDateTime;
  }) {
    const refsToCopy = [
      {
        from: checkpointRefForThreadTurn(input.sourceThread.id, 0),
        to: checkpointRefForThreadTurn(input.targetThreadId, 0),
      },
      ...input.sourceThread.checkpoints
        .filter((checkpoint) => checkpoint.checkpointTurnCount <= input.throughTurnCount)
        .map((checkpoint) => ({
          from: checkpoint.checkpointRef,
          to: checkpointRefForThreadTurn(input.targetThreadId, checkpoint.checkpointTurnCount),
          checkpoint,
        })),
    ];

    for (const entry of refsToCopy) {
      const copied = yield* checkpointStore.copyCheckpointRef({
        cwd: input.cwd,
        fromCheckpointRef: entry.from,
        toCheckpointRef: entry.to,
      });
      if (!copied) {
        return yield* new VcsUnsupportedOperationError({
          operation: "MessageEditReactor.copyThreadCheckpoints",
          kind: VcsDriverKind.make("git"),
          detail: `Source checkpoint '${entry.from}' is unavailable.`,
        });
      }
      if ("checkpoint" in entry) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: editCommandId(
            input.requestEventId,
            `${input.step}-checkpoint-${entry.checkpoint.checkpointTurnCount}`,
          ),
          threadId: input.targetThreadId,
          turnId: entry.checkpoint.turnId,
          completedAt: entry.checkpoint.completedAt,
          checkpointRef: entry.to,
          status: entry.checkpoint.status,
          files: [...entry.checkpoint.files],
          checkpointTurnCount: entry.checkpoint.checkpointTurnCount,
          createdAt: input.createdAt,
        });
      }
    }
  });

  const dispatchEditedTurnStart = Effect.fn("dispatchEditedTurnStart")(function* (input: {
    readonly requestEventId: EventId;
    readonly step: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly modelSelection: ModelSelection | undefined;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly framing: "plain" | "correction";
    readonly attachments: NonNullable<OrchestrationThread["messages"][number]["attachments"]>;
    readonly createdAt: IsoDateTime;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: editCommandId(input.requestEventId, `${input.step}-turn-start`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`message-edit:${input.requestEventId}:${input.step}`),
        role: "user",
        text: input.framing === "correction" ? frameEditedMessage(input.text) : input.text,
        attachments: [...input.attachments],
      },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    });
  });

  interface EditContext {
    readonly requestEventId: EventId;
    readonly thread: OrchestrationThread;
    readonly messageIndex: number;
    readonly text: string;
    readonly attachments: NonNullable<OrchestrationThread["messages"][number]["attachments"]>;
    /** Last completed provider turn before the edited message. */
    readonly contextBoundaryTurnId: TurnId | undefined;
    /** Checkpoint turn count of the edited message's turn; undefined when the turn has no checkpoint. */
    readonly editTurnCount: number | undefined;
    /** Highest checkpoint turn count on the thread (0 when checkpointless). */
    readonly currentTurnCount: number;
    readonly now: IsoDateTime;
  }

  const runForkResolution = Effect.fn("runForkResolution")(function* (edit: EditContext) {
    const { thread, messageIndex, text, now } = edit;
    const forkedThreadId = ThreadId.make(`message-edit-${edit.requestEventId}-fork`);

    // Fork point = the message before the edited one; null when the edit
    // targets the thread's first message (fork starts from an empty
    // transcript). The decider copies the transcript up to and including the
    // fork point.
    const forkPointMessage = messageIndex > 0 ? thread.messages[messageIndex - 1] : undefined;
    const forkPointMessageId = forkPointMessage ? forkPointMessage.id : null;

    // Provider slice boundary: the last turn that ends inside the copied
    // prefix (necessarily completed — an in-progress turn can only be the
    // edited message's own turn or later). Null when the prefix holds no
    // turns: the fork then gets no provider binding and its first turn start
    // creates a fresh provider session.
    const upToTurnId = edit.contextBoundaryTurnId ?? null;

    const projects = yield* resolveThreadProjects(thread.projectId);
    const workspaceCwd = yield* resolveWorkspaceCwd({
      threadId: thread.id,
      thread,
      projects,
    });

    // Git projects get a dedicated worktree created AT the edit-point
    // checkpoint so the fork starts from the exact file state the edited
    // message saw, leaving the source workspace untouched. Non-git projects
    // share the source workspace.
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;
    let usedLegacyBaseFallback = false;
    let forkCheckpointTurnCount: number | null = null;
    if (workspaceCwd !== undefined && isGitRepository(workspaceCwd)) {
      // The edit-point files are the pre-turn baseline of the edited turn
      // (= the post-turn checkpoint of the turn before it).
      const baselineTurnCount =
        edit.editTurnCount !== undefined ? edit.editTurnCount - 1 : edit.currentTurnCount;
      forkCheckpointTurnCount = baselineTurnCount;
      const baseCheckpointRef = checkpointRefForThreadTurn(thread.id, baselineTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: workspaceCwd,
        checkpointRef: baseCheckpointRef,
      });
      if (!baselineExists) {
        yield* appendEditFailureActivity({
          requestEventId: edit.requestEventId,
          threadId: thread.id,
          detail: `The edit-point checkpoint for turn ${baselineTurnCount} is unavailable, so no fork was created.`,
          createdAt: now,
        });
        return false;
      }

      const prepared = yield* prepareCheckpointWorktree({
        sourceCwd: workspaceCwd,
        checkpointRef: baseCheckpointRef,
        threadId: forkedThreadId,
      });
      worktreePath = prepared.worktreePath;
      worktreeBranch = prepared.branch;
      usedLegacyBaseFallback = prepared.usedLegacyBaseFallback;
    }

    const forkMode = yield* resolveProviderForkMode(thread);
    if (upToTurnId !== null && forkMode === "none") {
      if (workspaceCwd !== undefined && worktreePath !== null) {
        yield* removePreparedWorktree({
          cwd: workspaceCwd,
          path: worktreePath,
          refName: worktreeBranch ?? `${WORKTREE_BRANCH_PREFIX}/${forkedThreadId}`,
        });
      }
      yield* appendEditFailureActivity({
        requestEventId: edit.requestEventId,
        threadId: thread.id,
        detail: "This provider does not support conversation forks for an existing edit point.",
        createdAt: now,
      });
      return false;
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.fork",
        commandId: editCommandId(edit.requestEventId, "fork-thread"),
        forkedThreadId,
        sourceThreadId: thread.id,
        forkPointMessageId,
        forkKind: "user",
        title: `${thread.title} (fork)`,
        createdAt: now,
      })
      .pipe(
        Effect.onError(() =>
          workspaceCwd !== undefined && worktreePath !== null
            ? removePreparedWorktree({
                cwd: workspaceCwd,
                path: worktreePath,
                refName: worktreeBranch ?? `${WORKTREE_BRANCH_PREFIX}/${forkedThreadId}`,
              })
            : Effect.void,
        ),
      );

    if (worktreePath !== null && worktreeBranch !== null) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: editCommandId(edit.requestEventId, "fork-meta"),
          threadId: forkedThreadId,
          branch: worktreeBranch,
          worktreePath,
        })
        .pipe(
          Effect.onError(() =>
            compensateCreatedThread({
              requestEventId: edit.requestEventId,
              step: "fork",
              threadId: forkedThreadId,
              sourceCwd: workspaceCwd,
              worktreePath,
              createdAt: now,
            }),
          ),
        );
      yield* workspaceEntries.refresh(worktreePath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to refresh workspace entries for fork worktree", {
            threadId: forkedThreadId,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* vcsStatusBroadcaster.refreshLocalStatus(worktreePath).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to refresh git status for fork worktree", {
            threadId: forkedThreadId,
            worktreePath,
            detail: error.message,
          }),
        ),
      );
      yield* copyThreadCheckpoints({
        requestEventId: edit.requestEventId,
        step: "fork",
        sourceThread: thread,
        targetThreadId: forkedThreadId,
        cwd: worktreePath,
        throughTurnCount: forkCheckpointTurnCount ?? 0,
        createdAt: now,
      }).pipe(
        Effect.onError(() =>
          compensateCreatedThread({
            requestEventId: edit.requestEventId,
            step: "fork",
            threadId: forkedThreadId,
            sourceCwd: workspaceCwd,
            worktreePath,
            createdAt: now,
          }),
        ),
      );
    }

    // Provider fork: slice at the resolved turn when the provider supports
    // it; full-copy providers keep everything (the auto-send below then
    // carries correction framing). Skipped entirely for empty prefixes.
    let providerForked = false;
    if (upToTurnId !== null) {
      const forkCwd = worktreePath ?? workspaceCwd;
      yield* providerService
        .forkConversation({
          threadId: thread.id,
          forkedThreadId,
          upToTurnId,
          ...(forkCwd !== undefined ? { cwd: forkCwd } : {}),
        })
        .pipe(
          Effect.onError(() =>
            compensateCreatedThread({
              requestEventId: edit.requestEventId,
              step: "fork",
              threadId: forkedThreadId,
              sourceCwd: workspaceCwd,
              worktreePath,
              createdAt: now,
            }),
          ),
        );
      providerForked = true;
    }

    // Auto-send the edited message as the fork's first new turn. Framing is
    // only needed when the provider's context still holds the original
    // version of the edited message (full-copy forks).
    yield* dispatchEditedTurnStart({
      requestEventId: edit.requestEventId,
      step: "fork",
      threadId: forkedThreadId,
      text,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      framing: providerForked && forkMode === "full-copy" ? "correction" : "plain",
      attachments: edit.attachments,
      createdAt: now,
    }).pipe(
      Effect.onError(() =>
        compensateCreatedThread({
          requestEventId: edit.requestEventId,
          step: "fork",
          threadId: forkedThreadId,
          sourceCwd: workspaceCwd,
          worktreePath,
          createdAt: now,
        }),
      ),
    );

    // Surface the fork on the SOURCE thread. The user stays where they are —
    // this row is how they get to the new thread.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: editCommandId(edit.requestEventId, "fork-activity"),
        threadId: thread.id,
        activity: {
          id: editEventId(edit.requestEventId, "fork-activity"),
          tone: "info",
          kind: "thread.forked",
          summary: "Forked from this message",
          payload: {
            forkThreadId: forkedThreadId,
            usedLegacyBaseFallback,
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fork created but source activity could not be appended", {
            threadId: thread.id,
            forkedThreadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    return true;
  });

  const runRewindResolution = Effect.fn("runRewindResolution")(function* (edit: EditContext) {
    const { thread, text, now } = edit;
    if (edit.editTurnCount === undefined || edit.editTurnCount < 1) {
      yield* appendEditFailureActivity({
        requestEventId: edit.requestEventId,
        threadId: thread.id,
        detail:
          "Cannot rewind: no checkpoint exists for the edited message's turn, so there is no file state to restore.",
        createdAt: now,
      });
      return false;
    }
    const providerForkMode = yield* resolveProviderForkMode(thread);
    if (providerForkMode !== "turn-granular") {
      yield* appendEditFailureActivity({
        requestEventId: edit.requestEventId,
        threadId: thread.id,
        detail:
          "This provider cannot reset its conversation at the edit point, so no archive or rewind was created. Use Fork or Send as correction instead.",
        createdAt: now,
      });
      return false;
    }
    const revertTarget = edit.editTurnCount - 1;

    // 1. Archive the tail BEFORE the rewind destroys it: a full-copy fork
    //    thread that lands settled, preserving transcript and (best effort)
    //    provider context.
    const archiveThreadId = ThreadId.make(`message-edit-${edit.requestEventId}-archive`);
    const existingArchive = yield* resolveThreadDetail(archiveThreadId);
    const lastMessage = thread.messages.at(-1);
    const projects = yield* resolveThreadProjects(thread.projectId);
    const sourceCwd = yield* resolveWorkspaceCwd({ threadId: thread.id, thread, projects });
    let archiveWorktreePath: string | null = existingArchive?.worktreePath ?? null;
    let archiveBranch: string | null = existingArchive?.branch ?? null;
    if (!existingArchive && sourceCwd !== undefined && isGitRepository(sourceCwd)) {
      const archiveCheckpointRef = checkpointRefForThreadTurn(archiveThreadId, 0);
      yield* checkpointStore.captureCheckpoint({
        cwd: sourceCwd,
        checkpointRef: archiveCheckpointRef,
      });
      const preparedArchive = yield* prepareCheckpointWorktree({
        sourceCwd,
        checkpointRef: archiveCheckpointRef,
        threadId: archiveThreadId,
      });
      archiveWorktreePath = preparedArchive.worktreePath;
      archiveBranch = preparedArchive.branch;
    }
    if (!existingArchive) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.fork",
          commandId: editCommandId(edit.requestEventId, "archive-thread"),
          forkedThreadId: archiveThreadId,
          sourceThreadId: thread.id,
          forkPointMessageId: lastMessage ? lastMessage.id : null,
          forkKind: "archive-tail",
          title: `${thread.title} (archived tail)`,
          createdAt: now,
        })
        .pipe(
          Effect.onError(() =>
            sourceCwd !== undefined && archiveWorktreePath !== null
              ? removePreparedWorktree({
                  cwd: sourceCwd,
                  path: archiveWorktreePath,
                  refName: archiveBranch ?? `${WORKTREE_BRANCH_PREFIX}/${archiveThreadId}`,
                })
              : Effect.void,
          ),
        );
    }

    if (!existingArchive && archiveWorktreePath !== null && archiveBranch !== null) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: editCommandId(edit.requestEventId, "archive-meta"),
          threadId: archiveThreadId,
          branch: archiveBranch,
          worktreePath: archiveWorktreePath,
        })
        .pipe(
          Effect.onError(() =>
            compensateCreatedThread({
              requestEventId: edit.requestEventId,
              step: "archive",
              threadId: archiveThreadId,
              sourceCwd,
              worktreePath: archiveWorktreePath,
              createdAt: now,
            }),
          ),
        );
      yield* copyThreadCheckpoints({
        requestEventId: edit.requestEventId,
        step: "archive",
        sourceThread: thread,
        targetThreadId: archiveThreadId,
        cwd: archiveWorktreePath,
        throughTurnCount: edit.currentTurnCount,
        createdAt: now,
      }).pipe(
        Effect.onError(() =>
          compensateCreatedThread({
            requestEventId: edit.requestEventId,
            step: "archive",
            threadId: archiveThreadId,
            sourceCwd,
            worktreePath: archiveWorktreePath,
            createdAt: now,
          }),
        ),
      );
    }

    // 2. Provider full-copy for the archive, sharing the source workspace.
    //    Best effort: the transcript is the source of truth, and a provider
    //    copy failure must not block the rewind the user asked for.
    let providerArchived =
      existingArchive?.session !== null && existingArchive?.session !== undefined;
    if (!existingArchive && thread.messages.some((message) => message.turnId !== null)) {
      yield* providerService
        .forkConversation({
          threadId: thread.id,
          forkedThreadId: archiveThreadId,
          ...(archiveWorktreePath !== null
            ? { cwd: archiveWorktreePath }
            : sourceCwd !== undefined
              ? { cwd: sourceCwd }
              : {}),
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              providerArchived = true;
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              "archive-tail provider fork failed; the archived thread keeps its transcript only",
              {
                threadId: thread.id,
                archiveThreadId,
                detail: error.message,
              },
            ),
          ),
        );
    }

    // 3. Surface the archive on the source thread so the discarded work
    //    stays reachable.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: editCommandId(edit.requestEventId, "archive-activity"),
        threadId: thread.id,
        activity: {
          id: editEventId(edit.requestEventId, "archive-activity"),
          tone: "info",
          kind: "thread.tail-archived",
          summary: "Rewind tail archived",
          payload: {
            archiveThreadId,
            providerArchived,
            fileStatePreserved: archiveWorktreePath !== null,
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("rewind archive created but source activity could not be appended", {
            threadId: thread.id,
            archiveThreadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    // 4. Register the auto-send, then hand off to the checkpoint-revert
    //    pipeline (file restore + provider rollback + transcript
    //    truncation). The send fires when `thread.reverted` lands.
    yield* Ref.update(pendingRewindSends, (pending) => {
      const next = new Map(pending);
      next.set(thread.id, {
        requestEventId: edit.requestEventId,
        text,
        attachments: edit.attachments,
        turnCount: revertTarget,
      });
      return next;
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.checkpoint.revert",
      commandId: editCommandId(edit.requestEventId, "revert"),
      threadId: thread.id,
      turnCount: revertTarget,
      createdAt: now,
    });
    return true;
  });

  const runContinueResolution = Effect.fn("runContinueResolution")(function* (
    edit: EditContext,
    contextMode: "reset" | "correction",
  ) {
    const { thread, text, now } = edit;

    // Reset rolls the provider's context back to the edit point WITHOUT
    // touching files, transcript, or checkpoints — the visible history stays,
    // the agent simply no longer remembers the turns after the edit point.
    if (contextMode === "reset" && edit.editTurnCount !== undefined && edit.editTurnCount >= 1) {
      const numTurns = Math.max(0, edit.currentTurnCount - (edit.editTurnCount - 1));
      if (numTurns > 0) {
        yield* providerService.resetConversation({
          threadId: thread.id,
          ...(edit.contextBoundaryTurnId ? { upToTurnId: edit.contextBoundaryTurnId } : {}),
        });
      }
    }

    yield* dispatchEditedTurnStart({
      requestEventId: edit.requestEventId,
      step: "continue",
      threadId: thread.id,
      text,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      framing: contextMode === "correction" ? "correction" : "plain",
      attachments: edit.attachments,
      createdAt: now,
    });
    return true;
  });

  const handleEditRequested = Effect.fn("handleEditRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.message-edit-requested" }>,
  ) {
    const { threadId, messageId, text, resolution } = event.payload;
    const alreadyCompleted = yield* Ref.get(completedEditRequests);
    if (alreadyCompleted.has(event.eventId)) {
      return;
    }
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("message edit skipped: thread not found", { threadId });
      yield* completeEditRequest({
        requestEventId: event.eventId,
        threadId,
        outcome: "failed",
        createdAt: now,
      });
      return;
    }

    const existingEditedMessageId =
      resolution.kind === "rewind"
        ? MessageId.make(`message-edit:${event.eventId}:rewind`)
        : resolution.kind === "continue"
          ? MessageId.make(`message-edit:${event.eventId}:continue`)
          : undefined;
    if (
      existingEditedMessageId !== undefined &&
      thread.messages.some((entry) => entry.id === existingEditedMessageId)
    ) {
      yield* completeEditRequest({
        requestEventId: event.eventId,
        threadId,
        outcome: "succeeded",
        createdAt: now,
      });
      return;
    }

    if (
      resolution.kind !== "fork" &&
      (thread.session?.status === "starting" || thread.session?.status === "running")
    ) {
      yield* appendEditFailureActivity({
        requestEventId: event.eventId,
        threadId,
        detail:
          "The thread started another turn before this edit could be applied. Wait for it to finish, then retry or fork instead.",
        createdAt: now,
      });
      yield* completeEditRequest({
        requestEventId: event.eventId,
        threadId,
        outcome: "failed",
        createdAt: now,
      });
      return;
    }

    const messageIndex = thread.messages.findIndex((entry) => entry.id === messageId);
    const message = messageIndex === -1 ? undefined : thread.messages[messageIndex];
    const durableMessageIndex = event.payload.messageIndex;
    const canRecoverRewind =
      resolution.kind === "rewind" && durableMessageIndex !== undefined && message === undefined;
    if ((!message || message.role !== "user") && !canRecoverRewind) {
      yield* appendEditFailureActivity({
        requestEventId: event.eventId,
        threadId,
        detail: `Message '${messageId}' was not found on this thread.`,
        createdAt: now,
      });
      yield* completeEditRequest({
        requestEventId: event.eventId,
        threadId,
        outcome: "failed",
        createdAt: now,
      });
      return;
    }

    const effectiveMessageIndex = messageIndex >= 0 ? messageIndex : (durableMessageIndex ?? -1);
    const editTurnId =
      event.payload.editTurnCount !== undefined
        ? null
        : resolveTurnIdForUserMessage(thread.messages, effectiveMessageIndex);
    const editCheckpoint =
      editTurnId !== null
        ? thread.checkpoints.find((checkpoint) => checkpoint.turnId === editTurnId)
        : undefined;
    let contextBoundaryTurnId: TurnId | undefined = event.payload.contextBoundaryTurnId;
    for (
      let index = effectiveMessageIndex - 1;
      contextBoundaryTurnId === undefined && index >= 0;
      index -= 1
    ) {
      const turnId = thread.messages[index]?.turnId;
      if (turnId !== null && turnId !== undefined) {
        contextBoundaryTurnId = turnId;
        break;
      }
    }
    const edit: EditContext = {
      requestEventId: event.eventId,
      thread,
      messageIndex: effectiveMessageIndex,
      text,
      attachments: message?.attachments ?? event.payload.attachments ?? [],
      contextBoundaryTurnId,
      editTurnCount: event.payload.editTurnCount ?? editCheckpoint?.checkpointTurnCount,
      currentTurnCount:
        event.payload.currentTurnCount ??
        thread.checkpoints.reduce(
          (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
          0,
        ),
      now,
    };

    const reportFailure = (error: { readonly message: string }) =>
      Effect.flatMap(nowIso, (createdAt) =>
        appendEditFailureActivity({
          requestEventId: event.eventId,
          threadId,
          detail: error.message,
          createdAt,
        }),
      );

    let succeeded: boolean;
    if (resolution.kind === "fork") {
      succeeded = yield* runForkResolution(edit).pipe(
        Effect.catch((error) => reportFailure(error).pipe(Effect.as(false))),
      );
    } else if (resolution.kind === "rewind") {
      succeeded = yield* runRewindResolution(edit).pipe(
        Effect.catch((error) => reportFailure(error).pipe(Effect.as(false))),
      );
      if (succeeded) {
        // The request completes only after `thread.reverted` lands and the
        // deterministic edited turn has been dispatched.
        return;
      }
    } else {
      succeeded = yield* runContinueResolution(edit, resolution.contextMode).pipe(
        Effect.catch((error) => reportFailure(error).pipe(Effect.as(false))),
      );
    }
    yield* completeEditRequest({
      requestEventId: event.eventId,
      threadId,
      outcome: succeeded ? "succeeded" : "failed",
      createdAt: yield* nowIso,
    });
  });

  const handleReverted = Effect.fn("handleReverted")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.reverted" }>,
  ) {
    const pending = yield* Ref.get(pendingRewindSends);
    const entry = pending.get(event.payload.threadId);
    // Only fire for the revert this edit registered — matching turnCount
    // keeps a user-initiated revert from consuming someone else's edit.
    if (!entry || entry.turnCount !== event.payload.turnCount) {
      return;
    }
    yield* Ref.update(pendingRewindSends, (current) => {
      const next = new Map(current);
      next.delete(event.payload.threadId);
      return next;
    });

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* Effect.logWarning("edited message auto-send skipped: thread not found after revert", {
        threadId: event.payload.threadId,
      });
      return;
    }

    // Plain text: the revert already rolled the provider context back to the
    // edit point, so no correction framing is needed.
    yield* dispatchEditedTurnStart({
      requestEventId: entry.requestEventId,
      step: "rewind",
      threadId: event.payload.threadId,
      text: entry.text,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      framing: "plain",
      attachments: entry.attachments,
      createdAt: yield* nowIso,
    });
    yield* completeEditRequest({
      requestEventId: entry.requestEventId,
      threadId: event.payload.threadId,
      outcome: "succeeded",
      createdAt: yield* nowIso,
    });
  });

  // A failed revert (see CheckpointReactor's `checkpoint.revert.failed`
  // activity) cancels the pending auto-send — the thread state never reached
  // the edit point, so sending there would be wrong.
  const handleRevertFailureActivity = Effect.fn("handleRevertFailureActivity")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  ) {
    const threadId = event.payload.threadId;
    const pending = yield* Ref.get(pendingRewindSends);
    if (!pending.has(threadId)) {
      return;
    }
    yield* Ref.update(pendingRewindSends, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* appendEditFailureActivity({
      requestEventId: pending.get(threadId)?.requestEventId ?? event.eventId,
      threadId,
      detail:
        "The rewind failed, so the edited message was not sent. The thread is unchanged; see the checkpoint revert failure above.",
      createdAt: now,
    });
    const failedRequest = pending.get(threadId)?.requestEventId;
    if (failedRequest) {
      yield* completeEditRequest({
        requestEventId: failedRequest,
        threadId,
        outcome: "failed",
        createdAt: now,
      });
    }
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.message-edit-completed") {
      yield* Ref.update(completedEditRequests, (completed) => {
        const next = new Set(completed);
        next.add(event.payload.requestEventId);
        return next;
      });
      return;
    }
    if (event.type === "thread.message-edit-requested") {
      yield* handleEditRequested(event);
      return;
    }
    if (event.type === "thread.reverted") {
      yield* handleReverted(event);
      return;
    }
    if (event.type === "thread.activity-appended") {
      yield* handleRevertFailureActivity(event);
    }
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("message-edit reactor failed to process event", {
          eventType: event.type,
          threadId:
            "threadId" in event.payload
              ? String(event.payload.threadId)
              : String(event.aggregateId),
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const enqueueOnce = Effect.fn("MessageEditReactor.enqueueOnce")(function* (
    event: OrchestrationEvent,
  ) {
    const shouldEnqueue = yield* Ref.modify(seenDomainEvents, (seen) => {
      if (seen.has(event.eventId)) {
        return [false, seen] as const;
      }
      const next = new Set(seen);
      next.add(event.eventId);
      return [true, next] as const;
    });
    if (shouldEnqueue) {
      yield* worker.enqueue(event);
    }
  });

  const isRelevantEvent = (event: OrchestrationEvent): boolean =>
    event.type === "thread.message-edit-requested" ||
    event.type === "thread.message-edit-completed" ||
    event.type === "thread.reverted" ||
    (event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "checkpoint.revert.failed");

  const start: MessageEditReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isRelevantEvent(event)) {
          return Effect.void;
        }
        return enqueueOnce(event);
      }),
    );

    // The domain stream is intentionally hot. Rebuild durable edit state from
    // persisted events after subscribing, then enqueue unfinished requests
    // and their later revert receipts in original sequence order. Command and
    // entity ids are request-derived, so replay is safe across a crash.
    const historical = yield* Stream.runCollect(
      orchestrationEngine.readEvents(0, Number.MAX_SAFE_INTEGER),
    ).pipe(
      Effect.map((events) => Array.from(events)),
      Effect.catchCause((cause) =>
        Effect.logWarning("message-edit restart replay failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<OrchestrationEvent>)),
      ),
    );
    yield* Ref.update(completedEditRequests, (completed) => {
      const next = new Set(completed);
      for (const event of historical) {
        if (event.type === "thread.message-edit-completed") {
          next.add(event.payload.requestEventId);
        }
      }
      return next;
    });
    yield* Effect.forEach(historical.filter(isRelevantEvent), enqueueOnce, { discard: true });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies MessageEditReactorShape;
});

export const MessageEditReactorLive = Layer.effect(MessageEditReactor, make);
