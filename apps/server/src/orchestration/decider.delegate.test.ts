import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delegate"),
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delegate"),
      title: "Project Delegate",
      workspaceRoot: "/tmp/project-delegate",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-parent"),
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-parent"),
      projectId: asProjectId("project-delegate"),
      title: "Parent",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const makeCreateCommand = (overrides: {
  readonly threadId?: ThreadId;
  readonly parentThreadId?: ThreadId;
}) => ({
  type: "thread.create" as const,
  commandId: asCommandId("cmd-delegate-create"),
  threadId: overrides.threadId ?? asThreadId("thread-child"),
  projectId: asProjectId("project-delegate"),
  title: "Delegate task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "approval-required" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  ...(overrides.parentThreadId === undefined ? {} : { parentThreadId: overrides.parentThreadId }),
  createdAt: NOW,
});

it.layer(NodeServices.layer)("decider delegation flows", (it) => {
  it.effect("stamps the delegating parent on the created thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const event = yield* decideOrchestrationCommand({
        command: makeCreateCommand({ parentThreadId: asThreadId("thread-parent") }),
        readModel,
      });
      expect(event.type).toBe("thread.created");
      expect(event.payload).toMatchObject({
        threadId: asThreadId("thread-child"),
        parentThreadId: asThreadId("thread-parent"),
      });
    }),
  );

  it.effect("records a null parent for ordinary thread creation", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const event = yield* decideOrchestrationCommand({
        command: makeCreateCommand({}),
        readModel,
      });
      expect(event.payload).toMatchObject({
        threadId: asThreadId("thread-child"),
        parentThreadId: null,
      });
    }),
  );

  it.effect("rejects a delegate whose parent does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeCreateCommand({ parentThreadId: asThreadId("thread-missing") }),
          readModel,
        }),
      );
      expect(error).toMatchObject({
        commandType: "thread.create",
      });
      expect(error.detail).toContain("thread-missing");
    }),
  );
});
