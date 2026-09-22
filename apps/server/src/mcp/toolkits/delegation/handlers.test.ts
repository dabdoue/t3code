import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkitHandlersLive } from "./handlers.ts";
import { DelegateParentThreadNotFoundError, DelegationToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeThread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-09-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const sessionSetEvent = (
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  lastError: string | null = null,
): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("event-1"),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-09-22T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      activeTurnId: null,
      lastError,
      updatedAt: "2026-09-22T00:00:00.000Z",
    },
  },
});

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell | null;
  /** The statuses the child's session walks through after its turn starts. */
  readonly childStatuses?: ReadonlyArray<OrchestrationSessionStatus>;
  readonly childLastError?: string;
}

const makeHarness = Effect.fn("makeDelegationToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const thread = options.thread === undefined ? makeThread() : options.thread;
  const bus = yield* Queue.unbounded<OrchestrationEvent>();
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.turn.start") {
        for (const status of options.childStatuses ?? ["starting", "running", "ready"]) {
          yield* Queue.offer(
            bus,
            sessionSetEvent(command.threadId, status, options.childLastError ?? null),
          );
        }
      }
      return { sequence: 1 };
    });
  const reject = (command: OrchestrationCommand) =>
    command.type === "thread.create" && command.parentThreadId === "missing"
      ? Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Thread 'missing' does not exist.",
          }),
        )
      : Effect.void;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => {
        if (threadId === THREAD_ID) return Effect.succeed(Option.fromNullishOr(thread));
        // Delegate children resolve so a failed run can report its last error.
        if (threadId.startsWith("delegate:")) {
          return Effect.succeed(
            Option.some({
              ...thread,
              id: threadId,
              session: {
                threadId,
                status: "error" as const,
                providerName: "codex",
                activeTurnId: null,
                lastError: options.childLastError ?? null,
                updatedAt: "2026-09-22T00:00:00.000Z",
              },
            }),
          );
        }
        return Effect.succeed(Option.none());
      },
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.flatMap(reject(command), () => dispatch(command)),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.fromQueue(bus)),
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* DelegationToolkit.pipe(
    Effect.provide(DelegationToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof DelegationToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests", "delegate"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DelegationToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("delegation toolkit handlers", () => {
  it.effect("refuses a credential without the delegate capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("delegate_task", { prompt: "Summarize the failing test" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "delegate",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("blocks until the delegate's session settles, then reports completed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_task", {
        prompt: "Find the flaky test and fix it",
        title: "Flaky test",
      });
      expect(result).toMatchObject({
        title: "Flaky test",
        providerInstanceId: "codex",
        model: "gpt-5",
        status: "completed",
        detail: null,
      });
      expect(result.threadId.startsWith(`delegate:${THREAD_ID}:`)).toBe(true);
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(recorded[0]).toMatchObject({
        type: "thread.create",
        projectId: PROJECT_ID,
        title: "Flaky test",
        parentThreadId: THREAD_ID,
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        branch: null,
        worktreePath: null,
      });
      expect(recorded[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: result.threadId,
        message: { role: "user", text: "Find the flaky test and fix it" },
      });
    }),
  );

  it.effect("inherits the parent's model, overridable per call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("delegate_task", {
        prompt: "Task",
        providerInstanceId: "piAgent",
        model: "llmrtr/GLM-5.3-Flash",
      });
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded[0]).toMatchObject({
        modelSelection: { instanceId: "piAgent", model: "llmrtr/GLM-5.3-Flash" },
      });
    }),
  );

  it.effect("background returns started immediately with the turn already dispatched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_task", {
        prompt: "Long research task",
        background: true,
      });
      expect(result).toMatchObject({ status: "started", detail: null });
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("reports failed with the session's last error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        childStatuses: ["starting", "error"],
        childLastError: "Provider instance 'missing' is not configured.",
      });
      const result = yield* harness.call("delegate_task", { prompt: "Task" });
      expect(result.status).toBe("failed");
      expect(result.detail).toBe("Provider instance 'missing' is not configured.");
    }),
  );

  it.effect("derives the title from the prompt's first line", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_task", {
        prompt: "First line\n\nrest of the brief",
      });
      expect(result.title).toBe("First line");
    }),
  );

  it.effect("surfaces a dispatch invariant as DelegateTaskFailedError", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: null });
      const error = yield* harness.call("delegate_task", { prompt: "Task" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DelegateParentThreadNotFoundError" });
    }),
  );
});
