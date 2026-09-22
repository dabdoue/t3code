import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { type PiAgentSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as TextGeneration from "./TextGeneration.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { assistantTextFromPiMessage } from "../provider/pi/PiRpc.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Last authoritative assistant reply from a `pi --mode json` event stream:
 * the first line is the session header, and every `message_end` carries the
 * final message — the last assistant one is the answer.
 */
export function lastAssistantTextFromPiJsonOutput(output: string): string {
  const lines = output.split("\n");
  let text: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || readString(parsed, "type") !== "message_end") continue;
    const message = parsed.message;
    if (isRecord(message) && readString(message, "role") === "assistant") {
      text = assistantTextFromPiMessage(message);
    }
  }
  return text?.trim() ?? "";
}

export const makePiTextGeneration = (
  piSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
): TextGeneration.TextGeneration["Service"] => {
  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    // pi's own default model is fine for titles, commits, and branch names;
    // the parameter is accepted so every TextGeneration service shares a shape.
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const command = piSettings.binaryPath || "pi";
      // One-shot and ephemeral: no session file, no extension/skill discovery —
      // this runs on every commit and title draft.
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        ["--mode", "json", "--no-session", "--no-extensions", "--no-skills", prompt],
        { env: environment },
      );
      const result = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd,
          env: environment,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.timeoutOption(PI_TEXT_GENERATION_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to run pi for text generation.",
              cause,
            }),
        ),
      );
      if (Option.isNone(result)) {
        return yield* new TextGenerationError({
          operation,
          detail: "pi text generation timed out.",
        });
      }
      const output = result.value;
      if (output.code !== 0) {
        yield* Effect.logWarning("pi text generation exited non-zero.", {
          operation,
          exitCode: output.code,
          stderrLength: output.stderr.length,
        });
      }
      const trimmed = lastAssistantTextFromPiJsonOutput(output.stdout);
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "pi returned empty output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "pi text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
};
