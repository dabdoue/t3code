import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId } from "@t3tools/contracts";
import type { ActiveTurnMessageBehavior } from "@t3tools/contracts/settings";

export type WebThreadOutboxSessionStatus =
  | "error"
  | "idle"
  | "interrupted"
  | "ready"
  | "running"
  | "starting"
  | "stopped"
  | null;

export interface WebThreadOutboxDeliveryGate {
  readonly messageId: MessageId;
  readonly phase: "awaiting-start" | "active";
}

export function makeWebThreadOutboxDeliveryGate(
  messageId: MessageId,
  sessionStatus: WebThreadOutboxSessionStatus,
): WebThreadOutboxDeliveryGate {
  return {
    messageId,
    phase:
      sessionStatus === "starting" || sessionStatus === "running" ? "active" : "awaiting-start",
  };
}

/**
 * Keep a per-thread gate from command acceptance until the projected turn has
 * both become active and settled. This closes the ready-state window where a
 * second FIFO head could otherwise dispatch before the first turn is visible.
 */
export function advanceWebThreadOutboxDeliveryGate(
  gate: WebThreadOutboxDeliveryGate,
  sessionStatus: WebThreadOutboxSessionStatus,
): WebThreadOutboxDeliveryGate | null {
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return gate.phase === "active" ? gate : { ...gate, phase: "active" };
  }
  if (gate.phase === "active") return null;
  if (sessionStatus === "error" || sessionStatus === "interrupted" || sessionStatus === "stopped") {
    return null;
  }
  return gate;
}

export function webThreadOutboxDeliveryGateBlocksMessage(
  gate: WebThreadOutboxDeliveryGate | null,
  behavior: ActiveTurnMessageBehavior,
): boolean {
  return gate !== null && behavior === "queue";
}

export function shouldPauseWebThreadOutboxDelivery(
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  return result._tag === "Failure" && !isAtomCommandInterrupted(result);
}
