import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ThreadQueue from "./threadQueue.ts";

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("reconciles projected sessions that have no live provider runtime", () =>
  Effect.gen(function* () {
    const staleThreadId = ThreadId.make("thread-stale-running");
    const activeThreadId = ThreadId.make("thread-live-running");
    const stoppedThreadId = ThreadId.make("thread-already-stopped");
    const stoppedBindings = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const heldQueueThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const now = "2026-08-12T00:00:00.000Z";
    const makeThread = (threadId: ThreadId, status: "running" | "stopped") =>
      ({
        id: threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: status === "running" ? "turn-active" : null,
          lastError: null,
          updatedAt: now,
        },
      }) as never;

    yield* ServerRuntimeStartup.reconcileStaleProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: [] }),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [
              makeThread(staleThreadId, "running"),
              makeThread(activeThreadId, "running"),
              makeThread(stoppedThreadId, "stopped"),
            ],
            updatedAt: now,
          }),
        getArchivedShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now }),
      } as never),
      Effect.provideService(ProviderService.ProviderService, {
        listSessions: () => Effect.succeed([{ threadId: activeThreadId } as never]),
        stopSession: (input: { readonly threadId: ThreadId }) =>
          Ref.update(stoppedBindings, (threadIds) => [...threadIds, input.threadId]),
      } as never),
      Effect.provideService(ThreadQueue.ThreadQueue, {
        snapshot: Effect.succeed({
          revision: 1,
          messages: [{ threadId: staleThreadId }],
          heldThreadIds: [],
        }),
        holdThreads: (threadIds: ReadonlyArray<ThreadId>, held: boolean) =>
          Ref.set(heldQueueThreads, held ? threadIds : []).pipe(
            Effect.as({
              revision: 2,
              messages: [{ threadId: staleThreadId }],
              heldThreadIds: held ? threadIds : [],
            }),
          ),
      } as never),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 2 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(1),
      }),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(yield* Ref.get(stoppedBindings), [staleThreadId]);
    assert.deepStrictEqual(yield* Ref.get(heldQueueThreads), [staleThreadId]);
    const commands = yield* Ref.get(dispatched);
    assert.equal(commands.length, 1);
    const command = commands[0] as {
      readonly type: string;
      readonly threadId: ThreadId;
      readonly session: { readonly status: string; readonly activeTurnId: string | null };
    };
    assert.equal(command.type, "thread.session.set");
    assert.equal(command.threadId, staleThreadId);
    assert.equal(command.session.status, "stopped");
    assert.equal(command.session.activeTurnId, null);
  }),
);

it.effect("clears open blocking requests on stale threads during startup reconcile", () =>
  Effect.gen(function* () {
    const staleThreadId = ThreadId.make("thread-stale-with-plan");
    const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const now = "2026-08-12T00:00:00.000Z";

    yield* ServerRuntimeStartup.reconcileStaleProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        // Open approval, open user-input, already-resolved approval, and one
        // previously cleared by a stale marker — only the first two should
        // get clearing activities.
        getCommandReadModel: () =>
          Effect.succeed({
            threads: [
              {
                id: staleThreadId,
                activities: [
                  {
                    id: "evt-1",
                    createdAt: "2026-08-11T00:00:01.000Z",
                    kind: "approval.requested",
                    payload: { requestId: "approval-open" },
                  },
                  {
                    id: "evt-2",
                    createdAt: "2026-08-11T00:00:02.000Z",
                    kind: "user-input.requested",
                    payload: { requestId: "input-open" },
                  },
                  {
                    id: "evt-3",
                    createdAt: "2026-08-11T00:00:03.000Z",
                    kind: "approval.requested",
                    payload: { requestId: "approval-resolved" },
                  },
                  {
                    id: "evt-4",
                    createdAt: "2026-08-11T00:00:04.000Z",
                    kind: "approval.resolved",
                    payload: { requestId: "approval-resolved" },
                  },
                  {
                    id: "evt-5",
                    createdAt: "2026-08-11T00:00:05.000Z",
                    kind: "approval.requested",
                    payload: { requestId: "approval-already-cleared" },
                  },
                  {
                    id: "evt-6",
                    createdAt: "2026-08-11T00:00:06.000Z",
                    kind: "provider.approval.respond.failed",
                    payload: {
                      requestId: "approval-already-cleared",
                      detail: "Stale pending approval request: approval-already-cleared.",
                    },
                  },
                ],
              },
            ],
          }),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [
              {
                id: staleThreadId,
                hasPendingApprovals: true,
                hasPendingUserInput: true,
                session: {
                  threadId: staleThreadId,
                  status: "running",
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: "full-access",
                  activeTurnId: "turn-plan",
                  lastError: null,
                  updatedAt: now,
                },
              },
            ],
            updatedAt: now,
          }),
        getArchivedShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now }),
      } as never),
      Effect.provideService(ProviderService.ProviderService, {
        listSessions: () => Effect.succeed([]),
        stopSession: () => Effect.void,
      } as never),
      Effect.provideService(ThreadQueue.ThreadQueue, {
        snapshot: Effect.succeed({ revision: 1, messages: [], heldThreadIds: [] }),
        holdThreads: () => Effect.succeed({ revision: 1, messages: [], heldThreadIds: [] }),
      } as never),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 2 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(1),
      }),
      Effect.provide(NodeServices.layer),
    );

    const commands = (yield* Ref.get(dispatched)) as ReadonlyArray<{
      readonly type: string;
      readonly activity?: {
        readonly kind: string;
        readonly payload: { readonly detail: string; readonly requestId: string };
      };
    }>;
    const sessionSet = commands.filter((command) => command.type === "thread.session.set");
    assert.equal(sessionSet.length, 1);
    const clearing = commands.filter((command) => command.type === "thread.activity.append");
    assert.equal(clearing.length, 2);
    const clearedIds = clearing.map((command) => command.activity?.payload.requestId).sort();
    assert.deepStrictEqual(clearedIds, ["approval-open", "input-open"]);
    for (const command of clearing) {
      assert.match(command.activity?.payload.detail ?? "", /^stale pending /i);
    }
  }),
);

it.effect("holds leftover queued threads on startup even when the parent is idle", () =>
  Effect.gen(function* () {
    const idleQueuedThreadId = ThreadId.make("thread-idle-queued");
    const heldQueueThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const now = "2026-08-12T00:00:00.000Z";

    yield* ServerRuntimeStartup.reconcileStaleProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: [] }),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [
              {
                id: idleQueuedThreadId,
                session: {
                  threadId: idleQueuedThreadId,
                  status: "stopped",
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: now,
                },
              },
            ],
            updatedAt: now,
          }),
        getArchivedShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now }),
      } as never),
      Effect.provideService(ProviderService.ProviderService, {
        listSessions: () => Effect.succeed([]),
        stopSession: () => Effect.void,
      } as never),
      Effect.provideService(ThreadQueue.ThreadQueue, {
        snapshot: Effect.succeed({
          revision: 1,
          messages: [{ threadId: idleQueuedThreadId }],
          heldThreadIds: [],
        }),
        holdThreads: (threadIds: ReadonlyArray<ThreadId>, held: boolean) =>
          Ref.set(heldQueueThreads, held ? threadIds : []).pipe(
            Effect.as({
              revision: 2,
              messages: [{ threadId: idleQueuedThreadId }],
              heldThreadIds: held ? threadIds : [],
            }),
          ),
      } as never),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 2 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(1),
      }),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(yield* Ref.get(heldQueueThreads), [idleQueuedThreadId]);
  }),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
