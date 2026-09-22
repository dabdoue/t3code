import {
  McpCapabilityUnavailableError,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Crypto.Crypto,
];

export const DelegateTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The complete, self-contained task for the delegate. It cannot see this conversation; include everything it needs (files, constraints, definition of done).",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Short label for the delegate thread, shown to the user in the sidebar.",
    }),
  ),
  background: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the delegate in the background and return immediately (default false: block until the delegate finishes and report its outcome).",
    }),
  ),
  providerInstanceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider instance to run the delegate on, for example 'claude', 'codex', or 'piAgent'. Defaults to this thread's provider instance.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model slug for the delegate, for example 'llmrtr/GLM-5.3-Flash'. Defaults to this thread's model.",
    }),
  ),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const DelegateTaskResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  /**
   * "started" for background runs. "timeout" means the cap was hit but the
   * delegate is still working; it is never cancelled by this tool returning.
   */
  status: Schema.Literals(["started", "completed", "failed", "interrupted", "timeout"]),
  detail: Schema.NullOr(Schema.String),
});
export type DelegateTaskResult = typeof DelegateTaskResult.Type;

export class DelegateParentThreadNotFoundError extends Schema.TaggedError<DelegateParentThreadNotFoundError>()(
  "DelegateParentThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class DelegateTaskFailedError extends Schema.TaggedError<DelegateTaskFailedError>()(
  "DelegateTaskFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the delegate task.";
  }
}

export const DelegateToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DelegateParentThreadNotFoundError,
  DelegateTaskFailedError,
]);
export type DelegateToolError = typeof DelegateToolError.Type;

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Spawn a new agent thread in this project as a delegate of the current thread and optionally run a task on it. The delegate appears in the sidebar under this thread where the user can watch its transcript. Defaults to blocking until the delegate finishes; pass background=true to return immediately after starting it.",
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: DelegateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task to a new agent thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // A repeat dispatch mints a fresh thread id, so a retry is a second
  // delegate, not a no-op.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const DelegationToolkit = Toolkit.make(DelegateTaskTool);
