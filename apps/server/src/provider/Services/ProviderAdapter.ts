/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * Declares how a provider can fork an existing conversation:
 *
 * - `turn-granular`: the fork can slice at an arbitrary completed turn
 *   (Codex `thread/fork` with `lastTurnId`, Claude SDK `forkSession` with
 *   `upToMessageId`).
 * - `full-copy`: the fork always duplicates the entire conversation; the
 *   edited message must be re-sent as a correction (ACP `session/fork`).
 * - `none`: provider context cannot be forked; only correction-style edits
 *   that keep the existing context remain available.
 */
export type ProviderSessionForkMode = "turn-granular" | "full-copy" | "none";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Declares how this provider can fork a conversation for message edits.
   */
  readonly sessionFork: ProviderSessionForkMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderThreadForkInput {
  /**
   * Canonical turn id of the last completed turn to include in the fork.
   * Omit for a full copy. Ignored by full-copy providers.
   */
  readonly upToTurnId?: TurnId;
  /**
   * Working directory for the forked provider session (e.g. a git worktree).
   */
  readonly cwd?: string;
  readonly title?: string;
}

export interface ProviderThreadForkResult {
  /**
   * Opaque resume cursor identifying the forked provider conversation. Feed
   * to `startSession` for the forked thread so its first turn continues the
   * forked context. Absent when the provider needs no resume state.
   */
  readonly resumeCursor?: unknown;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Fork a provider thread into a new provider conversation.
   *
   * The source session is left untouched; the returned resume cursor belongs
   * to the fork. Adapters whose `capabilities.sessionFork === "none"` fail
   * with a validation error.
   */
  readonly forkThread: (
    threadId: ThreadId,
    input: ProviderThreadForkInput,
  ) => Effect.Effect<ProviderThreadForkResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
