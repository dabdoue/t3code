/**
 * Stale blocking requests — the single vocabulary for clearing open
 * approval / user-input requests whose provider callback state is gone.
 *
 * An open request is "blocked-on-you" work: it gates the composer, and the
 * decider refuses to settle or snooze the thread while one is outstanding.
 * Provider callback state does not survive app restarts or session death, so
 * a request whose session is gone can never be answered — it must be cleared
 * by appending a `provider.*.respond.failed` activity whose detail carries
 * the stale marker below. Every consumer of that marker — the decider's
 * `hasOpenBlockingRequest`, ProjectionPipeline's pending accounting, and the
 * client's activity fold — matches on these exact substrings, so the
 * matchers and the detail builders must live together and stay in lockstep.
 */
import type { OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";

export function staleApprovalRequestDetail(requestId: string): string {
  return `Stale pending approval request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function staleUserInputRequestDetail(requestId: string): string {
  return `Stale pending user-input request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function isStaleApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) return false;
  const lowered = detail.toLowerCase();
  return (
    lowered.includes("stale pending approval request") ||
    lowered.includes("unknown pending approval request") ||
    lowered.includes("unknown pending permission request") ||
    lowered.includes("unknown pending codex approval request")
  );
}

export function isStaleUserInputFailureDetail(detail: string | null): boolean {
  if (detail === null) return false;
  const lowered = detail.toLowerCase();
  return (
    lowered.includes("stale pending user-input request") ||
    lowered.includes("unknown pending user-input request") ||
    lowered.includes("unknown pending user input request") ||
    lowered.includes("unknown pending codex user input request")
  );
}

export interface OpenBlockingRequests {
  readonly approvalRequestIds: ReadonlyArray<string>;
  readonly userInputRequestIds: ReadonlyArray<string>;
}

/**
 * Scan a thread's activities for approval / user-input requests that are
 * still open: requested, with no later resolution for the same requestId.
 * Ordering follows createdAt then activity id, mirroring the projection
 * pipeline's pending accounting — call sites that receive append-ordered
 * activities get the same answer.
 */
export function collectOpenBlockingRequests(
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "id" | "createdAt" | "kind" | "payload">
  >,
): OpenBlockingRequests {
  const approvals = new Set<string>();
  const userInputs = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  for (const activity of ordered) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    const detail = typeof payload?.detail === "string" ? payload.detail : null;

    if (activity.kind === "approval.requested") {
      approvals.add(requestId);
    } else if (activity.kind === "approval.resolved") {
      approvals.delete(requestId);
    } else if (activity.kind === "user-input.requested") {
      userInputs.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      userInputs.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" &&
      isStaleApprovalFailureDetail(detail)
    ) {
      approvals.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStaleUserInputFailureDetail(detail)
    ) {
      userInputs.delete(requestId);
    }
  }

  return { approvalRequestIds: [...approvals], userInputRequestIds: [...userInputs] };
}

export interface StaleRequestClearingActivity {
  readonly threadId: ThreadId;
  readonly kind: "provider.approval.respond.failed" | "provider.user-input.respond.failed";
  readonly summary: string;
  readonly detail: string;
  readonly requestId: string;
}

/**
 * One clearing body per open request. Callers stamp ids and timestamps and
 * dispatch it as a `thread.activity.append`, so this stays a pure builder.
 */
export function buildStaleRequestClearingBodies(
  threadId: ThreadId,
  requests: OpenBlockingRequests,
): ReadonlyArray<StaleRequestClearingActivity> {
  return [
    ...requests.approvalRequestIds.map((requestId) => ({
      threadId,
      kind: "provider.approval.respond.failed" as const,
      summary: "Stale approval request cleared",
      detail: staleApprovalRequestDetail(requestId),
      requestId,
    })),
    ...requests.userInputRequestIds.map((requestId) => ({
      threadId,
      kind: "provider.user-input.respond.failed" as const,
      summary: "Stale user-input request cleared",
      detail: staleUserInputRequestDetail(requestId),
      requestId,
    })),
  ];
}
