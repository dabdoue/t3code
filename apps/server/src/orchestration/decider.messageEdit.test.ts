import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const FORKED_THREAD_ID = ThreadId.make("thread-forked");

const FIRST_USER_MESSAGE_ID = MessageId.make("message-user-1");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-1");
const SECOND_USER_MESSAGE_ID = MessageId.make("message-user-2");

/**
 * Two complete turns: user → assistant, user → assistant. Every message carries
 * a turnId so the settle grace window never reads them as a queued turn start.
 */
const MESSAGES: OrchestrationThread["messages"] = [
  {
    id: FIRST_USER_MESSAGE_ID,
    role: "user",
    text: "Add a login form",
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: ASSISTANT_MESSAGE_ID,
    role: "assistant",
    text: "Done.",
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: SECOND_USER_MESSAGE_ID,
    role: "user",
    text: "Now add validation",
    turnId: TurnId.make("turn-2"),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: SOURCE_THREAD_ID,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

/**
 * The second turn, completed after the last user message — otherwise the
 * settle grace window reads that message as a turn start still awaiting
 * adoption and every in-place resolution is (correctly) refused.
 */
const COMPLETED_LATEST_TURN: OrchestrationThread["latestTurn"] = {
  turnId: TurnId.make("turn-2"),
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: "2026-01-01T00:01:00.000Z",
  assistantMessageId: null,
};

function makeReadModel(session: OrchestrationSession | null = null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: SOURCE_THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Login work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: COMPLETED_LATEST_TURN,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: MESSAGES,
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

const decide = (input: Parameters<typeof decideOrchestrationCommand>[0]) =>
  decideOrchestrationCommand(input).pipe(
    Effect.map((result) => (Array.isArray(result) ? result : [result])),
  );

it.layer(NodeServices.layer)("message edit decider", (it) => {
  it.effect("turns an edit of a sent user message into an edit request", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        command: {
          type: "thread.message.edit",
          commandId: CommandId.make("cmd-edit"),
          threadId: SOURCE_THREAD_ID,
          messageId: SECOND_USER_MESSAGE_ID,
          text: "Now add validation and tests",
          resolution: { kind: "fork" },
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      expect(events.map((event) => event.type)).toEqual(["thread.message-edit-requested"]);
      const [event] = events;
      if (event?.type !== "thread.message-edit-requested") {
        throw new Error("expected an edit request");
      }
      expect(event.payload.messageId).toBe(SECOND_USER_MESSAGE_ID);
      expect(event.payload.text).toBe("Now add validation and tests");
      expect(event.payload.resolution).toEqual({ kind: "fork" });
      // The marker rides the edited thread's own stream.
      expect(event.aggregateId).toBe(SOURCE_THREAD_ID);
    }),
  );

  it.effect("rejects editing an assistant message or a message from another thread", () =>
    Effect.gen(function* () {
      for (const messageId of [ASSISTANT_MESSAGE_ID, MessageId.make("message-elsewhere")]) {
        const error = yield* decide({
          command: {
            type: "thread.message.edit",
            commandId: CommandId.make(`cmd-edit-${messageId}`),
            threadId: SOURCE_THREAD_ID,
            messageId,
            text: "Rewrite",
            resolution: { kind: "fork" },
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("blocks in-place resolutions mid-turn but lets forking through", () =>
    Effect.gen(function* () {
      const command = (resolution: { readonly kind: "rewind" | "fork" }) =>
        ({
          type: "thread.message.edit",
          commandId: CommandId.make(`cmd-edit-${resolution.kind}`),
          threadId: SOURCE_THREAD_ID,
          messageId: FIRST_USER_MESSAGE_ID,
          text: "Rewrite",
          resolution,
          createdAt: NOW,
        }) as const;

      for (const status of ["starting", "running"] as const) {
        const rewindError = yield* decide({
          command: command({ kind: "rewind" }),
          readModel: makeReadModel(makeSession(status)),
        }).pipe(Effect.flip);
        expect(rewindError._tag).toBe("OrchestrationCommandInvariantError");

        const continueError = yield* decide({
          command: {
            type: "thread.message.edit",
            commandId: CommandId.make(`cmd-edit-continue-${status}`),
            threadId: SOURCE_THREAD_ID,
            messageId: FIRST_USER_MESSAGE_ID,
            text: "Rewrite",
            resolution: { kind: "continue", contextMode: "reset" },
            createdAt: NOW,
          },
          readModel: makeReadModel(makeSession(status)),
        }).pipe(Effect.flip);
        expect(continueError._tag).toBe("OrchestrationCommandInvariantError");

        // Forking never touches the source thread's live state.
        const forkEvents = yield* decide({
          command: command({ kind: "fork" }),
          readModel: makeReadModel(makeSession(status)),
        });
        expect(forkEvents.map((event) => event.type)).toEqual(["thread.message-edit-requested"]);
      }

      // Idle session: the in-place resolutions are available again.
      const rewindEvents = yield* decide({
        command: command({ kind: "rewind" }),
        readModel: makeReadModel(makeSession("ready")),
      });
      expect(rewindEvents.map((event) => event.type)).toEqual(["thread.message-edit-requested"]);
    }),
  );

  it.effect("blocks in-place resolutions while a turn start awaits adoption", () =>
    Effect.gen(function* () {
      // Idle session, but the newest user message is newer than the latest
      // turn: a send the provider has not picked up yet. Rewinding underneath
      // it would restore files the queued turn is about to run against.
      const readModel = makeReadModel(makeSession("ready"));
      const pendingReadModel: OrchestrationReadModel = {
        ...readModel,
        threads: [{ ...readModel.threads[0]!, latestTurn: null }],
      };
      const error = yield* decide({
        command: {
          type: "thread.message.edit",
          commandId: CommandId.make("cmd-edit-queued"),
          threadId: SOURCE_THREAD_ID,
          messageId: FIRST_USER_MESSAGE_ID,
          text: "Rewrite",
          resolution: { kind: "rewind" },
          createdAt: NOW,
        },
        readModel: pendingReadModel,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  const forkCommand = (
    overrides: Partial<{
      readonly forkPointMessageId: MessageId | null;
      readonly forkKind: "user" | "archive-tail";
      readonly commandId: string;
    }> = {},
  ) =>
    ({
      type: "thread.fork",
      commandId: CommandId.make(overrides.commandId ?? "cmd-fork"),
      forkedThreadId: FORKED_THREAD_ID,
      sourceThreadId: SOURCE_THREAD_ID,
      forkPointMessageId:
        overrides.forkPointMessageId === undefined
          ? ASSISTANT_MESSAGE_ID
          : overrides.forkPointMessageId,
      forkKind: overrides.forkKind ?? "user",
      title: "Login work (fork)",
      createdAt: NOW,
    }) as const;

  it.effect("copies the transcript prefix and records lineage on both threads", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        command: forkCommand(),
        readModel: makeReadModel(),
      });
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.forked",
      ]);

      const [created, firstCopied, secondCopied, forked] = events;
      if (created?.type !== "thread.created") throw new Error("expected thread.created");
      expect(created.payload.threadId).toBe(FORKED_THREAD_ID);
      expect(created.payload.projectId).toBe(ProjectId.make("project-1"));
      expect(created.payload.forkedFromThreadId).toBe(SOURCE_THREAD_ID);
      expect(created.payload.forkPointMessageId).toBe(ASSISTANT_MESSAGE_ID);
      expect(created.payload.forkKind).toBe("user");

      // Copied messages keep their text, timestamps, and turn references so
      // the fork's timeline reads exactly like the source's up to the fork
      // point — but each gets a fresh id, because message ids are globally
      // unique in the projection and reusing them would move the rows off the
      // source thread.
      if (firstCopied?.type !== "thread.message-sent") throw new Error("expected message-sent");
      if (secondCopied?.type !== "thread.message-sent") throw new Error("expected message-sent");
      expect(firstCopied.payload.text).toBe("Add a login form");
      expect(firstCopied.payload.messageId).not.toBe(FIRST_USER_MESSAGE_ID);
      expect(firstCopied.payload.threadId).toBe(FORKED_THREAD_ID);
      expect(firstCopied.payload.turnId).toBe(TurnId.make("turn-1"));
      expect(firstCopied.payload.createdAt).toBe(NOW);
      expect(firstCopied.causationEventId).toBe(created.eventId);
      expect(secondCopied.payload.text).toBe("Done.");
      expect(secondCopied.payload.messageId).not.toBe(ASSISTANT_MESSAGE_ID);
      expect(secondCopied.payload.messageId).not.toBe(firstCopied.payload.messageId);
      expect(secondCopied.causationEventId).toBe(firstCopied.eventId);
      // The message after the fork point stays behind.
      expect(events.some((event) => event.type === "thread.settled")).toBe(false);

      // The marker rides the SOURCE thread so its subscribers see the fork.
      if (forked?.type !== "thread.forked") throw new Error("expected thread.forked");
      expect(forked.aggregateId).toBe(SOURCE_THREAD_ID);
      expect(forked.payload.threadId).toBe(FORKED_THREAD_ID);
      expect(forked.payload.forkKind).toBe("user");
    }),
  );

  it.effect("forks from an empty transcript when there is no fork point", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        command: forkCommand({ forkPointMessageId: null }),
        readModel: makeReadModel(),
      });
      expect(events.map((event) => event.type)).toEqual(["thread.created", "thread.forked"]);
      const [created] = events;
      if (created?.type !== "thread.created") throw new Error("expected thread.created");
      expect(created.payload.forkPointMessageId).toBe(null);
    }),
  );

  it.effect("lands an archive-tail fork settled with the whole transcript", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        command: forkCommand({
          forkPointMessageId: SECOND_USER_MESSAGE_ID,
          forkKind: "archive-tail",
        }),
        readModel: makeReadModel(),
      });
      // An archive is a record of discarded work, not a place to keep working.
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.settled",
        "thread.forked",
      ]);
      const created = events[0];
      if (created?.type !== "thread.created") throw new Error("expected thread.created");
      expect(created.payload.forkKind).toBe("archive-tail");
    }),
  );

  it.effect("rejects a fork point that is not on the source thread", () =>
    Effect.gen(function* () {
      const error = yield* decide({
        command: forkCommand({ forkPointMessageId: MessageId.make("message-elsewhere") }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects forking onto an id that is already a thread", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const collidingReadModel: OrchestrationReadModel = {
        ...readModel,
        threads: [
          ...readModel.threads,
          { ...readModel.threads[0]!, id: FORKED_THREAD_ID, messages: [] },
        ],
      };
      const error = yield* decide({
        command: forkCommand(),
        readModel: collidingReadModel,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
