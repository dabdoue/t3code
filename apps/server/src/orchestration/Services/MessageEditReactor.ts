/**
 * MessageEditReactor - Message-edit reaction service interface.
 *
 * Owns the background worker that reacts to message-edit requests and carries
 * out the chosen resolution (fork / rewind / continue), including provider
 * conversation forking, worktree creation at the edit-point checkpoint, and
 * auto-sending the edited message.
 *
 * @module MessageEditReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * MessageEditReactorShape - Service API for message-edit reactor lifecycle.
 */
export interface MessageEditReactorShape {
  /**
   * Start the message-edit reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Consumes orchestration-domain events via an internal queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * MessageEditReactor - service tag for the message-edit reactor worker.
 */
export class MessageEditReactor extends Context.Service<
  MessageEditReactor,
  MessageEditReactorShape
>()("t3/orchestration/Services/MessageEditReactor") {}
