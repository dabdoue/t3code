import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceWebThreadOutboxDeliveryGate,
  makeWebThreadOutboxDeliveryGate,
  shouldPauseWebThreadOutboxDelivery,
  webThreadOutboxDeliveryGateBlocksMessage,
} from "./WebThreadOutboxDrain.logic";

describe("shouldPauseWebThreadOutboxDelivery", () => {
  it("defers interrupted commands so reconnect can retry them", () => {
    expect(shouldPauseWebThreadOutboxDelivery(AsyncResult.failure(Cause.interrupt(1)))).toBe(false);
  });

  it("pauses definitive command failures", () => {
    expect(
      shouldPauseWebThreadOutboxDelivery(
        AsyncResult.failure(Cause.fail(new Error("provider rejected the turn"))),
      ),
    ).toBe(true);
  });

  it("does not pause successful commands", () => {
    expect(shouldPauseWebThreadOutboxDelivery(AsyncResult.success(undefined))).toBe(false);
  });
});

describe("web thread outbox delivery gate", () => {
  const messageId = MessageId.make("message-first-queued-turn");

  it("holds the next FIFO head until the accepted turn starts and settles", () => {
    const accepted = makeWebThreadOutboxDeliveryGate(messageId, "ready");
    expect(accepted.phase).toBe("awaiting-start");
    expect(advanceWebThreadOutboxDeliveryGate(accepted, "ready")).toEqual(accepted);

    const running = advanceWebThreadOutboxDeliveryGate(accepted, "running");
    expect(running).toEqual({ messageId, phase: "active" });
    expect(advanceWebThreadOutboxDeliveryGate(running!, "ready")).toBeNull();
  });

  it("releases an unadopted gate after a terminal provider status", () => {
    const accepted = makeWebThreadOutboxDeliveryGate(messageId, "idle");
    for (const status of ["error", "interrupted", "stopped"] as const) {
      expect(advanceWebThreadOutboxDeliveryGate(accepted, status)).toBeNull();
    }
  });

  it("blocks automatic queue draining while still allowing explicit steer", () => {
    const gate = makeWebThreadOutboxDeliveryGate(messageId, "running");
    expect(webThreadOutboxDeliveryGateBlocksMessage(gate, "queue")).toBe(true);
    expect(webThreadOutboxDeliveryGateBlocksMessage(gate, "steer")).toBe(false);
  });
});
