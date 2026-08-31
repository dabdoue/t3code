/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

/**
 * Cursor ACP `cursor/task` payload. Subagent lifecycle over ACP is this
 * extension, not a nested ACP session. `subagentType` stays on `role` — never
 * `taskType` — because Cursor's "shell" subagent is still an agent, while the
 * shared `taskType: "shell"` denylist means background bash.
 * @see https://cursor.com/docs/cli/acp#cursortask
 */
export const CursorSubagentType = Schema.Union([
  Schema.String,
  Schema.Struct({
    custom: Schema.String,
  }),
]);

export const CursorTaskRequest = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  subagentType: Schema.optional(CursorSubagentType),
  model: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
});

function trimmedNonEmpty(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

export function cursorTaskTitle(params: typeof CursorTaskRequest.Type): string {
  return trimmedNonEmpty(params.description) ?? trimmedNonEmpty(params.prompt) ?? "Subagent";
}

export function cursorTaskRole(
  subagentType: (typeof CursorTaskRequest.Type)["subagentType"],
): string | undefined {
  if (subagentType === undefined) {
    return undefined;
  }
  if (typeof subagentType === "string") {
    const role = trimmedNonEmpty(subagentType);
    return role === "unspecified" ? undefined : role;
  }
  return trimmedNonEmpty(subagentType.custom);
}

/** Child identity for the Agents roster. `toolCallId` is on every
 * `cursor/task` payload; Cursor's resume `agentId` often appears only at
 * completion, so using it as `taskId` would split one subagent into two. */
export function cursorTaskId(params: typeof CursorTaskRequest.Type): string | undefined {
  return trimmedNonEmpty(params.toolCallId) ?? trimmedNonEmpty(params.agentId);
}

export function cursorTaskDurationMs(params: typeof CursorTaskRequest.Type): number | undefined {
  const durationMs = params.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return Math.round(durationMs);
}

const CursorAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  configOptions: Schema.optional(Schema.Array(AcpSchema.SessionConfigOption)),
});

export const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(CursorAvailableModel),
});

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    // Fall back to the title when content is missing OR blank. `??` only
    // covers a missing content, so a present-but-empty content ("" or
    // whitespace) would shadow a real title and drop the step below.
    const step = todo.content?.trim() || todo.title?.trim() || "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
