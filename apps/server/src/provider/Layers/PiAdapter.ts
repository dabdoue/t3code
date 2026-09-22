/**
 * PiAdapterLive — pi (`pi --mode rpc`) via LF-framed NDJSON over stdio.
 *
 * pi is a local harness (often pointed at a vLLM/OpenAI-compatible server), so
 * there is no auth flow and no model discovery the adapter can drive; the
 * snapshot layer owns the probe. The adapter owns one `pi` child per thread and
 * translates pi's command/event flow onto ProviderRuntimeEvents:
 *
 *   - prompt / prompt{steer}  → sendTurn (steer while a run is in flight)
 *   - abort                   → interruptTurn
 *   - text/thinking deltas    → content.delta (assistant_text / reasoning_text)
 *   - tool_execution_*        → item.started / item.updated / item.completed
 *   - message_end usage       → thread.token-usage.updated
 *   - agent_settled           → turn.completed (pi's true idle signal —
 *                               retries, compaction retries, and queued
 *                               continuations all happen before it)
 *   - extension_ui_request    → user-input.requested (dialog methods only)
 *   - compact                 → native compaction
 *
 * @module PiAdapterLive
 */

import {
  ApprovalRequestId,
  EventId,
  type PiAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  appendPiRpcChunk,
  type PiRpcCommand,
  type PiRpcInbound,
  type PiRpcResponse,
  parsePiRpcLine,
  parsePiUsage,
  piModelRefFromSelection,
  piStopReasonToTurnState,
  piToolNameToItemType,
  type PiUsage,
} from "../pi/PiRpc.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("piAgent");
const PI_RESUME_VERSION = 1 as const;
/** prompt/steer/get_state/set_model respond immediately; longer means a stuck pipe. */
const PI_COMMAND_TIMEOUT_MS = 15_000;
/** abort responds once the run is idle; compact responds after compaction finishes. */
const PI_LONG_COMMAND_TIMEOUT_MS = 240_000;
const PI_FORCE_KILL_AFTER = "2 seconds" as const;
/** Bounded tool-output tail forwarded on item updates so the wire stays linear. */
const PI_TOOL_DETAIL_MAX_CHARS = 2_000;
const PI_UI_FIRE_AND_FORGET_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);
const PI_UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function truncateTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function textFromToolContent(content: unknown): string {
  if (!isRecord(content)) return "";
  const blocks = content.content;
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  let text = "";
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function parsePiResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== PI_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

interface PendingPiCommand {
  readonly response: Deferred.Deferred<PiRpcResponse, ProviderAdapterProcessError>;
}

interface PendingPiUiRequest {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  /** pi's own extension_ui_request id — the cancellation reply must carry it. */
  readonly piRequestId: string;
  readonly method: string;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  /** Feeds the child's stdin stream; shutting it down ends stdin (EOF). */
  readonly commandQueue: Queue.Queue<Uint8Array>;
  readonly writeCommand: (
    command: PiRpcCommand,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingCommands: Map<string, PendingPiCommand>;
  readonly pendingUiRequests: Map<ApprovalRequestId, PendingPiUiRequest>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** False between prompt acceptance and agent_settled — a sendTurn then steers. */
  settled: boolean;
  lastStopReason: string | undefined;
  lastUsage: PiUsage | undefined;
  totalUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolOutputSentChars: Map<string, number>;
  stderrTail: string;
  stopped: boolean;
}

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`piAgent`).
   */
  readonly instanceId?: ProviderInstanceId;
}

