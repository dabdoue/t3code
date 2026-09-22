import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DelegateParentThreadNotFoundError,
  DelegateTaskFailedError,
  DelegationToolkit,
  type DelegateTaskResult,
} from "./tools.ts";

/** How long a blocking delegate waits before reporting "timeout" (the delegate keeps running). */
const BLOCKING_WAIT_TIMEOUT = "10 minutes";

/** First line of the prompt becomes the sidebar label when the caller gives no title. */
function deriveDelegateTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const source = firstLine.length > 0 ? firstLine : prompt.trim();
  const sliced = source.slice(0, 80).trim();
  return sliced.length > 0 ? sliced : "Delegate task";
}

const isSessionSetFor =
  (threadId: ThreadId) =>
  (
    event: OrchestrationEvent,
  ): event is Extract<OrchestrationEvent, { type: "thread.session-set" }> =>
    event.type === "thread.session-set" && event.payload.threadId === threadId;

const terminalStatusOf = (status: OrchestrationSessionStatus): DelegateTaskResult["status"] => {
  if (status === "error") return "failed";
  if (status === "interrupted" || status === "stopped") return "interrupted";
  return "completed";
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const dispatchFailure = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, DelegateTaskFailedError, R> =>
    Effect.catchCause(effect, (cause): Effect.Effect<never, DelegateTaskFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new DelegateTaskFailedError({ cause })),
    );

  const shellOf = (threadId: ThreadId) =>
    Effect.mapError(snapshots.getThreadShellById(threadId), (cause) => {
      return new DelegateTaskFailedError({ cause });
    });

  return DelegationToolkit.of({
    delegate_task: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("delegate");
        const parent = yield* Effect.flatMap(shellOf(scope.threadId), (thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(new DelegateParentThreadNotFoundError({ threadId: scope.threadId })),
        );

        const modelSelection = {
          instanceId: ProviderInstanceId.make(
            input.providerInstanceId ?? parent.modelSelection.instanceId,
          ),
          model: input.model ?? parent.modelSelection.model,
        };
        const title = input.title ?? deriveDelegateTitle(input.prompt);
        const childThreadId = yield* crypto.randomUUIDv4.pipe(
          Effect.orDie,
          Effect.map((uuid) => ThreadId.make(`delegate:${scope.threadId}:${uuid}`)),
        );
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

        const dispatchCommands = Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: yield* commandId("mcp-delegate-create", scope.threadId),
            threadId: childThreadId,
            projectId: parent.projectId,
            title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            parentThreadId: scope.threadId,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: yield* commandId("mcp-delegate-turn", childThreadId),
            threadId: childThreadId,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            titleSeed: title,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          });
        });

        if (input.background === true) {
          yield* dispatchFailure(dispatchCommands);
          return {
            threadId: childThreadId,
            projectId: parent.projectId,
            title,
            providerInstanceId: modelSelection.instanceId,
            model: modelSelection.model,
            status: "started",
            detail: null,
          } satisfies DelegateTaskResult;
        }

        // Subscribe before dispatching so no session transition can slip past.
        // Cancelling this tool (client timeout, parent turn aborted) interrupts
        // only the wait; the child thread keeps working on its own.
        const outcome = yield* dispatchFailure(
          Effect.gen(function* () {
            const done = yield* Deferred.make<OrchestrationSessionStatus>();
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const events = yield* engine.subscribeDomainEvents;
                yield* events.pipe(
                  Stream.filter(isSessionSetFor(childThreadId)),
                  Stream.map((event) => event.payload.session.status),
                  Stream.filter(
                    (status: OrchestrationSessionStatus) =>
                      status !== "starting" && status !== "running",
                  ),
                  Stream.take(1),
                  Stream.runForEach((status) => Deferred.succeed(done, status)),
                  Effect.forkScoped,
                );
                yield* dispatchCommands;
                return yield* Deferred.await(done);
              }),
            );
          }),
        ).pipe(
          Effect.map((status) => terminalStatusOf(status)),
          Effect.timeout(BLOCKING_WAIT_TIMEOUT),
          Effect.catchTag("TimeoutError", () => Effect.succeed("timeout" as const)),
        );

        let detail: string | null = null;
        if (outcome === "timeout") {
          detail =
            "Still running: the blocking wait hit its cap, but the delegate was not cancelled and keeps working.";
        } else if (outcome !== "completed") {
          const shell = yield* shellOf(childThreadId);
          detail = Option.isSome(shell) ? (shell.value.session?.lastError ?? null) : null;
        }

        return {
          threadId: childThreadId,
          projectId: parent.projectId,
          title,
          providerInstanceId: modelSelection.instanceId,
          model: modelSelection.model,
          status: outcome,
          detail,
        } satisfies DelegateTaskResult;
      }),
  });
});

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(make);
