import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { PiAgentSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import { lastAssistantTextFromPiJsonOutput, makePiTextGeneration } from "./PiTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);

const PI_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("piAgent"),
  "pi-default",
);

describe("lastAssistantTextFromPiJsonOutput", () => {
  it("returns the last assistant message_end text", () => {
    const output = [
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"title":"First"}' }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"title":"Second"}' }],
        },
      }),
    ].join("\n");
    expect(lastAssistantTextFromPiJsonOutput(output)).toBe('{"title":"Second"}');
  });

  it("ignores malformed lines and returns empty text when no assistant reply exists", () => {
    expect(lastAssistantTextFromPiJsonOutput("")).toBe("");
    expect(lastAssistantTextFromPiJsonOutput("{broken\n")).toBe("");
    expect(
      lastAssistantTextFromPiJsonOutput(
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
      ),
    ).toBe("");
  });
});

// The fake pi asserts the exact one-shot invocation the service must use —
// JSON mode, ephemeral, no extension or skill discovery — then prints the
// session header and a single assistant `message_end`, the same two record
// kinds a real run produces around the answer.
const writeFakePi = (input: { readonly text: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-text-generation-" });
    const requiredFlags = ["--mode", "json", "--no-session", "--no-extensions", "--no-skills"];
    return writeFakeCli({
      directory: dir,
      name: "pi",
      env: { FAKE_PI_TEXT: input.text },
      source: [
        "const args = process.argv.slice(2);",
        // @effect-diagnostics-next-line preferSchemaOverJson:off - serializing a flag list into generated stub source.
        `const requiredFlags = ${JSON.stringify(requiredFlags)};`,
        "for (const flag of requiredFlags) {",
        "  if (!args.includes(flag)) {",
        '    process.stderr.write("missing " + flag);',
        "    process.exit(9);",
        "  }",
        "}",
        // The prompt is the final argument; a commit-message run names its task.
        "const prompt = args[args.length - 1] ?? '';",
        'if (!prompt.includes("commit messages")) {',
        '  process.stderr.write("unexpected prompt");',
        "  process.exit(8);",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: 's1' }) + '\\n');",
        'process.stdout.write(JSON.stringify({ type: "message_end", message: {',
        '  role: "assistant",',
        '  content: [{ type: "text", text: process.env.FAKE_PI_TEXT ?? "" }],',
        "}}) + '\\n');",
        "",
      ].join("\n"),
    });
  });

it.layer(NodeServices.layer)("makePiTextGeneration", (it) => {
  it.effect("decodes a structured commit message from the pi json stream", () =>
    Effect.gen(function* () {
      const piPath = yield* writeFakePi({
        // @effect-diagnostics-next-line preferSchemaOverJson:off - the fake model reply is a JSON string by definition.
        text: JSON.stringify({ subject: "fix: keep rpc lines whole", body: "- guard the buffer" }),
      });
      const textGeneration = makePiTextGeneration(
        decodePiSettings({ binaryPath: piPath }),
        process.env,
      );

      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M apps/server/src/provider/pi/PiRpc.ts",
        stagedPatch: "",
        modelSelection: PI_TEST_MODEL_SELECTION,
      });

      expect(result.subject).toBe("fix: keep rpc lines whole");
      expect(result.body).toBe("- guard the buffer");
    }),
  );

  it.effect("fails with a TextGenerationError when the reply is not valid JSON", () =>
    Effect.gen(function* () {
      const piPath = yield* writeFakePi({ text: "not json at all" });
      const textGeneration = makePiTextGeneration(
        decodePiSettings({ binaryPath: piPath }),
        process.env,
      );

      const result = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "M apps/server/src/provider/pi/PiRpc.ts",
          stagedPatch: "",
          modelSelection: PI_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");

      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(TextGenerationError);
        expect(result.failure.detail).toContain("structured output");
      }
    }),
  );
});
