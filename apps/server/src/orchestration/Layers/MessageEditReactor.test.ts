// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadMessageEditResolution,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { MessageEditReactor } from "../Services/MessageEditReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { MessageEditReactorLive } from "./MessageEditReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const minutesAfterStart = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(NOW), { minutes }));
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");

const FIRST_USER_MESSAGE_ID = MessageId.make("message-user-1");
const FIRST_ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-1");
const SECOND_USER_MESSAGE_ID = MessageId.make("message-user-2");
const SECOND_ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-2");
const FIRST_TURN_ID = TurnId.make("turn-1");
const SECOND_TURN_ID = TurnId.make("turn-2");

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-message-edit-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function createProviderServiceHarness(cwd: string) {
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );
  const resetConversation = vi.fn<ProviderServiceShape["resetConversation"]>(() => Effect.void);
  const forkConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly forkedThreadId: ThreadId;
      readonly upToTurnId?: TurnId | undefined;
      readonly cwd?: string | undefined;
    }) => Effect.void,
  );
  const sessionFork = { current: "turn-granular" as "turn-granular" | "full-copy" | "none" };

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;

  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () =>
      Effect.succeed([
        {
          provider: ProviderDriverKind.make("codex"),
          status: "ready",
          runtimeMode: "full-access",
          threadId: THREAD_ID,
          cwd,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ] satisfies ReadonlyArray<ProviderSession>),
    getCapabilities: () =>
      Effect.succeed({ sessionModelSwitch: "in-session", sessionFork: sessionFork.current }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: `codex:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    resetConversation,
    forkConversation,
    // Nothing here drives provider runtime events; the stream just stays open
    // the way a real subscription does.
    streamEvents: Stream.never,
  };

  return { service, rollbackConversation, resetConversation, forkConversation, sessionFork };
}

interface Harness {
  readonly cwd: string;
  readonly createWorktree: ReturnType<typeof vi.fn>;
  /** Dispatch and edit die on failure: a rejected command is a test failure. */
  readonly dispatch: (
    command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
  ) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly start: Effect.Effect<void, never, import("effect/Scope").Scope>;
  readonly events: Effect.Effect<ReadonlyArray<OrchestrationEvent>>;
  readonly provider: ReturnType<typeof createProviderServiceHarness>;
  readonly editMessage: (input: {
    readonly messageId: MessageId;
    readonly text: string;
    readonly resolution: ThreadMessageEditResolution;
  }) => Effect.Effect<void>;
  readonly sourceThread: Effect.Effect<OrchestrationThread | undefined>;
  readonly forkThread: Effect.Effect<OrchestrationThread | undefined>;
}

/**
 * Polls until the projection catches up. The orchestration pipeline projects
 * asynchronously, so a resolution's effect lands a beat after the command that
 * triggered it settles; the deadline turns a stuck reaction into a failure
 * rather than a hang.
 */
const waitFor = <A>(resolve: Effect.Effect<A | undefined>, label: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 15_000;
    while (true) {
      const result = yield* resolve;
      if (result !== undefined) {
        return result;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
      }
      yield* Effect.sleep("10 millis");
    }
  });

describe("MessageEditReactor", () => {
  /**
   * Runs `body` against a live orchestration stack over a throwaway git repo
   * and in-memory projection, seeded with a thread of two completed turns and
   * their checkpoints. The transcript is shaped the way the real pipeline
   * produces one: user messages carry no turnId, assistant messages carry the
   * turn they were streamed on, and every message has its own timestamp.
   */
  const withHarness = (
    body: (harness: Harness) => Effect.Effect<void, never, import("effect/Scope").Scope>,
    options?: { readonly startMessageEditReactor?: boolean },
  ) =>
    Effect.gen(function* () {
      const cwd = createGitRepository();
      const worktreePath = NodePath.join(cwd, "..", `worktree-${NodePath.basename(cwd)}`);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(worktreePath, { recursive: true, force: true });
          NodeFS.rmSync(cwd, { recursive: true, force: true });
        }),
      );
      const provider = createProviderServiceHarness(cwd);
      const createWorktree = vi.fn((input: VcsCreateWorktreeInput) =>
        Effect.sync(() => {
          runGit(input.cwd, [
            "worktree",
            "add",
            ...(input.newRefName ? ["-b", input.newRefName] : []),
            worktreePath,
            input.refName,
          ]);
          return {
            worktree: {
              path: worktreePath,
              refName: input.newRefName ?? input.refName,
            },
          };
        }),
      );
      const removeWorktree = vi.fn((input: { readonly cwd: string; readonly path: string }) =>
        Effect.sync(() => {
          runGit(input.cwd, ["worktree", "remove", "--force", input.path]);
        }),
      );
      const deleteRef = vi.fn((input: { readonly cwd: string; readonly refName: string }) =>
        Effect.sync(() => {
          runGit(input.cwd, ["branch", "-D", input.refName]);
        }),
      );
      const listRefs = vi.fn(() =>
        Effect.succeed({
          refs: [],
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        }),
      );

      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );

      const layer = MessageEditReactorLive.pipe(
        Layer.provideMerge(CheckpointReactorLive),
        Layer.provideMerge(orchestrationLayer),
        Layer.provideMerge(projectionSnapshotLayer),
        Layer.provideMerge(RuntimeReceiptBusLive),
        Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
        Layer.provideMerge(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            createWorktree,
            removeWorktree,
            deleteRef,
            listRefs,
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
        Layer.provideMerge(
          Layer.succeed(VcsStatusBroadcaster, {
            getStatus: () => Effect.die("getStatus should not be called in this test"),
            refreshLocalStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: false,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
            streamStatus: () => Stream.empty,
          }),
        ),
        Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
        Layer.provideMerge(
          WorkspaceEntries.layer.pipe(
            Layer.provide(WorkspacePaths.layer),
            Layer.provideMerge(VcsDriverRegistry.layer),
          ),
        ),
        Layer.provideMerge(WorkspacePaths.layer),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-edit-reactor-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      const program = Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const reactor = yield* MessageEditReactor;
        // Rewinds hand off to the real checkpoint pipeline, so it has to be live.
        const checkpointReactor = yield* CheckpointReactor;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        if (options?.startMessageEditReactor !== false) {
          yield* reactor.start();
        }
        yield* checkpointReactor.start();

        const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
          engine.dispatch(command).pipe(Effect.orDie, Effect.asVoid);

        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: PROJECT_ID,
          title: "Test Project",
          workspaceRoot: cwd,
          defaultModelSelection: { instanceId: INSTANCE_ID, model: "gpt-5-codex" },
          createdAt: NOW,
        });
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Login work",
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: cwd,
          createdAt: NOW,
        });
        yield* dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            providerInstanceId: INSTANCE_ID,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
          createdAt: NOW,
        });

        const seedTurn = Effect.fn("seedTurn")(function* (input: {
          readonly index: 1 | 2;
          readonly userMessageId: MessageId;
          readonly assistantMessageId: MessageId;
          readonly turnId: TurnId;
          readonly userText: string;
          readonly fileContents: string;
        }) {
          const sentAt = minutesAfterStart(input.index * 2 - 1);
          const repliedAt = minutesAfterStart(input.index * 2);
          yield* dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-turn-start-${input.index}`),
            threadId: THREAD_ID,
            message: {
              messageId: input.userMessageId,
              role: "user",
              text: input.userText,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: sentAt,
          });
          yield* dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`cmd-assistant-delta-${input.index}`),
            threadId: THREAD_ID,
            messageId: input.assistantMessageId,
            delta: `Reply ${input.index}`,
            turnId: input.turnId,
            createdAt: repliedAt,
          });
          yield* dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`cmd-assistant-complete-${input.index}`),
            threadId: THREAD_ID,
            messageId: input.assistantMessageId,
            turnId: input.turnId,
            createdAt: repliedAt,
          });
          NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), input.fileContents, "utf8");
          yield* checkpointStore.captureCheckpoint({
            cwd,
            checkpointRef: checkpointRefForThreadTurn(THREAD_ID, input.index),
          });
          yield* dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-turn-diff-${input.index}`),
            threadId: THREAD_ID,
            turnId: input.turnId,
            completedAt: repliedAt,
            checkpointRef: checkpointRefForThreadTurn(THREAD_ID, input.index),
            status: "ready",
            files: [],
            assistantMessageId: input.assistantMessageId,
            checkpointTurnCount: input.index,
            createdAt: repliedAt,
          });
        });

        // Checkpoint 0 is the pre-turn baseline of turn 1: the state the
        // first edited message saw.
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        });
        yield* seedTurn({
          index: 1,
          userMessageId: FIRST_USER_MESSAGE_ID,
          assistantMessageId: FIRST_ASSISTANT_MESSAGE_ID,
          turnId: FIRST_TURN_ID,
          userText: "Add a login form",
          fileContents: "v2\n",
        });
        yield* seedTurn({
          index: 2,
          userMessageId: SECOND_USER_MESSAGE_ID,
          assistantMessageId: SECOND_ASSISTANT_MESSAGE_ID,
          turnId: SECOND_TURN_ID,
          userText: "Now add validation",
          fileContents: "v3\n",
        });

        const readModel = snapshotQuery.getSnapshot().pipe(Effect.orDie);
        const threadWhere = (predicate: (thread: OrchestrationThread) => boolean) =>
          Effect.map(readModel, (snapshot) => snapshot.threads.find(predicate));

        const harness: Harness = {
          cwd,
          createWorktree,
          dispatch,
          drain: reactor.drain,
          start: reactor.start(),
          events: Stream.runCollect(engine.readEvents(0, Number.MAX_SAFE_INTEGER)).pipe(
            Effect.map((events) => Array.from(events)),
            Effect.orDie,
          ),
          provider,
          editMessage: (input) =>
            dispatch({
              type: "thread.message.edit",
              commandId: CommandId.make(`cmd-edit-${input.messageId}-${input.resolution.kind}`),
              threadId: THREAD_ID,
              messageId: input.messageId,
              text: input.text,
              resolution: input.resolution,
              createdAt: NOW,
            }),
          sourceThread: threadWhere((thread) => thread.id === THREAD_ID),
          forkThread: threadWhere((thread) => thread.id !== THREAD_ID),
        };

        return yield* body(harness);
      });

      return yield* program.pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  it.live("forks the transcript prefix, worktrees the edit-point checkpoint, and auto-sends", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.editMessage({
          messageId: SECOND_USER_MESSAGE_ID,
          text: "Now add validation and tests",
          resolution: { kind: "fork" },
        });

        const fork = yield* waitFor(
          Effect.map(harness.forkThread, (thread) =>
            thread && thread.messages.length >= 3 ? thread : undefined,
          ),
          "the fork thread to receive the edited message",
        );

        // Transcript prefix: everything up to and including the assistant
        // reply before the edited message, then the edit itself as the fork's
        // new turn. Copies get fresh ids — message ids are globally unique, so
        // reusing them would move the rows off the source thread.
        expect(fork.messages.map((message) => [message.role, message.text])).toEqual([
          ["user", "Add a login form"],
          ["assistant", "Reply 1"],
          ["user", "Now add validation and tests"],
        ]);
        expect(
          fork.messages.some(
            (message) =>
              message.id === FIRST_USER_MESSAGE_ID || message.id === FIRST_ASSISTANT_MESSAGE_ID,
          ),
        ).toBe(false);
        expect(fork.title).toBe("Login work (fork)");
        expect(fork.forkedFromThreadId).toBe(THREAD_ID);
        expect(fork.forkPointMessageId).toBe(FIRST_ASSISTANT_MESSAGE_ID);
        expect(fork.forkKind).toBe("user");

        // The worktree branches from the real commit that checkpoint 1 was
        // based on, then restores checkpoint 1 as working-tree state. The
        // branch therefore keeps normal repository ancestry without exposing
        // the hidden checkpoint commit as user history.
        expect(harness.createWorktree).toHaveBeenCalledTimes(1);
        const worktreeInput = harness.createWorktree.mock.calls[0]?.[0] as
          | VcsCreateWorktreeInput
          | undefined;
        expect(worktreeInput?.refName).toBe(
          runGit(harness.cwd, ["rev-parse", `${checkpointRefForThreadTurn(THREAD_ID, 1)}^`]).trim(),
        );
        expect(fork.worktreePath).not.toBe(null);
        expect(NodeFS.readFileSync(NodePath.join(fork.worktreePath!, "README.md"), "utf8")).toBe(
          "v2\n",
        );
        expect(fork.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
        expect(
          runGit(fork.worktreePath!, [
            "show",
            `${checkpointRefForThreadTurn(fork.id, 1)}:README.md`,
          ]),
        ).toBe("v2\n");

        // The provider conversation is sliced at the last turn in the prefix.
        expect(harness.provider.forkConversation).toHaveBeenCalledTimes(1);
        const forkInput = harness.provider.forkConversation.mock.calls[0]?.[0];
        expect(forkInput?.threadId).toBe(THREAD_ID);
        expect(forkInput?.upToTurnId).toBe(FIRST_TURN_ID);

        // The source thread is untouched apart from a row pointing at the fork.
        const source = yield* harness.sourceThread;
        expect(source?.messages.map((message) => message.id)).toEqual([
          FIRST_USER_MESSAGE_ID,
          FIRST_ASSISTANT_MESSAGE_ID,
          SECOND_USER_MESSAGE_ID,
          SECOND_ASSISTANT_MESSAGE_ID,
        ]);
        const forkActivity = source?.activities.find(
          (activity) => activity.kind === "thread.forked",
        );
        expect((forkActivity?.payload as { forkThreadId?: string } | undefined)?.forkThreadId).toBe(
          fork.id,
        );
      }),
    ),
  );

  it.live(
    "frames the edit as a correction when the provider can only copy the whole conversation",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          harness.provider.sessionFork.current = "full-copy";

          yield* harness.editMessage({
            messageId: SECOND_USER_MESSAGE_ID,
            text: "Now add validation and tests",
            resolution: { kind: "fork" },
          });

          const fork = yield* waitFor(
            Effect.map(harness.forkThread, (thread) =>
              thread && thread.messages.length >= 3 ? thread : undefined,
            ),
            "the fork thread to receive the edited message",
          );
          // The copied context still holds the original message, so the agent is
          // told which version is operative.
          expect(fork.messages[2]?.text).toContain("[Edited message]");
          expect(fork.messages[2]?.text).toContain("Now add validation and tests");
        }),
      ),
  );

  it.live("rolls the provider context back to the edit point on continue/reset", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.editMessage({
          messageId: SECOND_USER_MESSAGE_ID,
          text: "Actually, add validation only",
          resolution: { kind: "continue", contextMode: "reset" },
        });

        const source = yield* waitFor(
          Effect.map(harness.sourceThread, (thread) =>
            thread && thread.messages.length >= 5 ? thread : undefined,
          ),
          "the edited message to be sent on the thread",
        );
        // Nothing was discarded: the edit is appended, history stays intact.
        expect(source.messages.at(-1)?.text).toBe("Actually, add validation only");

        // The provider is rebound to a native conversation fork ending at
        // the completed turn before the edited message.
        expect(harness.provider.resetConversation).toHaveBeenCalledTimes(1);
        expect(harness.provider.resetConversation).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          upToTurnId: FIRST_TURN_ID,
        });
        expect(harness.provider.forkConversation).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("keeps the agent's context and frames the edit on continue/correction", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.editMessage({
          messageId: FIRST_USER_MESSAGE_ID,
          text: "The login form needs a remember-me box",
          resolution: { kind: "continue", contextMode: "correction" },
        });

        const source = yield* waitFor(
          Effect.map(harness.sourceThread, (thread) =>
            thread && thread.messages.length >= 5 ? thread : undefined,
          ),
          "the edited message to be sent on the thread",
        );
        expect(source.messages.at(-1)?.text).toContain("[Edited message]");
        expect(source.messages.at(-1)?.text).toContain("remember-me box");
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("replays an unfinished persisted edit after reactor restart", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.editMessage({
            messageId: SECOND_USER_MESSAGE_ID,
            text: "Recover this edited instruction",
            resolution: { kind: "continue", contextMode: "correction" },
          });

          expect((yield* harness.sourceThread)?.messages).toHaveLength(4);
          yield* harness.start;

          const source = yield* waitFor(
            Effect.map(harness.sourceThread, (thread) =>
              thread && thread.messages.length >= 5 ? thread : undefined,
            ),
            "the persisted edit to replay after startup",
          );
          expect(source.messages.at(-1)?.text).toContain("Recover this edited instruction");
          const events = yield* harness.events;
          expect(
            events.some(
              (event) =>
                event.type === "thread.message-edit-completed" &&
                event.payload.outcome === "succeeded",
            ),
          ).toBe(true);
        }),
      { startMessageEditReactor: false },
    ),
  );

  it.live("finishes a rewind after restart when the source transcript is already truncated", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.editMessage({
            messageId: SECOND_USER_MESSAGE_ID,
            text: "Recover the rewound instruction",
            resolution: { kind: "rewind" },
          });
          const requested = (yield* harness.events).find(
            (event) => event.type === "thread.message-edit-requested",
          );
          if (!requested || requested.type !== "thread.message-edit-requested") {
            return yield* Effect.die("missing persisted message edit request");
          }
          const archiveThreadId = ThreadId.make(`message-edit-${requested.eventId}-archive`);
          yield* harness.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("simulate-partial-rewind-archive"),
            forkedThreadId: archiveThreadId,
            sourceThreadId: THREAD_ID,
            forkPointMessageId: SECOND_ASSISTANT_MESSAGE_ID,
            forkKind: "archive-tail",
            title: "Login work (archived tail)",
            createdAt: NOW,
          });
          yield* harness.dispatch({
            type: "thread.revert.complete",
            commandId: CommandId.make("simulate-partial-rewind-complete"),
            threadId: THREAD_ID,
            turnCount: 1,
            createdAt: NOW,
          });
          expect((yield* harness.sourceThread)?.messages).toHaveLength(2);

          yield* harness.start;
          const source = yield* waitFor(
            Effect.map(harness.sourceThread, (thread) =>
              thread?.messages.some((message) =>
                message.text.includes("Recover the rewound instruction"),
              )
                ? thread
                : undefined,
            ),
            "the post-restart rewind auto-send",
          );
          expect(source.messages.at(-1)?.text).toBe("Recover the rewound instruction");
        }),
      { startMessageEditReactor: false },
    ),
  );

  it.live("archives the discarded tail as a settled thread before rewinding", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.editMessage({
          messageId: SECOND_USER_MESSAGE_ID,
          text: "Skip validation, write tests instead",
          resolution: { kind: "rewind" },
        });

        const archive = yield* waitFor(
          Effect.map(harness.forkThread, (thread) =>
            thread && thread.settledAt !== null && thread.checkpoints.length === 2
              ? thread
              : undefined,
          ),
          "the archived tail thread",
        );
        // The archive keeps everything the rewind is about to discard.
        expect(archive.forkKind).toBe("archive-tail");
        expect(archive.forkedFromThreadId).toBe(THREAD_ID);
        expect(archive.messages.map((message) => [message.role, message.text])).toEqual([
          ["user", "Add a login form"],
          ["assistant", "Reply 1"],
          ["user", "Now add validation"],
          ["assistant", "Reply 2"],
        ]);
        expect(archive.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([
          1, 2,
        ]);

        // The source rewinds to the pre-turn state of the edited turn and the
        // edited message is sent there once the revert lands.
        const source = yield* waitFor(
          Effect.map(harness.sourceThread, (thread) =>
            thread?.messages.some(
              (message) => message.text === "Skip validation, write tests instead",
            )
              ? thread
              : undefined,
          ),
          "the rewound thread to receive the edited message",
        );
        expect(source.messages.map((message) => [message.role, message.text])).toEqual([
          ["user", "Add a login form"],
          ["assistant", "Reply 1"],
          ["user", "Skip validation, write tests instead"],
        ]);
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
        expect(source.activities.some((activity) => activity.kind === "thread.tail-archived")).toBe(
          true,
        );
      }),
    ),
  );

  it.live("refuses to rewind a message whose turn never produced a checkpoint", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        // A send whose turn died in the provider: no assistant reply, so
        // nothing was ever checkpointed for it and there is no file state to
        // restore.
        yield* harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-3"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-user-3"),
            role: "user",
            text: "And now deploy",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: minutesAfterStart(5),
        });
        yield* harness.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-error"),
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "error",
            providerName: "codex",
            providerInstanceId: INSTANCE_ID,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "provider exited",
            updatedAt: minutesAfterStart(6),
          },
          createdAt: minutesAfterStart(6),
        });

        yield* harness.editMessage({
          messageId: MessageId.make("message-user-3"),
          text: "And now deploy to staging",
          resolution: { kind: "rewind" },
        });

        const source = yield* waitFor(
          Effect.map(harness.sourceThread, (thread) =>
            thread?.activities.some((activity) => activity.kind === "thread.edit.failed")
              ? thread
              : undefined,
          ),
          "the edit failure activity",
        );
        // No archive thread, no revert: the thread is exactly as it was.
        expect(yield* harness.forkThread).toBeUndefined();
        expect(source.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([
          1, 2,
        ]);
      }),
    ),
  );
});