export function makePiAdapter(piSettings: PiAgentSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options?.nativeEventLogger;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /** Send one command with an auto-generated id and await its response. */
    const sendCommand = (
      ctx: PiSessionContext,
      command: PiRpcCommand,
      timeoutMs: number,
    ): Effect.Effect<PiRpcResponse, ProviderAdapterError> =>
      Effect.flatMap(randomUUIDv4, (correlationId) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<PiRpcResponse, ProviderAdapterProcessError>();
          ctx.pendingCommands.set(correlationId, { response: deferred });
          yield* ctx.writeCommand({ id: correlationId, ...command });
          const settledResponse = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(timeoutMs),
            Effect.ensuring(Effect.sync(() => ctx.pendingCommands.delete(correlationId))),
          );
          if (Option.isNone(settledResponse)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: readString(command, "type") ?? "command",
              detail: "pi did not answer the command in time.",
            });
          }
          return settledResponse.value;
        }),
      );

    /** Fire a command whose response we do not act on; logs instead of failing. */
    const sendCommandForget = (ctx: PiSessionContext, command: PiRpcCommand) =>
      sendCommand(ctx, command, PI_LONG_COMMAND_TIMEOUT_MS).pipe(
        Effect.catch((cause) => Effect.logWarning("pi command failed.", { cause })),
        Effect.asVoid,
        Effect.forkIn(ctx.scope),
      );

    const emitTurnCompleted = (ctx: PiSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        const usage = ctx.lastUsage;
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: piStopReasonToTurnState(ctx.lastStopReason),
            stopReason: ctx.lastStopReason ?? null,
            ...(usage
              ? {
                  tokenUsage: {
                    usageScope: "main_agent" as const,
                    usageStatus: "complete" as const,
                    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
                    outputTokens: usage.output,
                    cachedInputTokens: usage.cacheRead,
                    cacheCreationTokens: usage.cacheWrite,
                    hasSubagents: false,
                  },
                }
              : {}),
          },
        });
      });

    const emitThreadTokenUsage = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const total = ctx.totalUsage;
        const last = ctx.lastUsage;
        const usedTokens = last ? last.input + last.cacheRead + last.cacheWrite : 0;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: {
            usage: {
              usedTokens,
              totalProcessedTokens: total.input + total.output,
              inputTokens: total.input,
              cachedInputTokens: total.cacheRead,
              outputTokens: total.output,
              ...(last
                ? {
                    lastUsedTokens: usedTokens,
                    lastInputTokens: last.input,
                    lastCachedInputTokens: last.cacheRead,
                    lastOutputTokens: last.output,
                  }
                : {}),
              compactsAutomatically: true,
            },
          },
        });
      });

    const itemTypeForTool = (toolName: string) =>
      piToolNameToItemType(toolName) as "command_execution" | "file_change" | "dynamic_tool_call";

    const handlePiEvent = (ctx: PiSessionContext, message: Record<string, unknown>) =>
      Effect.gen(function* () {
        const type = readString(message, "type") ?? "";

        if (type === "agent_start") {
          ctx.settled = false;
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: { state: "running", reason: "pi agent started" },
          });
          return;
        }

        if (type === "agent_settled") {
          ctx.settled = true;
          const turnId = ctx.activeTurnId;
          if (turnId !== undefined) {
            ctx.activeTurnId = undefined;
            yield* emitTurnCompleted(ctx, turnId);
          }
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            payload: { state: "ready", reason: "pi agent settled" },
          });
          return;
        }

        if (type === "message_update") {
          const deltaEvent = message.assistantMessageEvent;
          if (!isRecord(deltaEvent)) return;
          const deltaType = readString(deltaEvent, "type");
          if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return;
          const delta = readString(deltaEvent, "delta") ?? "";
          if (!delta) return;
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
              delta,
            },
            raw: { source: "pi.rpc", method: "message_update", payload: message },
          });
          return;
        }

        if (type === "message_end") {
          const messageBody = message.message;
          if (!isRecord(messageBody) || readString(messageBody, "role") !== "assistant") return;
          const usage = parsePiUsage(messageBody.usage);
          const stopReason = readString(messageBody, "stopReason");
          if (stopReason !== undefined) {
            ctx.lastStopReason = stopReason;
          }
          if (usage) {
            ctx.lastUsage = usage;
            ctx.totalUsage.input += usage.input;
            ctx.totalUsage.output += usage.output;
            ctx.totalUsage.cacheRead += usage.cacheRead;
            ctx.totalUsage.cacheWrite += usage.cacheWrite;
            yield* emitThreadTokenUsage(ctx);
          }
          return;
        }

        if (type === "tool_execution_start") {
          const toolCallId = readString(message, "toolCallId") ?? "";
          if (!toolCallId) return;
          const toolName = readString(message, "toolName") ?? "tool";
          const argsDetail = encodeJsonStringForDiagnostics(message.args);
          ctx.toolOutputSentChars.set(toolCallId, 0);
          yield* offerRuntimeEvent({
            type: "item.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            itemId: RuntimeItemId.make(toolCallId),
            payload: {
              itemType: itemTypeForTool(toolName),
              status: "inProgress",
              title: toolName,
              ...(argsDetail ? { detail: truncateTail(argsDetail, PI_TOOL_DETAIL_MAX_CHARS) } : {}),
              data: {
                toolCallId,
                toolName,
                ...(message.args !== undefined ? { args: message.args } : {}),
              },
            },
            raw: { source: "pi.rpc", method: "tool_execution_start", payload: message },
          });
          return;
        }

        if (type === "tool_execution_update") {
          const toolCallId = readString(message, "toolCallId") ?? "";
          if (!toolCallId) return;
          const output = textFromToolContent(message.partialResult);
          const sentChars = ctx.toolOutputSentChars.get(toolCallId) ?? 0;
          if (!output || output.length <= sentChars) return;
          // pi accumulates output; record the consumed length so each update
          // carries bounded, non-duplicative text.
          ctx.toolOutputSentChars.set(toolCallId, output.length);
          yield* offerRuntimeEvent({
            type: "item.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            itemId: RuntimeItemId.make(toolCallId),
            payload: {
              itemType: itemTypeForTool(readString(message, "toolName") ?? ""),
              status: "inProgress",
              detail: truncateTail(output, PI_TOOL_DETAIL_MAX_CHARS),
            },
            raw: { source: "pi.rpc", method: "tool_execution_update", payload: message },
          });
          return;
        }

        if (type === "tool_execution_end") {
          const toolCallId = readString(message, "toolCallId") ?? "";
          if (!toolCallId) return;
          const output = textFromToolContent(message.result);
          ctx.toolOutputSentChars.delete(toolCallId);
          yield* offerRuntimeEvent({
            type: "item.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            itemId: RuntimeItemId.make(toolCallId),
            payload: {
              itemType: itemTypeForTool(readString(message, "toolName") ?? ""),
              status: message.isError === true ? "failed" : "completed",
              ...(output ? { detail: truncateTail(output, PI_TOOL_DETAIL_MAX_CHARS) } : {}),
            },
            raw: { source: "pi.rpc", method: "tool_execution_end", payload: message },
          });
          return;
        }

        if (type === "compaction_start") {
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            payload: { state: "waiting", reason: "pi compacting" },
          });
          return;
        }

        if (type === "compaction_end") {
          const result = isRecord(message.result) ? message.result : undefined;
          const tokensBefore = result?.["tokensBefore"];
          const tokensAfter = result?.["estimatedTokensAfter"];
          yield* offerRuntimeEvent({
            type: "thread.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            payload: {
              state: "compacted",
              ...(typeof tokensBefore === "number" ? { beforeTokens: tokensBefore } : {}),
              ...(typeof tokensAfter === "number" ? { afterTokens: tokensAfter } : {}),
              detail: message,
            },
            raw: { source: "pi.rpc", method: "compaction_end", payload: message },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            payload: {
              state: ctx.settled ? "ready" : "running",
              reason: "pi compaction ended",
            },
          });
          return;
        }
      });

    const dispatchInbound = (ctx: PiSessionContext, inbound: PiRpcInbound | undefined) =>
      Effect.gen(function* () {
        if (inbound === undefined) return;
        if (inbound.kind === "response") {
          if (inbound.id !== undefined) {
            const pending = ctx.pendingCommands.get(inbound.id);
            if (pending) {
              yield* Deferred.succeed(pending.response, inbound).pipe(Effect.ignore);
            }
          }
          return;
        }
        if (inbound.kind === "extension_ui_request") {
          yield* logNative(ctx.threadId, `extension_ui/${inbound.method}`, inbound.message);
          if (
            PI_UI_FIRE_AND_FORGET_METHODS.has(inbound.method) ||
            !PI_UI_DIALOG_METHODS.has(inbound.method)
          ) {
            return;
          }
          const requestId = ApprovalRequestId.make(inbound.id);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const answers = yield* Deferred.make<ProviderUserInputAnswers>();
          ctx.pendingUiRequests.set(requestId, {
            answers,
            piRequestId: inbound.id,
            method: inbound.method,
          });
          const title = readString(inbound.message, "title") ?? "pi needs your input";
          const options =
            inbound.method === "select" && Array.isArray(inbound.message.options)
              ? inbound.message.options.flatMap((entry) =>
                  typeof entry === "string" && entry.trim()
                    ? [{ label: entry, description: "", value: entry }]
                    : [],
                )
              : inbound.method === "confirm"
                ? [
                    { label: "Yes", description: "", value: "yes" },
                    { label: "No", description: "", value: "no" },
                  ]
                : [];
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: {
              questions: [
                {
                  id: requestId,
                  header: inbound.method,
                  question: title,
                  options,
                  ...(inbound.method === "input" || inbound.method === "editor"
                    ? { allowCustomAnswer: true }
                    : {}),
                },
              ],
            },
            raw: {
              source: "pi.rpc",
              method: `extension_ui_request/${inbound.method}`,
              payload: inbound.message,
            },
          });
          return;
        }
        if (inbound.kind === "event") {
          yield* logNative(ctx.threadId, inbound.type, inbound.message);
          yield* handlePiEvent(ctx, inbound.message);
        }
      });

    /** Cancel every pending pi dialog and write back the cancelled reply pi expects. */
    const cancelPendingUiRequests = (ctx: PiSessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingUiRequests.values()),
        (request) =>
          Effect.gen(function* () {
            ctx.pendingUiRequests.delete(ApprovalRequestId.make(request.piRequestId));
            yield* ctx
              .writeCommand({
                type: "extension_ui_response",
                id: request.piRequestId,
                cancelled: true,
              })
              .pipe(Effect.ignore);
            yield* Deferred.succeed(request.answers, {}).pipe(Effect.ignore);
          }),
        { discard: true },
      );

    const failPendingCommands = (ctx: PiSessionContext, detail: string) =>
      Effect.forEach(
        Array.from(ctx.pendingCommands.values()),
        (pending) =>
          Deferred.fail(
            pending.response,
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              detail,
            }),
          ).pipe(Effect.ignore),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => ctx.pendingCommands.clear())));

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        // Ends the stdin stream, so pi sees EOF even if the kill lags.
        yield* Queue.shutdown(ctx.commandQueue).pipe(Effect.ignore);
        yield* cancelPendingUiRequests(ctx);
        yield* failPendingCommands(ctx, "pi session was stopped.");
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const makeSessionArgs = (input: {
      readonly resumeSessionId: string | undefined;
      readonly modelPattern: string | undefined;
    }): ReadonlyArray<string> => {
      const args = ["--mode", "rpc"];
      if (input.resumeSessionId) {
        args.push("--session", input.resumeSessionId);
      }
      if (input.modelPattern) {
        args.push("--model", input.modelPattern);
      }
      const launchArgs = piSettings.launchArgs.trim();
      if (launchArgs) {
        args.push(...launchArgs.split(/\s+/).filter(Boolean));
      }
      return args;
    };

    const applyModelSelection = (
      ctx: PiSessionContext,
      modelSelection: ProviderSendTurnInput["modelSelection"],
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (!modelSelection || modelSelection.model === "pi-default") return;
        const modelRef = piModelRefFromSelection(modelSelection.model);
        if (!modelRef) {
          yield* Effect.logWarning(
            "pi model selection must look like 'provider/model'; keeping the session model.",
            { model: modelSelection.model },
          );
          return;
        }
        yield* sendCommand(
          ctx,
          { type: "set_model", provider: modelRef.provider, modelId: modelRef.modelId },
          PI_COMMAND_TIMEOUT_MS,
        ).pipe(Effect.ignore);
        const effort = modelSelection.options?.find((option) => option.id === "reasoningEffort");
        if (effort && typeof effort.value === "string" && effort.value.trim()) {
          yield* sendCommand(
            ctx,
            { type: "set_thinking_level", level: effort.value.trim() },
            PI_COMMAND_TIMEOUT_MS,
          ).pipe(Effect.ignore);
        }
      });

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resumeSessionId = parsePiResume(input.resumeCursor)?.sessionId;
          const modelPattern =
            modelSelection?.model && modelSelection.model !== "pi-default"
              ? modelSelection.model
              : undefined;

          const env = options?.environment;
          const extendEnv = env === undefined;
          const spawnCommand = yield* resolveSpawnCommand(
            piSettings.binaryPath || "pi",
            makeSessionArgs({ resumeSessionId, modelPattern }),
            env === undefined ? {} : { env, extendEnv },
          );

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          // Stdin is a queue-backed stream wired at spawn: pi is a long-lived
          // rpc peer, and a per-write Stream.run would end the child's stdin
          // after the first command (the write sink closes on completion).
          const commandQueue = yield* Queue.unbounded<Uint8Array>();
          const child = yield* childProcessSpawner
            .spawn(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd,
                env: { ...env },
                extendEnv,
                forceKillAfter: PI_FORCE_KILL_AFTER,
                shell: spawnCommand.shell,
                stdin: Stream.fromQueue(commandQueue),
              }),
            )
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to spawn pi: ${cause.message ?? String(cause)}`,
                    cause,
                  }),
              ),
            );

          const writeCommand = (
            command: PiRpcCommand,
          ): Effect.Effect<void, ProviderAdapterRequestError> =>
            Queue.offer(
              commandQueue,
              new TextEncoder().encode(`${JSON.stringify(command)}\n`),
            ).pipe(
              Effect.flatMap((offered) =>
                offered
                  ? Effect.void
                  : Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: readString(command, "type") ?? "stdin/write",
                        detail: "The pi process stdin is closed.",
                      }),
                    ),
              ),
            );

          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "connecting",
              runtimeMode: input.runtimeMode,
              cwd,
              threadId: input.threadId,
              createdAt: yield* nowIso,
              updatedAt: yield* nowIso,
            },
            scope: sessionScope,
            commandQueue,
            writeCommand,
            notificationFiber: undefined,
            pendingCommands: new Map(),
            pendingUiRequests: new Map(),
            turns: [],
            activeTurnId: undefined,
            settled: true,
            lastStopReason: undefined,
            lastUsage: undefined,
            totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            toolOutputSentChars: new Map(),
            stderrTail: "",
            stopped: false,
          };

          // Process crash: fail everything in flight, surface a runtime error,
          // and mark the session exited. A graceful stop flips `stopped` first.
          yield* child.exitCode.pipe(
            Effect.flatMap((exitCode) =>
              Effect.gen(function* () {
                if (ctx.stopped) return;
                yield* cancelPendingUiRequests(ctx);
                yield* failPendingCommands(ctx, `pi exited with code ${Number(exitCode)}.`);
                const detail = ctx.stderrTail.trim();
                yield* offerRuntimeEvent({
                  type: "runtime.error",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: ctx.threadId,
                  payload: {
                    message: `pi exited unexpectedly (code ${Number(exitCode)}).`,
                    class: "transport_error",
                    ...(detail ? { detail: truncateTail(detail, PI_TOOL_DETAIL_MAX_CHARS) } : {}),
                  },
                });
                yield* offerRuntimeEvent({
                  type: "session.exited",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: ctx.threadId,
                  payload: {
                    exitKind: "error",
                    reason: `pi exited with code ${Number(exitCode)}`,
                  },
                });
              }),
            ),
            Effect.catch((cause) => Effect.logError("Failed to observe pi exit.", { cause })),
            Effect.forkIn(sessionScope),
          );

          // Strict LF framing with the buffer held across chunks: pi records
          // split on "\n" only, and generic line splitters also split on
          // U+2028/U+2029 — valid inside JSON strings.
          const lineBufferRef = yield* Ref.make("");
          const pumpFiber = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Ref.modify(lineBufferRef, (buffer) => {
                const parsed = appendPiRpcChunk(buffer, chunk);
                return [parsed.lines, parsed.buffer] as const;
              }).pipe(
                Effect.flatMap((lines) =>
                  Effect.forEach(lines, (line) => dispatchInbound(ctx, parsePiRpcLine(line)), {
                    discard: true,
                  }),
                ),
              ),
            ),
            Effect.catch((cause) => Effect.logError("Failed to process pi rpc output.", { cause })),
            Effect.forkIn(sessionScope),
          );
          ctx.notificationFiber = pumpFiber;

          yield* child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                ctx.stderrTail = truncateTail(
                  `${ctx.stderrTail}${chunk}`,
                  PI_TOOL_DETAIL_MAX_CHARS,
                );
              }),
            ),
            Effect.ignore,
            Effect.forkIn(sessionScope),
          );

          const stateResponse = yield* sendCommand(
            ctx,
            { type: "get_state" },
            PI_COMMAND_TIMEOUT_MS,
          );
          if (!stateResponse.success || !isRecord(stateResponse.data)) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: stateResponse.error ?? "pi did not report session state after starting.",
            });
          }
          const piSessionId = readString(stateResponse.data, "sessionId") ?? "";
          const piSessionFile = readString(stateResponse.data, "sessionFile");

          yield* applyModelSelection(ctx, modelSelection);
          yield* sendCommand(
            ctx,
            { type: "set_session_name", name: input.threadId },
            PI_COMMAND_TIMEOUT_MS,
          ).pipe(Effect.ignore);

          const now = yield* nowIso;
          ctx.session = {
            ...ctx.session,
            status: "ready",
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(piSessionId
              ? {
                  resumeCursor: {
                    schemaVersion: PI_RESUME_VERSION,
                    sessionId: piSessionId,
                    ...(piSessionFile ? { sessionFile: piSessionFile } : {}),
                  },
                }
              : {}),
            updatedAt: now,
          };

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "pi rpc session ready" },
          });
          if (piSessionId) {
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: { providerThreadId: piSessionId },
            });
          }

          return ctx.session;
        }).pipe(Effect.scoped),
      );

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const rawPrompt = input.input?.trim() ?? "";
        if (!rawPrompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "pi turns require non-empty text.",
          });
        }

        const activeTurnId = ctx.activeTurnId;
        const steering = !ctx.settled && activeTurnId !== undefined;
        const turnId: TurnId = steering ? activeTurnId : TurnId.make(yield* randomUUIDv4);
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

        if (!steering) {
          ctx.lastStopReason = undefined;
          ctx.lastUsage = undefined;
          ctx.activeTurnId = turnId;
          // Optimistically mark the run in flight: the command is accepted
          // before pi emits agent_start, and a second sendTurn in that window
          // must steer instead of racing a fresh prompt.
          ctx.settled = false;
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { model: modelSelection?.model ?? ctx.session.model },
          });
        }

        // Slash commands pass through untouched; plain prompts get the shared
        // runtime context so the pi agent answers PR-linking questions right.
        const instructions = buildRuntimeInstructions({
          harness: "pi",
          model: modelSelection?.model ?? ctx.session.model,
        });
        const message = /^\/[^\s/]+(?:\s|$)/.test(rawPrompt)
          ? rawPrompt
          : `${rawPrompt}\n\n${instructions}`;

        const command: PiRpcCommand & {
          images?: Array<{ type: "image"; data: string; mimeType: string }>;
        } = steering
          ? { type: "prompt", message, streamingBehavior: "steer" }
          : { type: "prompt", message };

        for (const attachment of input.attachments ?? []) {
          // pi ingests images only; generic files reach the agent through the
          // path line the orchestration layer appends to the prompt.
          if (attachment.type !== "image") continue;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: "Failed to read attachment.",
                  cause,
                }),
            ),
          );
          command.images = [
            ...(command.images ?? []),
            {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            },
          ];
        }

        const response = yield* sendCommand(ctx, command, PI_COMMAND_TIMEOUT_MS);
        if (!response.success) {
          // Rejected before acceptance — surface it and undo the optimistic
          // in-flight mark so the next sendTurn is a fresh prompt, not a steer.
          yield* offerRuntimeEvent({
            type: "runtime.error",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: {
              message: response.error ?? "pi rejected the prompt.",
              class: "provider_error",
            },
          });
          if (!steering) {
            ctx.settled = true;
            ctx.activeTurnId = undefined;
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: response.error ?? "pi rejected the prompt.",
          });
        }

        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        };
        const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
        if (turnRecord) {
          turnRecord.items.push({ prompt: message });
        } else {
          ctx.turns.push({ id: turnId, items: [{ prompt: message }] });
        }

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn = (
      threadId: ThreadId,
      _turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Cancel pending dialogs first so pi unblocks and can process the abort.
        yield* cancelPendingUiRequests(ctx);
        // `abort` responds only once the run is idle, but turn completion rides
        // the agent_settled event path — never gate the interrupt on it.
        yield* sendCommand(ctx, { type: "abort" }, PI_LONG_COMMAND_TIMEOUT_MS).pipe(
          Effect.catch((cause) => Effect.logWarning("pi abort command failed.", { cause })),
          Effect.asVoid,
          Effect.forkIn(ctx.scope),
        );
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUiRequests.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending pi dialog: ${requestId}`,
          });
        }
        ctx.pendingUiRequests.delete(requestId);
        const answer = answers[requestId];
        const response: PiRpcCommand =
          pending.method === "confirm"
            ? {
                type: "extension_ui_response",
                id: pending.piRequestId,
                confirmed: answer === "yes" || answer === true,
              }
            : typeof answer === "string" && answer.trim()
              ? { type: "extension_ui_response", id: pending.piRequestId, value: answer }
              : { type: "extension_ui_response", id: pending.piRequestId, cancelled: true };
        yield* ctx.writeCommand(response);
        yield* Deferred.succeed(pending.answers, answers).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<
      { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> },
      ProviderAdapterError
    > =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to stop pi sessions on shutdown.", { cause }),
        ),
        Effect.andThen(Effect.ignore(PubSub.shutdown(runtimeEventPubSub))),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      compaction: {
        type: "native",
        start: (threadId) =>
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* sendCommandForget(ctx, { type: "compact" });
          }),
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread: (threadId: ThreadId, _numTurns: number) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: "pi sessions do not support provider-side rollback.",
          });
        }),
      respondToRequest: (
        threadId: ThreadId,
        requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `pi has no approval protocol (request ${requestId}).`,
          });
        }),
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId: ThreadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      stopAll: () =>
        Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
          discard: true,
        }).pipe(Effect.asVoid),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
