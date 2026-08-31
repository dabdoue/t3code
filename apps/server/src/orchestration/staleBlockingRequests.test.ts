import { assert, describe, it } from "@effect/vitest";
import { EventId } from "@t3tools/contracts";

import {
  collectOpenBlockingRequests,
  isStaleApprovalFailureDetail,
  isStaleUserInputFailureDetail,
  staleApprovalRequestDetail,
  staleUserInputRequestDetail,
} from "./staleBlockingRequests.ts";

interface ActivityLike {
  readonly id: EventId;
  readonly createdAt: string;
  readonly kind: string;
  readonly payload: unknown;
}

const activity = (
  id: string,
  kind: string,
  payload: unknown,
  createdAt = `2026-01-01T00:00:0${id.slice(-1)}:00.000Z`,
): ActivityLike => ({
  id: EventId.make(id),
  createdAt,
  kind,
  payload,
});

describe("staleBlockingRequests", () => {
  it("produces detail text that its own matchers recognize", () => {
    assert.isTrue(isStaleApprovalFailureDetail(staleApprovalRequestDetail("req-1")));
    assert.isTrue(isStaleUserInputFailureDetail(staleUserInputRequestDetail("req-2")));
    assert.isTrue(isStaleApprovalFailureDetail("Unknown pending permission request: req-3"));
    assert.isTrue(isStaleUserInputFailureDetail("unknown pending codex user input request: x"));
    assert.isFalse(isStaleApprovalFailureDetail("No active provider session is bound."));
    assert.isFalse(isStaleApprovalFailureDetail(null));
  });

  it("collects requests that are open and drops resolved or already-cleared ones", () => {
    const requests = collectOpenBlockingRequests([
      activity("1", "approval.requested", { requestId: "approval-open" }),
      activity("2", "user-input.requested", { requestId: "input-open" }),
      activity("3", "approval.requested", { requestId: "approval-resolved" }),
      activity("4", "approval.resolved", { requestId: "approval-resolved" }),
      activity("5", "approval.requested", { requestId: "approval-cleared" }),
      activity("6", "provider.approval.respond.failed", {
        requestId: "approval-cleared",
        detail: staleApprovalRequestDetail("approval-cleared"),
      }),
      activity("7", "provider.approval.respond.failed", {
        requestId: "approval-open",
        detail: "Provider exploded for an unrelated reason",
      }),
      activity("8", "approval.requested", { requestId: "no-payload-request" }),
    ]);

    assert.deepStrictEqual(requests, {
      approvalRequestIds: ["approval-open", "no-payload-request"],
      userInputRequestIds: ["input-open"],
    });
  });

  it("orders by createdAt then id so out-of-order inputs still resolve", () => {
    const requests = collectOpenBlockingRequests([
      activity("b", "approval.resolved", { requestId: "late" }, "2026-01-01T00:00:02.000Z"),
      activity("a", "approval.requested", { requestId: "late" }, "2026-01-01T00:00:01.000Z"),
    ]);
    assert.deepStrictEqual(requests, { approvalRequestIds: [], userInputRequestIds: [] });
  });
});
